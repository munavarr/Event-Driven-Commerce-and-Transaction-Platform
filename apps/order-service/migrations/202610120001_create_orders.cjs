exports.up = async function (knex) {
  // gen_random_uuid() is supplied by pgcrypto, which is not enabled by default.
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  await knex.raw(`
    CREATE TABLE orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id UUID NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
      total_amount_minor BIGINT NOT NULL,
      currency CHAR(3) NOT NULL DEFAULT 'INR',
      idempotency_key VARCHAR(128) NOT NULL UNIQUE,
      request_hash VARCHAR(64) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT orders_status_check
        CHECK (
          status IN (
            'PENDING',
            'CONFIRMED',
            'CANCELLED',
            'PAYMENT_FAILED'
          )
        ),

      CONSTRAINT orders_total_check
        CHECK (total_amount_minor >= 0),

      CONSTRAINT orders_currency_check
        CHECK (currency ~ '^[A-Z]{3}$')
    );
  `);

  await knex.raw(`
    CREATE TABLE order_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id UUID NOT NULL
        REFERENCES orders(id) ON DELETE CASCADE,
      product_id VARCHAR(100) NOT NULL,
      product_name VARCHAR(200) NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price_minor BIGINT NOT NULL,
      line_total_minor BIGINT NOT NULL,

      CONSTRAINT order_items_quantity_check
        CHECK (quantity BETWEEN 1 AND 100),

      CONSTRAINT order_items_price_check
        CHECK (unit_price_minor >= 0),

      CONSTRAINT order_items_total_check
        CHECK (line_total_minor = unit_price_minor * quantity),

      CONSTRAINT order_items_unique_product
        UNIQUE (order_id, product_id)
    );
  `);

  await knex.raw(`
    CREATE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER orders_set_updated_at
    BEFORE UPDATE ON orders
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
  `);

  await knex.raw(`
    CREATE INDEX orders_customer_created_idx
    ON orders (customer_id, created_at DESC);
  `);

  await knex.raw(`
    CREATE INDEX order_items_order_id_idx
    ON order_items (order_id);
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP TRIGGER IF EXISTS orders_set_updated_at ON orders');
  await knex.raw('DROP FUNCTION IF EXISTS set_updated_at()');
  await knex.raw('DROP TABLE IF EXISTS order_items');
  await knex.raw('DROP TABLE IF EXISTS orders');
};
