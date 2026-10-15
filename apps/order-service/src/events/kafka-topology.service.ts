import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, logLevel } from 'kafkajs';
import { ORDER_CREATED_DEAD_LETTER_TOPIC, ORDER_CREATED_TOPIC } from './order-created.event.js';

export function kafkaBrokers(config: ConfigService): string[] {
  return (config.get<string>('KAFKA_BROKERS') ?? '127.0.0.1:9092')
    .split(',')
    .map((broker) => broker.trim())
    .filter(Boolean);
}

export function kafkaEnabled(config: ConfigService): boolean {
  return (config.get<string>('KAFKA_ENABLED') ?? 'true').toLowerCase() !== 'false';
}

export function createKafka(config: ConfigService, clientId: string): Kafka {
  return new Kafka({
    clientId,
    brokers: kafkaBrokers(config),
    logLevel: logLevel.NOTHING,
  });
}

@Injectable()
export class KafkaTopologyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaTopologyService.name);
  private readonly kafka: Kafka;
  private admin?: ReturnType<Kafka['admin']>;
  private retryTimer?: NodeJS.Timeout;

  constructor(private readonly config: ConfigService) {
    this.kafka = createKafka(config, 'order-service-topology');
  }

  async onModuleInit(): Promise<void> {
    if (!kafkaEnabled(this.config)) return;
    this.admin = this.kafka.admin();
    await this.provision();
    this.retryTimer = setInterval(() => void this.provision(), 10_000);
  }

  private async provision(): Promise<void> {
    if (!this.admin) return;
    try {
      await this.admin.connect();
      await this.admin.createTopics({
        waitForLeaders: true,
        topics: [
          { topic: ORDER_CREATED_TOPIC, numPartitions: 3, replicationFactor: 1 },
          {
            topic: ORDER_CREATED_DEAD_LETTER_TOPIC,
            numPartitions: 3,
            replicationFactor: 1,
          },
          ...['commerce.inventory.reserved.v1', 'commerce.inventory.rejected.v1',
            'commerce.payment.authorized.v1', 'commerce.payment.failed.v1',
            'commerce.fulfillment.created.v1', 'commerce.fulfillment.failed.v1',
            'commerce.order.status-changed.v1']
            .map((topic) => ({ topic, numPartitions: 3, replicationFactor: 1 })),
        ],
      });
    } catch (error) {
      // A local broker may be starting after this service. The outbox keeps the
      // event durable and the publisher will retry; do not fail order serving.
      this.logger.warn(`Kafka topic provisioning deferred: ${this.message(error)}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.retryTimer) clearInterval(this.retryTimer);
    await this.admin?.disconnect();
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
