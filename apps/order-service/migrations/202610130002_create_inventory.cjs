exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE inventory (
      product_id VARCHAR(100) PRIMARY KEY,
      available_quantity INTEGER NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT inventory_available_quantity_check
        CHECK (available_quantity >= 0)
    );
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP TABLE IF EXISTS inventory');
};
