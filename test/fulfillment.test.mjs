import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  MemoryLedger,
  createCheckoutSession,
  processStripeWebhook,
  stripeSignature,
} from '../fulfillment/lib.mjs';

const secret = 'whsec_test_only';
const priceId = 'price_test_permitkeep';
const now = 1_788_370_700;
const signLicense = async ({ licenseId, orderRef }) => `signed:${licenseId}:${orderRef}`;
const paidSession = {
  id: 'cs_test_paid',
  mode: 'payment',
  payment_status: 'paid',
  payment_intent: 'pi_test_paid',
  metadata: { product_key: 'permitkeep-pro-v1', fulfillment_id: 'ful_test_opaque' },
  line_items: { data: [{ price: { id: priceId }, quantity: 1 }] },
};
const stripe = {
  retrieveCheckout: async (id) => ({ ...paidSession, id }),
  createCheckout: async (payload, idempotencyKey) => ({ id: 'cs_test_created', url: 'https://checkout.stripe.test/session', payload, idempotencyKey }),
};

function signedEvent(event, signingSecret = secret, timestamp = now) {
  const rawBody = JSON.stringify(event);
  return { rawBody, signature: stripeSignature(rawBody, signingSecret, timestamp) };
}

test('checkout creation uses only the allow-listed product price and explicit URLs', async () => {
  const result = await createCheckoutSession({ stripe, priceId, successUrl: 'https://example.test/success?session_id={CHECKOUT_SESSION_ID}', cancelUrl: 'https://example.test/#pro', fulfillmentId: 'ful_opaque', attemptId: '70fc65f4-8303-4e88-b887-27efb3ec62f2' });
  assert.equal(result.id, 'cs_test_created');
  assert.deepEqual(result.payload.line_items, [{ price: priceId, quantity: 1 }]);
  assert.equal(result.idempotencyKey, 'permitkeep-checkout-70fc65f4-8303-4e88-b887-27efb3ec62f2');
  assert.equal(result.payload.mode, 'payment');
  assert.equal(result.payload.metadata.product_key, 'permitkeep-pro-v1');
  assert.equal(result.payload.metadata.fulfillment_id, 'ful_opaque');
  assert.equal(result.payload.customer_creation, 'always');
  assert.equal(result.payload.allow_promotion_codes, false);
});

test('checkout rejects malformed attempt identifiers', async () => {
  await assert.rejects(() => createCheckoutSession({ stripe, priceId, successUrl: 'https://example.test/success', cancelUrl: 'https://example.test/cancel', attemptId: 'guessable' }), /attempt/i);
});

test('forged webhook signatures create no fulfillment', async () => {
  const ledger = new MemoryLedger();
  const event = { id: 'evt_forged', type: 'checkout.session.completed', created: now, livemode: false, data: { object: { id: paidSession.id } } };
  await assert.rejects(() => processStripeWebhook({ ...signedEvent(event, 'wrong_secret'), secret, ledger, stripe, signLicense, expectedPrice: priceId, expectedLivemode: false, now }), /signature/i);
  assert.equal((await ledger.read()).sessions[paidSession.id], undefined);
});

test('paid Checkout fulfills exactly once and duplicate delivery is idempotent', async () => {
  const ledger = new MemoryLedger();
  const event = { id: 'evt_paid', type: 'checkout.session.completed', created: now, livemode: false, data: { object: { id: paidSession.id } } };
  const first = await processStripeWebhook({ ...signedEvent(event), secret, ledger, stripe, signLicense, expectedPrice: priceId, expectedLivemode: false, now });
  const duplicate = await processStripeWebhook({ ...signedEvent(event), secret, ledger, stripe, signLicense, expectedPrice: priceId, expectedLivemode: false, now });
  assert.equal(first.status, 'fulfilled');
  assert.equal(duplicate.status, 'duplicate_event');
  const state = await ledger.read();
  assert.equal(Object.keys(state.sessions).length, 1);
  assert.match(state.sessions[paidSession.id].license, /^signed:/);
});

