import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Consumer, Producer } from 'kafkajs';
import { createKafka, kafkaEnabled } from './kafka-topology.service.js';
import {
  ORDER_CREATED_DEAD_LETTER_TOPIC,
  ORDER_CREATED_TOPIC,
  parseOrderCreatedEvent,
  type OrderCreatedEvent,
} from './order-created.event.js';

abstract class OrderCreatedConsumer implements OnModuleInit, OnModuleDestroy {
  protected abstract groupId(): string;
  protected abstract consumerName(): string;
  protected readonly logger: Logger;
  private readonly enabled: boolean;
  private readonly consumer: Consumer;
  private readonly producer: Producer;
  private connected = false;

  constructor(config: ConfigService) {
    this.logger = new Logger(this.consumerName());
    this.enabled = kafkaEnabled(config);
    const kafka = createKafka(config, `order-service-${this.groupId()}`);
    this.consumer = kafka.consumer({ groupId: this.groupId() });
    this.producer = kafka.producer({ allowAutoTopicCreation: false });
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.consumer.connect();
      await this.producer.connect();
      this.connected = true;
      await this.consumer.subscribe({ topic: ORDER_CREATED_TOPIC, fromBeginning: false });
      await this.consumer.run({
        eachMessage: async ({ message }) => {
          const payload = message.value?.toString('utf8') ?? '';
          const key = message.key?.toString('utf8') ?? '';
          await this.process(payload, key, message.headers ?? {});
        },
      });
    } catch (error) {
      this.logger.warn(`Kafka consumer deferred: ${this.message(error)}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.connected) return;
    await Promise.all([this.consumer.disconnect(), this.producer.disconnect()]);
  }

  private async process(
    payload: string,
    key: string,
    headers: Record<string, Buffer | string | (Buffer | string)[] | undefined>,
  ): Promise<void> {
    let event: OrderCreatedEvent;
    try {
      event = parseOrderCreatedEvent(JSON.parse(payload));
    } catch (error) {
      await this.deadLetter(payload, key, headers, error);
      return;
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.handle(event);
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 250));
      }
    }
    await this.deadLetter(payload, key, headers, lastError);
  }

  private async deadLetter(
    payload: string,
    key: string,
    headers: Record<string, Buffer | string | (Buffer | string)[] | undefined>,
    error: unknown,
  ): Promise<void> {
    await this.producer.send({
      topic: ORDER_CREATED_DEAD_LETTER_TOPIC,
      messages: [
        {
          key,
          value: payload,
          headers: {
            ...headers,
            'x-original-consumer-group': this.groupId(),
            'x-dead-letter-reason': this.message(error).slice(0, 1_000),
          },
        },
      ],
    });
  }

  protected abstract handle(event: OrderCreatedEvent): Promise<void>;

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

@Injectable()
export class OrderCreatedNotificationConsumer extends OrderCreatedConsumer {
  constructor(config: ConfigService) {
    super(config);
  }

  protected groupId(): string {
    return 'notifications-v1';
  }

  protected consumerName(): string {
    return 'OrderCreatedNotificationConsumer';
  }

  protected async handle(event: OrderCreatedEvent): Promise<void> {
    // Replace with the notification provider. Persist eventId there as the
    // idempotency key because Kafka is at-least-once end to end.
    this.logger.log(`Queue order-created notification for ${event.order.id}`);
  }
}

@Injectable()
export class OrderCreatedAnalyticsConsumer extends OrderCreatedConsumer {
  constructor(config: ConfigService) {
    super(config);
  }

  protected groupId(): string {
    return 'analytics-v1';
  }

  protected consumerName(): string {
    return 'OrderCreatedAnalyticsConsumer';
  }

  protected async handle(event: OrderCreatedEvent): Promise<void> {
    // Replace with the analytics sink. This distinct group receives every event
    // independently of the notification consumer's progress.
    this.logger.log(`Record order-created analytics for ${event.order.id}`);
  }
}
