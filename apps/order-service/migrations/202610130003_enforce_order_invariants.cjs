exports.up = async function (knex) {
  // This trigger is also used by the inventory table below. Define it here as
  // well as in the initial schema migration so this migration remains safe on
  // databases where the original helper was removed during local development.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await knex.raw(`
    CREATE FUNCTION enforce_order_status_transition()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.status <> OLD.status
        AND NOT (
          (OLD.status = 'PENDING' AND NEW.status IN ('CONFIRMED', 'CANCELLED', 'PAYMENT_FAILED'))
          OR (OLD.status = 'PAYMENT_FAILED' AND NEW.status = 'CANCELLED')
        ) THEN
        RAISE EXCEPTION 'invalid order status transition: % -> %', OLD.status, NEW.status
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER orders_enforce_status_transition
    BEFORE UPDATE OF status ON orders
    FOR EACH ROW
    EXECUTE FUNCTION enforce_order_status_transition();
  `);

  await knex.raw(`
    CREATE FUNCTION check_order_total_matches_items(target_order_id UUID)
    RETURNS VOID AS $$
    DECLARE
      stored_total BIGINT;
      item_count BIGINT;
      calculated_total BIGINT;
    BEGIN
      -- An order deletion cascades to its line items. There is nothing left to check.
      IF NOT EXISTS (SELECT 1 FROM orders WHERE id = target_order_id) THEN
        RETURN;
      END IF;

      SELECT o.total_amount_minor,
             count(i.id),
             COALESCE(sum(i.line_total_minor), 0)
      INTO stored_total, item_count, calculated_total
      FROM orders AS o
      LEFT JOIN order_items AS i ON i.order_id = o.id
      WHERE o.id = target_order_id
      GROUP BY o.id, o.total_amount_minor;

      IF item_count = 0 OR stored_total <> calculated_total THEN
        RAISE EXCEPTION 'order % total does not match its line items', target_order_id
          USING ERRCODE = '23514';
      END IF;
    END;
    $$ LANGUAGE plpgsql;

    CREATE FUNCTION enforce_order_total_from_order()
    RETURNS TRIGGER AS $$
    BEGIN
      PERFORM check_order_total_matches_items(NEW.id);
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;

    CREATE FUNCTION enforce_order_total_from_item()
    RETURNS TRIGGER AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        PERFORM check_order_total_matches_items(OLD.order_id);
      ELSE
        PERFORM check_order_total_matches_items(NEW.order_id);
      END IF;
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;

    CREATE CONSTRAINT TRIGGER orders_total_matches_items
    AFTER INSERT OR UPDATE ON orders
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION enforce_order_total_from_order();

    CREATE CONSTRAINT TRIGGER order_items_total_matches_order
    AFTER INSERT OR UPDATE OR DELETE ON order_items
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION enforce_order_total_from_item();
  `);

  await knex.raw(`
    CREATE TRIGGER inventory_set_updated_at
    BEFORE UPDATE ON inventory
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP TRIGGER IF EXISTS inventory_set_updated_at ON inventory');
  await knex.raw('DROP TRIGGER IF EXISTS order_items_total_matches_order ON order_items');
  await knex.raw('DROP TRIGGER IF EXISTS orders_total_matches_items ON orders');
  await knex.raw('DROP FUNCTION IF EXISTS enforce_order_total_from_item()');
  await knex.raw('DROP FUNCTION IF EXISTS enforce_order_total_from_order()');
  await knex.raw('DROP FUNCTION IF EXISTS check_order_total_matches_items(UUID)');
  await knex.raw('DROP TRIGGER IF EXISTS orders_enforce_status_transition ON orders');
  await knex.raw('DROP FUNCTION IF EXISTS enforce_order_status_transition()');
};
