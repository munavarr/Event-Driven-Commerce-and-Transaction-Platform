import { startWorker } from '@commerce/runtime';

await startWorker({
  name: 'notification-service', inputTopics: ['commerce.order.status-changed.v1'],
  setup: (db) => db.raw("CREATE TABLE IF NOT EXISTS notification_deliveries (event_id UUID PRIMARY KEY, order_id UUID NOT NULL, status VARCHAR(30) NOT NULL, delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"),
  handle: async (db, event) => { await db('notification_deliveries').insert({ event_id: event.eventId, order_id: event.orderId, status: event.status }); console.log(`notify order ${event.orderId}: ${event.status}`); return null; },
});
