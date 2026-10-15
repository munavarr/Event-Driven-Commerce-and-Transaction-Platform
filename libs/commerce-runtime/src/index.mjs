import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import knex from 'knex';
import { Kafka, logLevel } from 'kafkajs';

export async function startWorker({ name, inputTopics, setup, handle }) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 10 } });
  await db.raw('SELECT 1');
  await db.schema.createTable('inbox_events', (table) => {
    table.uuid('event_id').primary(); table.string('event_type', 120).notNullable(); table.timestamp('processed_at', { useTz: true }).defaultTo(db.fn.now());
  }).catch((error) => { if (error.code !== '42P07') throw error; });
  await db.schema.createTable('outbox_events', (table) => {
    table.uuid('id').primary(); table.string('topic', 200).notNullable(); table.string('message_key', 200).notNullable(); table.jsonb('payload').notNullable(); table.timestamp('published_at', { useTz: true }); table.integer('publish_attempts').notNullable().defaultTo(0); table.text('last_error'); table.timestamp('occurred_at', { useTz: true }).defaultTo(db.fn.now());
  }).catch((error) => { if (error.code !== '42P07') throw error; });
  await setup(db);

  const brokers = (process.env.KAFKA_BROKERS ?? '127.0.0.1:9092').split(',').map((v) => v.trim());
  const kafka = new Kafka({ clientId: name, brokers, logLevel: logLevel.NOTHING });
  const producer = kafka.producer({ allowAutoTopicCreation: false, idempotent: true });
  const consumer = kafka.consumer({ groupId: `${name}-v1` });
  await producer.connect(); await consumer.connect();
  await consumer.subscribe({ topics: inputTopics, fromBeginning: false });

  const publish = async () => {
    const rows = await db('outbox_events').whereNull('published_at').orderBy('occurred_at').limit(50);
    for (const row of rows) {
      try {
        await producer.send({ topic: row.topic, acks: -1, messages: [{ key: row.message_key, value: JSON.stringify(row.payload) }] });
        await db('outbox_events').where({ id: row.id }).update({ published_at: db.fn.now(), last_error: null });
      } catch (error) {
        await db('outbox_events').where({ id: row.id }).update({ publish_attempts: db.raw('publish_attempts + 1'), last_error: String(error).slice(0, 2000) });
        throw error;
      }
    }
  };
  const timer = setInterval(() => void publish().catch(() => undefined), 1000);
  await consumer.run({ eachMessage: async ({ message, topic }) => {
    const event = JSON.parse(message.value?.toString('utf8') ?? '{}');
    if (!event.eventId || !event.eventType || !event.orderId) throw new Error(`invalid event on ${topic}`);
    await db.transaction(async (trx) => {
      const inserted = await trx('inbox_events').insert({ event_id: event.eventId, event_type: event.eventType }).onConflict('event_id').ignore().returning('event_id');
      if (inserted.length === 0) return;
      const result = await handle(trx, event);
      if (!result) return;
      const eventId = randomUUID();
      await trx('outbox_events').insert({ id: eventId, topic: `${result.eventType}.v1`, message_key: event.orderId, payload: { eventId, eventType: result.eventType, schemaVersion: 1, occurredAt: new Date().toISOString(), orderId: event.orderId, ...result.payload } });
    });
    await publish();
  }});
  const stop = async () => { clearInterval(timer); await consumer.disconnect(); await producer.disconnect(); await db.destroy(); };
  process.on('SIGTERM', () => void stop()); process.on('SIGINT', () => void stop());
}
