import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize, encodeEnvelope, toBase64Url } from '../src/crypto.mjs';
import { createCheckoutSession, processStripeWebhook } from './lib.mjs';
import { FileLedger } from './file-ledger.mjs';

const encoder = new TextEncoder();

function required(name, env = process.env) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function stripeForm(payload) {
  const form = new URLSearchParams();
  const append = (prefix, value) => {
    if (Array.isArray(value)) value.forEach((item, index) => append(`${prefix}[${index}]`, item));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => append(`${prefix}[${key}]`, item));
    else form.append(prefix, String(value));
  };
  Object.entries(payload).forEach(([key, value]) => append(key, value));
  return form;
}

export function createStripeRestAdapter(secretKey, fetchImpl = fetch) {
  const request = async (url, options = {}) => {
    const response = await fetchImpl(`https://api.stripe.com/v1${url}`, { ...options, headers: { Authorization: `Bearer ${secretKey}`, ...(options.headers || {}) } });
    const data = await response.json();
    if (!response.ok) throw new Error(`Stripe API request failed: ${data?.error?.message || response.status}`);
    return data;
  };
  return {
    createCheckout: (payload, idempotencyKey) => request('/checkout/sessions', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': idempotencyKey }, body: stripeForm(payload) }),
    retrieveCheckout: (sessionId) => {
      if (!/^cs_(?:test|live)_[A-Za-z0-9_]+$/.test(sessionId)) throw new Error('Checkout Session ID is malformed.');
      return request(`/checkout/sessions/${encodeURIComponent(sessionId)}?expand%5B%5D=line_items`);
    },
  };
}

export async function createLicenseSigner(env = process.env) {
  let privateJwk;
  if (env.PERMITKEEP_LICENSE_PRIVATE_JWK) privateJwk = JSON.parse(env.PERMITKEEP_LICENSE_PRIVATE_JWK);
  else privateJwk = JSON.parse(await fs.readFile(required('PERMITKEEP_LICENSE_PRIVATE_KEY', env), 'utf8'));
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return async ({ licenseId, orderRef }) => {
    const license = { product: 'permitkeep-pro-v1', grant: 'lifetime-v1', licenseId, orderRef, issuedAt: new Date().toISOString() };
    const unsigned = { kind: 'permitkeep-license', protocol: 1, license };
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(canonicalize(unsigned)));
    return encodeEnvelope({ ...unsigned, signature: toBase64Url(new Uint8Array(signature)) });
  };
}

function securityHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Cross-Origin-Resource-Policy': 'same-site',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
}

function sendJson(response, status, body, origin) {
  response.writeHead(status, { ...securityHeaders(origin), 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function readRaw(request, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function createPermitKeepServer(env = process.env) {
  const appOrigin = required('PERMITKEEP_APP_ORIGIN', env).replace(/\/$/, '');
  const priceId = required('PERMITKEEP_PRICE_ID', env);
  if (!/^price_[A-Za-z0-9]+$/.test(priceId)) throw new Error('PERMITKEEP_PRICE_ID is malformed.');
  const webhookSecret = required('STRIPE_WEBHOOK_SECRET', env);
  const expectedLivemode = required('STRIPE_LIVEMODE', env) === 'true';
  const stripe = createStripeRestAdapter(required('STRIPE_SECRET_KEY', env));
  const signLicense = await createLicenseSigner(env);
  const ledger = new FileLedger(env.PERMITKEEP_LEDGER_PATH || path.resolve('operations/permitkeep/fulfillment-ledger.json'));
  const recent = new Map();

  return http.createServer(async (request, response) => {
    const requestOrigin = request.headers.origin;
    const origin = requestOrigin === appOrigin ? appOrigin : 'null';
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'OPTIONS') {
        if (origin === 'null') return sendJson(response, 403, { error: 'Origin not allowed.' }, origin);
        response.writeHead(204, securityHeaders(origin)); response.end(); return;
      }
      if (request.method === 'GET' && url.pathname === '/health') return sendJson(response, 200, { ok: true, mode: expectedLivemode ? 'live' : 'test', product: 'permitkeep-pro-v1' }, origin);
      if (request.method === 'POST' && url.pathname === '/api/webhook') {
        const rawBody = await readRaw(request);
        const result = await processStripeWebhook({ rawBody, signature: request.headers['stripe-signature'], secret: webhookSecret, ledger, stripe, signLicense, expectedPrice: priceId, expectedLivemode });
        return sendJson(response, 200, { received: true, status: result.status }, origin);
      }
      if (origin === 'null') return sendJson(response, 403, { error: 'Origin not allowed.' }, origin);
      if (request.method === 'POST' && url.pathname === '/api/checkout') {
        let body;
        try { body = JSON.parse(await readRaw(request, 2048)); } catch { throw new Error('Checkout request is malformed.'); }
        const attemptId = String(body?.attempt_id || '');
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attemptId)) throw new Error('Checkout attempt ID is malformed.');
        const address = request.socket.remoteAddress || 'unknown';
        const last = recent.get(address) || 0;
        if (Date.now() - last < 3000) return sendJson(response, 429, { error: 'Please wait before starting another checkout.' }, origin);
        recent.set(address, Date.now());
        const fulfillmentId = `ful_${crypto.createHash('sha256').update(attemptId).digest('base64url')}`;
        const session = await createCheckoutSession({ stripe, priceId, fulfillmentId, attemptId, successUrl: `${appOrigin}/?session_id={CHECKOUT_SESSION_ID}#claim`, cancelUrl: `${appOrigin}/#pro` });
        return sendJson(response, 201, { checkout_url: session.url }, origin);
      }
      if (request.method === 'GET' && url.pathname === '/api/claim') {
        const license = await ledger.claim(url.searchParams.get('session_id'));
        if (!license) return sendJson(response, 404, { status: 'not_ready' }, origin);
        return sendJson(response, 200, { status: 'fulfilled', license }, origin);
      }
      return sendJson(response, 404, { error: 'Not found.' }, origin);
    } catch (error) {
      const status = /signature|Origin|malformed|too large/i.test(error.message) ? 400 : 500;
      return sendJson(response, status, { error: status === 500 ? 'Fulfillment service error.' : error.message }, origin);
    }
  });
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const server = await createPermitKeepServer();
  const port = Number(process.env.PORT || 4190);
  server.listen(port, '127.0.0.1', () => console.log(`PermitKeep fulfillment listening on http://127.0.0.1:${port}`));
}
