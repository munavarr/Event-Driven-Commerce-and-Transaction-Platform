import { randomUUID } from 'node:crypto';
import { RpcException } from '@nestjs/microservices';
import knex, { type Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrderService } from '../src/orders/order.service.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithTestDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithTestDatabase('OrderService concurrency', () => {
  let firstConnection: Knex;
  let secondConnection: Knex;
  const customerId = randomUUID();
  const productId = `concurrency-${randomUUID()}`;
  const decrementProductId = `lost-update-${randomUUID()}`;
  const transitionProductId = `transition-${randomUUID()}`;

  beforeAll(async () => {
    const config: Knex.Config = {
      client: 'pg',
      connection: testDatabaseUrl,
      pool: { min: 0, max: 1 },
    };
    firstConnection = knex(config);
    secondConnection = knex(config);

    const inventoryTable = await firstConnection.raw<{ rows: Array<{ exists: boolean }> }>(
      "SELECT to_regclass('public.inventory') IS NOT NULL AS exists",
    );
    if (!inventoryTable.rows[0]?.exists) {
      throw new Error(
        'The concurrency test database is not migrated. Run db:migrate against TEST_DATABASE_URL.',
      );
    }

    await firstConnection('inventory').insert({
      product_id: productId,
      available_quantity: 1,
    });
    await firstConnection('inventory').insert({
      product_id: decrementProductId,
      available_quantity: 10,
    });
    await firstConnection('inventory').insert({
      product_id: transitionProductId,
      available_quantity: 1,
    });
  });

  afterAll(async () => {
    if (!firstConnection || !secondConnection) {
      return;
    }
    await firstConnection('orders').where({ customer_id: customerId }).delete();
    await firstConnection('inventory').where({ product_id: productId }).delete();
    await firstConnection('inventory')
      .where({ product_id: decrementProductId })
      .delete();
    await firstConnection('inventory')
      .where({ product_id: transitionProductId })
      .delete();
    await Promise.all([firstConnection.destroy(), secondConnection.destroy()]);
  });

  it('accepts only one of two simultaneous requests for the final unit', async () => {
    const firstService = new OrderService(firstConnection);
    const secondService = new OrderService(secondConnection);
    const baseRequest = {
      customerId,
      currency: 'INR',
      items: [
        {
          productId,
          productName: 'Concurrency test product',
          quantity: 1,
          unitPriceMinor: '100',
        },
      ],
    };

    const results = await Promise.allSettled([
      firstService.create({ ...baseRequest, idempotencyKey: randomUUID() }),
      secondService.create({ ...baseRequest, idempotencyKey: randomUUID() }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected?.reason).toBeInstanceOf(RpcException);

    const stock = await firstConnection<{ available_quantity: number }>('inventory')
      .where({ product_id: productId })
      .first();
    expect(stock?.available_quantity).toBe(0);
    const orderCount = await firstConnection('orders')
      .where({ customer_id: customerId })
      .count<{ count: string }>('* as count')
      .first();
    expect(Number(orderCount?.count)).toBe(1);
  });

  it('preserves both concurrent decrements of the same inventory row', async () => {
    const decrement = (connection: Knex, quantity: number) =>
      connection('inventory')
        .where({ product_id: decrementProductId })
        .where('available_quantity', '>=', quantity)
        .decrement('available_quantity', quantity)
        .returning('available_quantity');

    const [firstResult, secondResult] = await Promise.all([
      decrement(firstConnection, 2),
      decrement(secondConnection, 3),
    ]);

    expect(firstResult).toHaveLength(1);
    expect(secondResult).toHaveLength(1);
    const stock = await firstConnection<{ available_quantity: number }>('inventory')
      .where({ product_id: decrementProductId })
      .first();
    expect(stock?.available_quantity).toBe(5);
  });

  it('allows only one competing transition out of PENDING', async () => {
    const firstService = new OrderService(firstConnection);
    const secondService = new OrderService(secondConnection);
    const created = await firstService.create({
      customerId,
      idempotencyKey: randomUUID(),
      currency: 'INR',
      items: [
        {
          productId: transitionProductId,
          productName: 'State transition test product',
          quantity: 1,
          unitPriceMinor: '100',
        },
      ],
    });

    const results = await Promise.allSettled([
      firstService.transitionStatus(created.order.id, 'PENDING', 'CONFIRMED'),
      secondService.transitionStatus(created.order.id, 'PENDING', 'CANCELLED'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected?.reason).toBeInstanceOf(RpcException);

    const storedOrder = await firstConnection<{ status: string }>('orders')
      .select('status')
      .where({ id: created.order.id })
      .first();
    expect(storedOrder?.status).toMatch(/^(CONFIRMED|CANCELLED)$/);
  });
});
