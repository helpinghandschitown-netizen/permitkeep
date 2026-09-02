import crypto from 'node:crypto';

const PRODUCT_KEY = 'permitkeep-pro-v1';
const SIGNATURE_TOLERANCE_SECONDS = 300;

export function stripeSignature(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const digest = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

export function verifyStripeSignature(rawBody, header, secret, now = Math.floor(Date.now() / 1000)) {
  if (!secret || !header) throw new Error('Stripe webhook signature is missing.');
  const parts = String(header).split(',').map((part) => part.trim().split('='));
  const timestamp = Number(parts.find(([key]) => key === 't')?.[1]);
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!Number.isInteger(timestamp) || !signatures.length || Math.abs(now - timestamp) > SIGNATURE_TOLERANCE_SECONDS) throw new Error('Stripe webhook signature timestamp is invalid.');
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const expectedBytes = Buffer.from(expected, 'hex');
  const valid = signatures.some((signature) => {
    if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
    const actual = Buffer.from(signature, 'hex');
    return actual.length === expectedBytes.length && crypto.timingSafeEqual(actual, expectedBytes);
  });
  if (!valid) throw new Error('Stripe webhook signature verification failed.');
}

export async function createCheckoutSession({ stripe, priceId, successUrl, cancelUrl, fulfillmentId = crypto.randomUUID(), attemptId }) {
  if (!priceId || !successUrl || !cancelUrl) throw new Error('Checkout configuration is incomplete.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(attemptId || ''))) throw new Error('Checkout attempt ID is malformed.');
  return stripe.createCheckout({
    mode: 'payment',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer_creation: 'always',
    allow_promotion_codes: false,
    automatic_tax: { enabled: true },
    metadata: { product_key: PRODUCT_KEY, fulfillment_id: fulfillmentId },
    payment_intent_data: { metadata: { product_key: PRODUCT_KEY, fulfillment_id: fulfillmentId } },
  }, `permitkeep-checkout-${attemptId}`);
}

function validatePaidSession(session, expectedPrice) {
  if (session?.mode !== 'payment' || session?.payment_status !== 'paid') throw new Error('Checkout Session is not paid.');
  if (session.metadata?.product_key !== PRODUCT_KEY || !session.metadata?.fulfillment_id) throw new Error('Checkout Session has the wrong product metadata.');
  const items = session.line_items?.data || [];
  if (items.length !== 1 || items[0]?.price?.id !== expectedPrice || items[0]?.quantity !== 1) throw new Error('Checkout Session has the wrong price or quantity.');
}

function initialState() {
  return { schema: 2, events: {}, sessions: {}, paymentIntents: {}, adversePaymentIntents: {} };
}

export class MemoryLedger {
  #state;
  #queue = Promise.resolve();
  constructor(state = initialState()) { this.#state = structuredClone(state); }
  async read() { return structuredClone(this.#state); }
  async transact(mutator) {
    let result;
    const operation = this.#queue.then(async () => {
      const draft = structuredClone(this.#state);
      result = await mutator(draft);
      this.#state = draft;
    });
    this.#queue = operation.catch(() => {});
    await operation;
    return result;
  }
  async claim(sessionId) {
    const session = this.#state.sessions[String(sessionId || '')];
    return session?.status === 'fulfilled' ? session.license : null;
  }
}

export async function processStripeWebhook({ rawBody, signature, secret, ledger, stripe, signLicense, expectedPrice, expectedLivemode, now = Math.floor(Date.now() / 1000) }) {
  verifyStripeSignature(rawBody, signature, secret, now);
  let event;
  try { event = JSON.parse(rawBody); } catch { throw new Error('Stripe webhook body is not valid JSON.'); }
  if (!event?.id || !event?.type || !event.data?.object) throw new Error('Stripe webhook event is malformed.');
  if (event.livemode !== expectedLivemode) throw new Error('Stripe webhook mode does not match this environment.');

  return ledger.transact(async (state) => {
    if (state.events[event.id]) return { status: 'duplicate_event', eventId: event.id };
    const object = event.data.object;
    const sessionId = String(object.id || '');

    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
      const existing = state.sessions[sessionId];
      if (existing?.status === 'fulfilled') {
        state.events[event.id] = { type: event.type, created: event.created, status: 'duplicate_session' };
        return { status: 'duplicate_session', sessionId };
      }
      if (existing?.status === 'payment_failed' && Number(existing.authoritativeEventCreated || 0) >= Number(event.created || 0)) {
        state.events[event.id] = { type: event.type, created: event.created, status: 'stale_completion_ignored', sessionId };
        return { status: 'stale_completion_ignored', sessionId };
      }
      const session = await stripe.retrieveCheckout(sessionId);
      validatePaidSession(session, expectedPrice);
      const adverse = session.payment_intent ? state.adversePaymentIntents[session.payment_intent] : null;
      if (adverse) {
        state.sessions[sessionId] = { status: 'blocked_adverse', paymentIntent: session.payment_intent, postPurchaseStatus: adverse.status, authoritativeEventCreated: Number(adverse.created || event.created || now) };
        state.paymentIntents[session.payment_intent] = sessionId;
        state.events[event.id] = { type: event.type, created: event.created, status: 'blocked_adverse', sessionId };
        return { status: 'blocked_adverse', sessionId };
      }
      const orderRef = crypto.createHash('sha256').update(sessionId).digest('base64url');
      const licenseId = String(session.metadata.fulfillment_id);
      const license = await signLicense({ licenseId, orderRef });
      state.sessions[sessionId] = {
        status: 'fulfilled',
        license,
        licenseId,
        orderRef,
        paymentIntent: session.payment_intent || null,
        fulfilledAt: new Date(now * 1000).toISOString(),
        authoritativeEventCreated: Number(event.created || now),
      };
      if (session.payment_intent) state.paymentIntents[session.payment_intent] = sessionId;
      state.events[event.id] = { type: event.type, created: event.created, status: 'fulfilled', sessionId };
      return { status: 'fulfilled', sessionId };
    }

    if (event.type === 'checkout.session.async_payment_failed') {
      const existing = state.sessions[sessionId];
      if (existing?.status === 'fulfilled') {
        state.events[event.id] = { type: event.type, created: event.created, status: 'ignored_after_fulfillment', sessionId };
        return { status: 'fulfilled_unchanged', sessionId };
      }
      state.sessions[sessionId] = { status: 'payment_failed', authoritativeEventCreated: Number(event.created || now) };
      state.events[event.id] = { type: event.type, created: event.created, status: 'payment_failed', sessionId };
      return { status: 'payment_failed', sessionId };
    }

    if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
      const paymentIntent = object.payment_intent;
      const adverseStatus = event.type === 'charge.refunded' ? 'refunded' : 'disputed';
      const linkedSession = paymentIntent ? state.paymentIntents[paymentIntent] : null;
      if (paymentIntent) state.adversePaymentIntents[paymentIntent] = { status: adverseStatus, eventId: event.id, created: Number(event.created || now) };
      if (linkedSession && state.sessions[linkedSession]) {
        state.sessions[linkedSession].postPurchaseStatus = adverseStatus;
        state.sessions[linkedSession].offlineRevocationBoundary = 'License already issued; automatic offline revocation is not guaranteed.';
      }
      state.events[event.id] = { type: event.type, created: event.created, status: linkedSession ? 'recorded' : 'recorded_unmatched_adverse', sessionId: linkedSession || null };
      return { status: linkedSession ? 'recorded' : 'recorded_unmatched_adverse' };
    }

    state.events[event.id] = { type: event.type, created: event.created, status: 'ignored' };
    return { status: 'ignored' };
  });
}

export { PRODUCT_KEY };
