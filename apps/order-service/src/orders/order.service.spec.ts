import { RpcException } from '@nestjs/microservices';
import { type Knex } from 'knex';
import { describe, expect, it } from 'vitest';
import { OrderService } from './order.service.js';
import { OrderCacheService } from '../cache/order-cache.service.js';

type Row = Record<string, unknown>;

function createDatabase(
  options: {
    failItemInsert?: boolean;
    inventory?: Record<string, number>;
  } = {},
): {
  db: Knex;
  orders: Row[];
  items: Row[];
  inventory: Row[];
  outbox: Row[];
  transactionConfigs: Array<Knex.TransactionConfig | undefined>;
} {
  const orders: Row[] = [];
  const items: Row[] = [];
  const inventory: Row[] = Object.entries(
    options.inventory ?? { keyboard: 10 },
  ).map(([product_id, available_quantity]) => ({
    product_id,
    available_quantity,
  }));
  const outbox: Row[] = [];
  const transactionConfigs: Array<Knex.TransactionConfig | undefined> = [];

  const connection = (
    targetOrders: Row[],
    targetItems: Row[],
    targetInventory: Row[],
    targetOutbox: Row[],
  ) => {
    const query = (table: string) => {
      const rows =
        table === 'orders'
          ? targetOrders
          : table === 'order_items'
            ? targetItems
            : table === 'outbox_events'
              ? targetOutbox
              : targetInventory;
      let filtered = rows;
      const applyWhere = (
        columnOrFields: string | Row,
        operatorOrValue?: unknown,
        comparisonValue?: unknown,
      ) => {
        filtered = filtered.filter((row) => {
          if (typeof columnOrFields === 'string') {
            if (comparisonValue === undefined) {
              return row[columnOrFields] === operatorOrValue;
            }
            if (operatorOrValue === '>=') {
              return Number(row[columnOrFields]) >= Number(comparisonValue);
            }
            throw new Error(
              `unsupported test comparison: ${String(operatorOrValue)}`,
            );
          }
          return Object.entries(columnOrFields).every(
            ([column, expected]) => row[column] === expected,
          );
        });
        return scopedQuery;
      };
      const scopedQuery = {
        where: applyWhere,
        first: async () => filtered[0],
        orderBy: async () => filtered,
        forUpdate: () => scopedQuery,
        update: (updates: Row) => {
          for (const row of filtered) {
            Object.assign(row, updates);
          }
          return {
            returning: async (column: string) =>
              filtered.map((row) => ({ [column]: row[column] })),
          };
        },
        decrement: (column: string, amount: number) => {
          for (const row of filtered) {
            row[column] = Number(row[column]) - amount;
          }
          return {
            returning: async (returningColumn: string) =>
              filtered.map((row) => ({
                [returningColumn]: row[returningColumn],
              })),
          };
        },
      };
      return {
        insert: async (values: Row | Row[]) => {
          if (
            table === 'orders' &&
            targetOrders.some(
              (row) =>
                row.idempotency_key ===
                (Array.isArray(values) ? values[0] : values).idempotency_key,
            )
          ) {
            throw Object.assign(new Error('duplicate idempotency key'), {
              code: '23505',
            });
          }
          if (table === 'order_items' && options.failItemInsert) {
            throw new Error('forced item insertion failure');
          }
          const insertRows = Array.isArray(values) ? values : [values];
          rows.push(...insertRows.map((row) => ({ ...row })));
        },
        where: applyWhere,
      };
    };
    return query;
  };

  const db = connection(orders, items, inventory, outbox) as unknown as Knex;
  db.transaction = async (callback, config) => {
    transactionConfigs.push(config);
    const orderCopy = orders.map((row) => ({ ...row }));
    const itemCopy = items.map((row) => ({ ...row }));
    const inventoryCopy = inventory.map((row) => ({ ...row }));
    const outboxCopy = outbox.map((row) => ({ ...row }));
    const result = await callback(
      connection(
        orderCopy,
        itemCopy,
        inventoryCopy,
        outboxCopy,
      ) as unknown as Knex.Transaction,
    );
    orders.splice(0, orders.length, ...orderCopy);
    items.splice(0, items.length, ...itemCopy);
    inventory.splice(0, inventory.length, ...inventoryCopy);
    outbox.splice(0, outbox.length, ...outboxCopy);
    return result;
  };
  return { db, orders, items, inventory, outbox, transactionConfigs };
}

