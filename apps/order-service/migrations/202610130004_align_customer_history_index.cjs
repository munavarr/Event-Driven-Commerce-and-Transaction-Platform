/**
 * Keyset pagination orders customer history by created_at and then id. The
 * original index covered only the first key, forcing an incremental sort when
 * several orders shared a timestamp.
 */
exports.up = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS orders_customer_created_idx');
  await knex.raw(`
    CREATE INDEX orders_customer_created_idx
    ON orders (customer_id, created_at DESC, id DESC)
    INCLUDE (status, total_amount_minor, currency);
  `);
  await knex.raw('ANALYZE orders');
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS orders_customer_created_idx');
  await knex.raw(`
    CREATE INDEX orders_customer_created_idx
    ON orders (customer_id, created_at DESC);
  `);
};
