import { startWorker } from '@commerce/runtime';

await startWorker({
  name: 'inventory-service', inputTopics: ['commerce.order.created.v1', 'commerce.payment.failed.v1', 'commerce.fulfillment.failed.v1'],
  setup: async (db) => {
    await db.raw('CREATE TABLE IF NOT EXISTS inventory (product_id VARCHAR(100) PRIMARY KEY, available_quantity INTEGER NOT NULL CHECK (available_quantity >= 0))');
    await db.raw('CREATE TABLE IF NOT EXISTS reservations (order_id UUID PRIMARY KEY, status VARCHAR(20) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    await db.raw('CREATE TABLE IF NOT EXISTS reservation_items (order_id UUID NOT NULL REFERENCES reservations(order_id), product_id VARCHAR(100) NOT NULL, quantity INTEGER NOT NULL CHECK (quantity > 0), PRIMARY KEY (order_id, product_id))');
    for (const [productId, quantity] of Object.entries(JSON.parse(process.env.STOCK_SEED_JSON ?? '{}'))) await db('inventory').insert({ product_id: productId, available_quantity: quantity }).onConflict('product_id').ignore();
  },
  handle: async (db, event) => {
    if (event.eventType === 'commerce.payment.failed' || event.eventType === 'commerce.fulfillment.failed') {
      const reservation = await db('reservations').where({ order_id: event.orderId }).forUpdate().first();
      if (!reservation || reservation.status !== 'RESERVED') return null;
      const items = await db('reservation_items').where({ order_id: event.orderId });
      for (const item of items) await db('inventory').where({ product_id: item.product_id }).increment('available_quantity', item.quantity);
      await db('reservations').where({ order_id: event.orderId }).update({ status: 'RELEASED' });
      return null;
    }
    const items = event.order?.items;
    if (!Array.isArray(items)) throw new Error('order-created event is missing items');
    const existing = await db('reservations').where({ order_id: event.orderId }).first(); if (existing) return null;
    for (const item of [...items].sort((a, b) => a.productId.localeCompare(b.productId))) {
      const stock = await db('inventory').where({ product_id: item.productId }).forUpdate().first();
      if (!stock || stock.available_quantity < item.quantity) { await db('reservations').insert({ order_id: event.orderId, status: 'REJECTED' }); return { eventType: 'commerce.inventory.rejected', payload: { reason: `insufficient stock for ${item.productId}` } }; }
    }
    for (const item of items) await db('inventory').where({ product_id: item.productId }).decrement('available_quantity', item.quantity);
    await db('reservations').insert({ order_id: event.orderId, status: 'RESERVED' });
    await db('reservation_items').insert(items.map((item) => ({ order_id: event.orderId, product_id: item.productId, quantity: item.quantity })));
    return { eventType: 'commerce.inventory.reserved', payload: { totalAmountMinor: event.order.totalAmountMinor, currency: event.order.currency } };
  },
});