function createHistoryDatabase(rows: Row[]): Knex {
  return ((table: string) => {
    if (table !== 'orders') {
      throw new Error(`unexpected table: ${table}`);
    }
    let result = [...rows];
    const query = {
      select: () => query,
      where: (column: string, value: unknown) => {
        result = result.filter((row) => row[column] === value);
        return query;
      },
      whereRaw: (_sql: string, [createdAt, id]: [string, string]) => {
        result = result.filter((row) => {
          const rowTime = new Date(String(row.created_at)).getTime();
          const cursorTime = new Date(createdAt).getTime();
          return (
            rowTime < cursorTime || (rowTime === cursorTime && row.id < id)
          );
        });
        return query;
      },
      orderBy: () => query,
      limit: async (count: number) =>
        result
          .sort((left, right) => {
            const timeDifference =
              new Date(String(right.created_at)).getTime() -
              new Date(String(left.created_at)).getTime();
            return (
              timeDifference || String(right.id).localeCompare(String(left.id))
            );
          })
          .slice(0, count),
    };
    return query;
  }) as unknown as Knex;
}

const validRequest = {
  customerId: '550e8400-e29b-41d4-a716-446655440000',
  idempotencyKey: 'checkout-001',
  currency: 'inr',
  items: [
    {
      productId: 'keyboard',
      productName: 'Keyboard',
      quantity: 2,
      unitPriceMinor: '1499',
    },
  ],
};

