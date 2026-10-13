import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { KafkaTopologyService } from './kafka-topology.service.js';
import { OutboxPublisherService } from './outbox-publisher.service.js';
import {
  OrderCreatedAnalyticsConsumer,
  OrderCreatedNotificationConsumer,
} from './order-created-consumers.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [
    KafkaTopologyService,
    OutboxPublisherService,
    OrderCreatedNotificationConsumer,
    OrderCreatedAnalyticsConsumer,
  ],
})
export class EventsModule {}
