/**
 * Supports the two hot read paths without adding an index for every column:
 *
 * 1. Customer order history filtered by status and ordered by newest first.
 * 2. Fetching an order's line items (already covered by the unique constraint).
 */
exports.up = async function (knex) {
  await knex.raw(`
    CREATE INDEX orders_customer_status_created_covering_idx
    ON orders (customer_id, status, created_at DESC, id DESC)
    INCLUDE (total_amount_minor, currency);
  `);

  // The unique (order_id, product_id) B-tree also supports order_id lookups.
  // Keeping a second order_id-only index would add write and storage overhead.
  await knex.raw('DROP INDEX IF EXISTS order_items_order_id_idx');

  // Customer and status can be correlated in real workloads. Extended statistics
  // give the planner a better selectivity estimate than independent estimates.
  await knex.raw(`
    CREATE STATISTICS orders_customer_status_stats (dependencies, ndistinct)
    ON customer_id, status
    FROM orders;
  `);
  await knex.raw('ANALYZE orders');
};

exports.down = async function (knex) {
  await knex.raw('DROP STATISTICS IF EXISTS orders_customer_status_stats');
  await knex.raw(
    'DROP INDEX IF EXISTS orders_customer_status_created_covering_idx',
  );
  await knex.raw(
    'CREATE INDEX order_items_order_id_idx ON order_items (order_id)',
  );
};