test('wrong price and unpaid sessions never fulfill', async () => {
  for (const badSession of [
    { ...paidSession, payment_status: 'unpaid' },
    { ...paidSession, line_items: { data: [{ price: { id: 'price_wrong' }, quantity: 1 }] } },
    { ...paidSession, metadata: { product_key: 'wrong-product', fulfillment_id: 'ful_test_opaque' } },
  ]) {
    const ledger = new MemoryLedger();
    const event = { id: `evt_${Math.random()}`, type: 'checkout.session.completed', created: now, livemode: false, data: { object: { id: paidSession.id } } };
    await assert.rejects(() => processStripeWebhook({ ...signedEvent(event), secret, ledger, stripe: { ...stripe, retrieveCheckout: async () => badSession }, signLicense, expectedPrice: priceId, expectedLivemode: false, now }), /paid|price|product/i);
    assert.equal((await ledger.read()).sessions[paidSession.id], undefined);
  }
});

test('out-of-order failure cannot revert a fulfilled license', async () => {
  const ledger = new MemoryLedger();
  const paid = { id: 'evt_paid_first', type: 'checkout.session.completed', created: now, livemode: false, data: { object: { id: paidSession.id } } };
  await processStripeWebhook({ ...signedEvent(paid), secret, ledger, stripe, signLicense, expectedPrice: priceId, expectedLivemode: false, now });
  const failed = { id: 'evt_failed_late', type: 'checkout.session.async_payment_failed', created: now - 100, livemode: false, data: { object: { id: paidSession.id } } };
  const result = await processStripeWebhook({ ...signedEvent(failed), secret, ledger, stripe, signLicense, expectedPrice: priceId, expectedLivemode: false, now });
  assert.equal(result.status, 'fulfilled_unchanged');
  assert.equal((await ledger.read()).sessions[paidSession.id].status, 'fulfilled');
});

test('refund delivered before completion blocks later license issuance', async () => {
  const ledger = new MemoryLedger();
  const refund = { id: 'evt_refund_first', type: 'charge.refunded', created: now - 1, livemode: false, data: { object: { id: 'ch_refunded', payment_intent: paidSession.payment_intent } } };
  const completion = { id: 'evt_complete_late', type: 'checkout.session.completed', created: now, livemode: false, data: { object: { id: paidSession.id } } };
  assert.equal((await processStripeWebhook({ ...signedEvent(refund), secret, ledger, stripe, signLicense, expectedPrice: priceId, expectedLivemode: false, now })).status, 'recorded_unmatched_adverse');
  assert.equal((await processStripeWebhook({ ...signedEvent(completion), secret, ledger, stripe, signLicense, expectedPrice: priceId, expectedLivemode: false, now })).status, 'blocked_adverse');
  assert.equal(await ledger.claim(paidSession.id), null);
});

test('newer failed-payment state blocks an older completion event', async () => {
  const ledger = new MemoryLedger();
  const failed = { id: 'evt_failed_newer', type: 'checkout.session.async_payment_failed', created: now, livemode: false, data: { object: { id: paidSession.id } } };
  const staleCompletion = { id: 'evt_complete_older', type: 'checkout.session.completed', created: now - 10, livemode: false, data: { object: { id: paidSession.id } } };
  await processStripeWebhook({ ...signedEvent(failed), secret, ledger, stripe, signLicense, expectedPrice: priceId, expectedLivemode: false, now });
  assert.equal((await processStripeWebhook({ ...signedEvent(staleCompletion), secret, ledger, stripe, signLicense, expectedPrice: priceId, expectedLivemode: false, now })).status, 'stale_completion_ignored');
  assert.equal(await ledger.claim(paidSession.id), null);
});

test('claim returns only the exact fulfilled session license', async () => {
  const ledger = new MemoryLedger();
  const paid = { id: 'evt_claim', type: 'checkout.session.completed', created: now, livemode: false, data: { object: { id: paidSession.id } } };
  await processStripeWebhook({ ...signedEvent(paid), secret, ledger, stripe, signLicense, expectedPrice: priceId, expectedLivemode: false, now });
  assert.match(await ledger.claim(paidSession.id), /^signed:/);
  assert.equal(await ledger.claim('cs_test_unknown'), null);
});
