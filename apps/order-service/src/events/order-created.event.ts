import type { Order } from '../orders/order.service.js';

export const ORDER_CREATED_TOPIC = 'commerce.order.created.v1';
export const ORDER_CREATED_DEAD_LETTER_TOPIC = `${ORDER_CREATED_TOPIC}.dlt`;
export const ORDER_CREATED_EVENT_TYPE = 'commerce.order.created';
export const ORDER_CREATED_SCHEMA_VERSION = 1;

export interface OrderCreatedEvent {
  eventId: string;
  eventType: typeof ORDER_CREATED_EVENT_TYPE;
  schemaVersion: typeof ORDER_CREATED_SCHEMA_VERSION;
  occurredAt: string;
  order: {
    id: string;
    customerId: string;
    status: string;
    totalAmountMinor: string;
    currency: string;
    items: Array<{
      id: string;
      productId: string;
      productName: string;
      quantity: number;
      unitPriceMinor: string;
      lineTotalMinor: string;
    }>;
  };
}

/**
 * The order id is deliberately the Kafka key. Kafka preserves the order of all
 * messages for a key within a topic partition, without forcing every order onto
 * one partition.
 */
export function createOrderCreatedEvent(
  eventId: string,
  order: Order,
  occurredAt = new Date().toISOString(),
): OrderCreatedEvent {
  return {
    eventId,
    eventType: ORDER_CREATED_EVENT_TYPE,
    schemaVersion: ORDER_CREATED_SCHEMA_VERSION,
    occurredAt,
    order: {
      id: order.id,
      customerId: order.customerId,
      status: order.status,
      totalAmountMinor: order.totalAmountMinor,
      currency: order.currency,
      items: order.items.map((item) => ({ ...item })),
    },
  };
}

export function parseOrderCreatedEvent(value: unknown): OrderCreatedEvent {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('eventId' in value) ||
    !('eventType' in value) ||
    !('schemaVersion' in value) ||
    !('occurredAt' in value) ||
    !('order' in value) ||
    typeof value.eventId !== 'string' ||
    value.eventType !== ORDER_CREATED_EVENT_TYPE ||
    value.schemaVersion !== ORDER_CREATED_SCHEMA_VERSION ||
    typeof value.occurredAt !== 'string' ||
    typeof value.order !== 'object' ||
    value.order === null ||
    !('id' in value.order) ||
    typeof value.order.id !== 'string'
  ) {
    throw new Error('invalid commerce.order.created.v1 event');
  }

  return value as OrderCreatedEvent;
}
