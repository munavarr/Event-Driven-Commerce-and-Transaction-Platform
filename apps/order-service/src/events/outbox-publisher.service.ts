import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Producer } from 'kafkajs';
import type { Knex } from 'knex';
import { KNEX } from '../database/database.module.js';
import { createKafka, kafkaEnabled } from './kafka-topology.service.js';

interface OutboxEvent {
  id: string;
  topic: string;
  message_key: string;
  payload: unknown;
  headers: Record<string, string>;
}

@Injectable()
export class OutboxPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private readonly enabled: boolean;
  private readonly producer: Producer;
  private timer?: NodeJS.Timeout;
  private connected = false;
  private publishing = false;

  constructor(
    @Inject(KNEX) private readonly db: Knex,
    config: ConfigService,
  ) {
    this.enabled = kafkaEnabled(config);
    this.producer = createKafka(config, 'order-service-outbox').producer({
      allowAutoTopicCreation: false,
      idempotent: true,
      retry: { retries: 8 },
    });
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => void this.publishPending(), 1_000);
    void this.publishPending();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.connected) await this.producer.disconnect();
  }

  async publishPending(): Promise<void> {
    if (!this.enabled || this.publishing) return;
    this.publishing = true;
    try {
      if (!this.connected) {
        await this.producer.connect();
        this.connected = true;
      }
      const events = await this.db<OutboxEvent>('outbox_events')
        .select('id', 'topic', 'message_key', 'payload', 'headers')
        .whereNull('published_at')
        .orderBy('occurred_at', 'asc')
        .limit(50);

      for (const event of events) {
        try {
          await this.producer.send({
            topic: event.topic,
            acks: -1,
            messages: [
              {
                key: event.message_key,
                value: JSON.stringify(event.payload),
                headers: Object.fromEntries(
                  Object.entries(event.headers ?? {}).map(([key, value]) => [
                    key,
                    String(value),
                  ]),
                ),
              },
            ],
          });
          await this.db('outbox_events').where({ id: event.id }).update({
            published_at: this.db.fn.now(),
            last_error: null,
          });
        } catch (error) {
          await this.db('outbox_events').where({ id: event.id }).update({
            publish_attempts: this.db.raw('publish_attempts + 1'),
            last_error: this.message(error).slice(0, 2_000),
          });
          throw error;
        }
      }
    } catch (error) {
      this.connected = false;
      this.logger.warn(`Kafka outbox publish deferred: ${this.message(error)}`);
    } finally {
      this.publishing = false;
    }
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
