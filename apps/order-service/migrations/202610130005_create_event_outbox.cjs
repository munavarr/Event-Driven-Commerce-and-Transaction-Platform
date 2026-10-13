exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE outbox_events (
      id UUID PRIMARY KEY,
      topic VARCHAR(200) NOT NULL,
      message_key VARCHAR(200) NOT NULL,
      payload JSONB NOT NULL,
      headers JSONB NOT NULL DEFAULT '{}'::jsonb,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      published_at TIMESTAMPTZ,
      publish_attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      CONSTRAINT outbox_events_attempts_check CHECK (publish_attempts >= 0)
    );

    CREATE INDEX outbox_events_unpublished_idx
    ON outbox_events (occurred_at)
    WHERE published_at IS NULL;
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP TABLE IF EXISTS outbox_events');
};
