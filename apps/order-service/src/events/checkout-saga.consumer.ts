import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Consumer } from 'kafkajs';
import { OrderService } from '../orders/order.service.js';
import { createKafka, kafkaEnabled } from './kafka-topology.service.js';

type Result = { eventId: string; orderId: string };

const transitions: Record<string, readonly [string, string]> = {
  'commerce.inventory.reserved': ['PENDING', 'INVENTORY_RESERVED'],
  'commerce.inventory.rejected': ['PENDING', 'CANCELLED'],
  'commerce.payment.authorized': ['INVENTORY_RESERVED', 'PAYMENT_AUTHORIZED'],
  'commerce.payment.failed': ['INVENTORY_RESERVED', 'PAYMENT_FAILED'],
  'commerce.fulfillment.created': ['PAYMENT_AUTHORIZED', 'CONFIRMED'],
  'commerce.fulfillment.failed': ['PAYMENT_AUTHORIZED', 'CANCELLED'],
};

@Injectable()
export class CheckoutSagaConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CheckoutSagaConsumer.name);
  private readonly enabled: boolean;
  private readonly consumer: Consumer;
  private connected = false;

  constructor(config: ConfigService, private readonly orders: OrderService) {
    this.enabled = kafkaEnabled(config);
    this.consumer = createKafka(config, 'order-service-saga').consumer({ groupId: 'order-saga-v1' });
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) return;
    await this.consumer.connect();
    this.connected = true;
    await this.consumer.subscribe({ topics: Object.keys(transitions).map((type) => `${type}.v1`) });
    await this.consumer.run({ eachMessage: async ({ topic, message }) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as Result;
      const type = topic.replace(/\.v1$/, '');
      const transition = transitions[type];
      if (!transition || !event.eventId || !event.orderId) {
        throw new Error(`invalid saga result on ${topic}`);
      }
      await this.orders.applySagaResult(event.eventId, event.orderId, ...transition);
      this.logger.debug(`applied ${type} for ${event.orderId}`);
    }});
  }

  async onModuleDestroy(): Promise<void> {
    if (this.connected) await this.consumer.disconnect();
  }
}
