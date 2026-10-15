import { startWorker } from '@commerce/runtime';

await startWorker({
  name: 'payment-service', inputTopics: ['commerce.inventory.reserved.v1'],
  setup: (db) => db.raw("CREATE TABLE IF NOT EXISTS payments (order_id UUID PRIMARY KEY, status VARCHAR(20) NOT NULL, amount_minor BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"),
  handle: async (db, event) => {
    const amount = BigInt(event.totalAmountMinor ?? '0');
    const limit = BigInt(process.env.PAYMENT_DECLINE_ABOVE_MINOR ?? '9000000000000000');
    const status = amount > limit ? 'FAILED' : 'AUTHORIZED';
    await db('payments').insert({ order_id: event.orderId, status, amount_minor: amount.toString() });
    return status === 'AUTHORIZED'
      ? { eventType: 'commerce.payment.authorized', payload: { amountMinor: amount.toString() } }
      : { eventType: 'commerce.payment.failed', payload: { reason: 'payment declined by configured provider adapter' } };
  },
});