describe('OrderService', () => {
  it('uses cache-aside reads and invalidates after a committed write', async () => {
    const database = createDatabase();
    const cachedOrders: string[] = [];
    const invalidations: Array<{ id: string; customerId: string }> = [];
    const cache = {
      order: async <T>(id: string, load: () => Promise<T>) => {
        cachedOrders.push(id);
        return load();
      },
      history: async <T>(
        _customerId: string,
        _variant: unknown,
        load: () => Promise<T>,
      ) => load(),
      invalidateOrder: async (id: string, customerId: string) => {
        invalidations.push({ id, customerId });
      },
    } as unknown as OrderCacheService;
    const service = new OrderService(database.db, cache);

    const created = await service.create(validRequest);
    await service.getById(created.order.id);

    expect(cachedOrders).toEqual([created.order.id]);
    expect(invalidations).toEqual([
      { id: created.order.id, customerId: validRequest.customerId },
    ]);
  });

  it('avoids the database snapshot transaction on a repeated cached order read', async () => {
    const database = createDatabase();
    const entries = new Map<string, unknown>();
    const cache = {
      order: async <T>(id: string, load: () => Promise<T>) => {
        if (entries.has(id)) return entries.get(id) as T;
        const value = await load();
        entries.set(id, value);
        return value;
      },
      history: async <T>(
        _customerId: string,
        _variant: unknown,
        load: () => Promise<T>,
      ) => load(),
      invalidateOrder: async () => undefined,
    } as unknown as OrderCacheService;
    const service = new OrderService(database.db, cache);
    const created = await service.create(validRequest);
    const transactionsBeforeReads = database.transactionConfigs.length;

    await service.getById(created.order.id);
    await service.getById(created.order.id);

    expect(database.transactionConfigs).toHaveLength(
      transactionsBeforeReads + 1,
    );
  });

  it('commits an order and its items together, calculating totals server-side', async () => {
    const database = createDatabase();
    const service = new OrderService(database.db);

    const result = await service.create(validRequest);

    expect(result.replayed).toBe(false);
    expect(result.order.totalAmountMinor).toBe('2998');
    expect(database.orders).toHaveLength(1);
    expect(database.items).toHaveLength(1);
    expect(database.inventory).toEqual([
      { product_id: 'keyboard', available_quantity: 8 },
    ]);
    expect(database.items[0]?.line_total_minor).toBe('2998');
    expect(database.outbox).toHaveLength(1);
    expect(database.outbox[0]).toMatchObject({
      topic: 'commerce.order.created.v1',
      message_key: expect.any(String),
    });
  });

  it('rolls back the parent order when inserting its items fails', async () => {
    const database = createDatabase({ failItemInsert: true });
    const service = new OrderService(database.db);

    await expect(service.create(validRequest)).rejects.toThrow(
      'forced item insertion failure',
    );
    expect(database.orders).toEqual([]);
    expect(database.items).toEqual([]);
    expect(database.inventory).toEqual([
      { product_id: 'keyboard', available_quantity: 10 },
    ]);
  });

  it('rejects an order when the atomic inventory decrement finds insufficient stock', async () => {
    const database = createDatabase({ inventory: { keyboard: 1 } });
    const service = new OrderService(database.db);

    await expect(service.create(validRequest)).rejects.toBeInstanceOf(
      RpcException,
    );
    expect(database.orders).toEqual([]);
    expect(database.items).toEqual([]);
    expect(database.inventory).toEqual([
      { product_id: 'keyboard', available_quantity: 1 },
    ]);
  });

  it('returns the existing order for an identical idempotent retry', async () => {
    const database = createDatabase();
    const service = new OrderService(database.db);

    const first = await service.create(validRequest);
    const retry = await service.create(validRequest);

    expect(retry.replayed).toBe(true);
    expect(retry.order.id).toBe(first.order.id);
    expect(database.orders).toHaveLength(1);
    expect(database.items).toHaveLength(1);
  });

  it('rejects reuse of an idempotency key with a changed payload', async () => {
    const database = createDatabase();
    const service = new OrderService(database.db);

    await service.create(validRequest);
    await expect(
      service.create({
        ...validRequest,
        items: [{ ...validRequest.items[0], quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(RpcException);
    expect(database.orders).toHaveLength(1);
  });

  it('rejects malformed input before opening a transaction', async () => {
    const database = createDatabase();
    const service = new OrderService(database.db);

    await expect(
      service.create({ ...validRequest, items: [] }),
    ).rejects.toBeInstanceOf(RpcException);
    expect(database.orders).toEqual([]);
  });

  it('reads an order and its items from one read-only MVCC snapshot', async () => {
    const database = createDatabase();
    const service = new OrderService(database.db);
    const created = await service.create(validRequest);

    await expect(service.getById(created.order.id)).resolves.toMatchObject({
      id: created.order.id,
      items: [expect.objectContaining({ productId: 'keyboard' })],
    });
    expect(database.transactionConfigs.at(-1)).toEqual({
      isolationLevel: 'repeatable read',
      readOnly: true,
    });
  });

  it('locks an order before validating and applying a status transition', async () => {
    const database = createDatabase();
    const service = new OrderService(database.db);
    const created = await service.create(validRequest);

    const changed = await service.transitionStatus(
      created.order.id,
      'PENDING',
      'CONFIRMED',
    );

    expect(changed.status).toBe('CONFIRMED');
    await expect(
      service.transitionStatus(created.order.id, 'PENDING', 'CANCELLED'),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('uses a deterministic keyset cursor for customer history', async () => {
    const customerId = validRequest.customerId;
    const service = new OrderService(
      createHistoryDatabase([
        {
          id: '550e8400-e29b-41d4-a716-446655440001',
          customer_id: customerId,
          status: 'CONFIRMED',
          total_amount_minor: '300',
          currency: 'INR',
          created_at: '2026-10-13T10:00:00.000Z',
        },
        {
          id: '550e8400-e29b-41d4-a716-446655440002',
          customer_id: customerId,
          status: 'CONFIRMED',
          total_amount_minor: '200',
          currency: 'INR',
          created_at: '2026-10-13T10:00:00.000Z',
        },
        {
          id: '550e8400-e29b-41d4-a716-446655440003',
          customer_id: customerId,
          status: 'PENDING',
          total_amount_minor: '100',
          currency: 'INR',
          created_at: '2026-10-12T10:00:00.000Z',
        },
      ]),
    );

    const firstPage = await service.listCustomerOrders({
      customerId,
      pageSize: 2,
    });
    expect(firstPage.orders.map((order) => order.id)).toEqual([
      '550e8400-e29b-41d4-a716-446655440002',
      '550e8400-e29b-41d4-a716-446655440001',
    ]);
    expect(firstPage.nextCursor).toBeTruthy();

    const secondPage = await service.listCustomerOrders({
      customerId,
      pageSize: 2,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.orders.map((order) => order.id)).toEqual([
      '550e8400-e29b-41d4-a716-446655440003',
    ]);
    expect(secondPage.nextCursor).toBeUndefined();
  });

  it('rejects malformed history cursors', async () => {
    const service = new OrderService(createHistoryDatabase([]));

    await expect(
      service.listCustomerOrders({
        customerId: validRequest.customerId,
        cursor: 'not-a-cursor',
      }),
    ).rejects.toBeInstanceOf(RpcException);
  });
});
