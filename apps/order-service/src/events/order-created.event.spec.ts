import { describe, expect, it } from 'vitest';
import {
  createOrderCreatedEvent,
  parseOrderCreatedEvent,
} from './order-created.event.js';

describe('OrderCreated event contract', () => {
  it('uses an explicit versioned schema and preserves money as strings', () => {
    const event = createOrderCreatedEvent(
      'event-1',
      {
        id: 'order-1', customerId: 'customer-1', status: 'PENDING',
        totalAmountMinor: '2998', currency: 'INR', idempotencyKey: 'checkout-1',
        items: [{ id: 'item-1', productId: 'keyboard', productName: 'Keyboard', quantity: 2, unitPriceMinor: '1499', lineTotalMinor: '2998' }],
      },
      '2026-10-13T00:00:00.000Z',
    );

    expect(parseOrderCreatedEvent(event)).toEqual(event);
    expect(event).toMatchObject({
      eventType: 'commerce.order.created', schemaVersion: 1,
      orderId: 'order-1', order: { totalAmountMinor: '2998' },
    });
  });

  it('rejects a different event type or schema version', () => {
    expect(() => parseOrderCreatedEvent({
      eventId: 'event-1', eventType: 'commerce.order.created', schemaVersion: 2,
      occurredAt: '2026-10-13T00:00:00.000Z', orderId: 'order-1', order: { id: 'order-1' },
    })).toThrow('invalid commerce.order.created.v1 event');
  });
});
