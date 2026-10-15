exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE orders DROP CONSTRAINT orders_status_check;
    ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (
      status IN ('PENDING', 'INVENTORY_RESERVED', 'PAYMENT_AUTHORIZED',
                 'CONFIRMED', 'CANCELLED', 'PAYMENT_FAILED')
    );
  `);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION enforce_order_status_transition()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.status <> OLD.status
        AND NOT (
          (OLD.status = 'PENDING' AND NEW.status IN ('INVENTORY_RESERVED', 'CANCELLED'))
          OR (OLD.status = 'INVENTORY_RESERVED' AND NEW.status IN ('PAYMENT_AUTHORIZED', 'PAYMENT_FAILED', 'CANCELLED'))
          OR (OLD.status = 'PAYMENT_AUTHORIZED' AND NEW.status IN ('CONFIRMED', 'CANCELLED'))
          OR (OLD.status = 'PAYMENT_FAILED' AND NEW.status = 'CANCELLED')
        ) THEN
        RAISE EXCEPTION 'invalid order status transition: % -> %', OLD.status, NEW.status
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await knex.raw(`
    CREATE TABLE processed_events (
      event_id UUID PRIMARY KEY,
      event_type VARCHAR(120) NOT NULL,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP TABLE IF EXISTS processed_events');
  await knex.raw(`
    ALTER TABLE orders DROP CONSTRAINT orders_status_check;
    ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (
      status IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'PAYMENT_FAILED')
    );
  `);
};
