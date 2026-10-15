import { randomUUID } from 'node:crypto';
import { startWorker } from '@commerce/runtime';

await startWorker({
  name: 'fulfillment-service', inputTopics: ['commerce.payment.authorized.v1'],
  setup: (db) => db.raw("CREATE TABLE IF NOT EXISTS fulfillments (order_id UUID PRIMARY KEY, shipment_id UUID, status VARCHAR(20) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"),
  handle: async (db, event) => {
    const enabled = (process.env.FULFILLMENT_ENABLED ?? 'true').toLowerCase() !== 'false';
    const shipmentId = enabled ? randomUUID() : null;
    await db('fulfillments').insert({ order_id: event.orderId, shipment_id: shipmentId, status: enabled ? 'CREATED' : 'FAILED' });
    return enabled ? { eventType: 'commerce.fulfillment.created', payload: { shipmentId } } : { eventType: 'commerce.fulfillment.failed', payload: { reason: 'fulfillment disabled' } };
  },
});
