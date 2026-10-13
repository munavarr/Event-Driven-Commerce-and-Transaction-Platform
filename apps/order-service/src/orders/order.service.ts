import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { type Knex } from 'knex';
import { KNEX } from '../database/database.module.js';
import { OrderCacheService } from '../cache/order-cache.service.js';
import {
  createOrderCreatedEvent,
  ORDER_CREATED_TOPIC,
} from '../events/order-created.event.js';

export interface CreateOrderItemInput {
  productId: string;
  productName: string;
  quantity: number;
  unitPriceMinor: string | number;
}

export interface CreateOrderInput {
  customerId: string;
  idempotencyKey: string;
  currency?: string;
  items: CreateOrderItemInput[];
}

export interface OrderItem {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  unitPriceMinor: string;
  lineTotalMinor: string;
}

export interface Order {
  id: string;
  customerId: string;
  status: string;
  totalAmountMinor: string;
  currency: string;
  idempotencyKey: string;
  items: OrderItem[];
}

export interface CreateOrderResult {
  order: Order;
  replayed: boolean;
}

export interface OrderSummary {
  id: string;
  status: string;
  totalAmountMinor: string;
  currency: string;
  createdAt: string;
}

export interface ListCustomerOrdersInput {
  customerId: string;
  status?: string;
  pageSize?: number;
  cursor?: string;
}

export interface ListCustomerOrdersResult {
  orders: OrderSummary[];
  nextCursor?: string;
}

interface StoredOrder {
  id: string;
  customer_id: string;
  status: string;
  total_amount_minor: string | number;
  currency: string;
  idempotency_key: string;
  request_hash: string;
  created_at: Date | string;
}

interface StoredOrderItem {
  id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  unit_price_minor: string | number;
  line_total_minor: string | number;
}

interface ValidatedItem {
  productId: string;
  productName: string;
  quantity: number;
  unitPriceMinor: bigint;
  lineTotalMinor: bigint;
}

interface ValidatedCreateOrder {
  customerId: string;
  idempotencyKey: string;
  currency: string;
  items: ValidatedItem[];
  totalAmountMinor: bigint;
  requestHash: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MAX_MONEY_MINOR = 9_000_000_000_000_000n;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const CONSISTENT_READ_TRANSACTION = {
  isolationLevel: 'repeatable read',
  readOnly: true,
} as const;

@Injectable()
export class OrderService {
  constructor(
    @Inject(KNEX) private readonly db: Knex,
    @Optional() private readonly cache?: OrderCacheService,
  ) {}

  async create(input: CreateOrderInput): Promise<CreateOrderResult> {
    const request = this.validateCreateInput(input);

    try {
      const order = await this.db.transaction(async (trx) => {
        const orderId = randomUUID();
        await trx('orders').insert({
          id: orderId,
          customer_id: request.customerId,
          status: 'PENDING',
          total_amount_minor: request.totalAmountMinor.toString(),
          currency: request.currency,
          idempotency_key: request.idempotencyKey,
          request_hash: request.requestHash,
        });

        await this.reserveInventory(request.items, trx);

        await trx('order_items').insert(
          request.items.map((item) => ({
            id: randomUUID(),
            order_id: orderId,
            product_id: item.productId,
            product_name: item.productName,
            quantity: item.quantity,
            unit_price_minor: item.unitPriceMinor.toString(),
            line_total_minor: item.lineTotalMinor.toString(),
          })),
        );

        const order = await this.findById(orderId, trx);
        const eventId = randomUUID();
        await trx('outbox_events').insert({
          id: eventId,
          topic: ORDER_CREATED_TOPIC,
          message_key: order.id,
          payload: JSON.stringify(createOrderCreatedEvent(eventId, order)),
          headers: JSON.stringify({
            'content-type': 'application/json',
            'event-type': 'commerce.order.created',
            'schema-version': '1',
          }),
        });

        return order;
      });

      await this.invalidateOrder(order);
      return { order, replayed: false };
    } catch (error: unknown) {
      if (!this.isUniqueViolation(error)) {
        throw error;
      }

      const existing = await this.findStoredByIdempotencyKey(
        request.idempotencyKey,
      );
      if (!existing) {
        // A unique violation on another constraint is not an idempotency retry.
        throw error;
      }
      if (existing.request_hash !== request.requestHash) {
        throw this.rpcError(
          status.ALREADY_EXISTS,
          'idempotency key was already used with a different request',
        );
      }

      return { order: await this.getCachedById(existing.id), replayed: true };
    }
  }

  async getById(id: string): Promise<Order> {
    if (!UUID_PATTERN.test(id)) {
      throw this.rpcError(status.INVALID_ARGUMENT, 'orderId must be a UUID');
    }

    // findById performs two queries. A read-only REPEATABLE READ transaction gives
    // both queries one MVCC snapshot without acquiring a writer-blocking row lock.
    return this.getCachedById(id);
  }

  async listCustomerOrders(
    input: ListCustomerOrdersInput,
  ): Promise<ListCustomerOrdersResult> {
    if (!UUID_PATTERN.test(input.customerId)) {
      throw this.rpcError(status.INVALID_ARGUMENT, 'customerId must be a UUID');
    }
    if (input.status && !this.isOrderStatus(input.status)) {
      throw this.rpcError(status.INVALID_ARGUMENT, 'status is invalid');
    }
    const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
    if (
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > MAX_PAGE_SIZE
    ) {
      throw this.rpcError(
        status.INVALID_ARGUMENT,
        `pageSize must be between 1 and ${MAX_PAGE_SIZE}`,
      );
    }
    const cursor = input.cursor ? this.decodeCursor(input.cursor) : undefined;

    const queryOrders = async (): Promise<ListCustomerOrdersResult> => {
      let query = this.db<StoredOrder>('orders')
        .select('id', 'status', 'total_amount_minor', 'currency', 'created_at')
        .where('customer_id', input.customerId);
      if (input.status) {
        query = query.where('status', input.status);
      }
      if (cursor) {
        query = query.whereRaw('(created_at, id) < (?, ?)', [
          cursor.createdAt,
          cursor.id,
        ]);
      }
      const rows = await query
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(pageSize + 1);
      const page = rows.slice(0, pageSize);
      const last = page.at(-1);

      return {
        orders: page.map((row) => this.toOrderSummary(row)),
        nextCursor:
          rows.length > pageSize && last
            ? this.encodeCursor(last.created_at, last.id)
            : undefined,
      };
    };

    return this.cache
      ? this.cache.history(
          input.customerId,
          { status: input.status, pageSize, cursor: input.cursor },
          queryOrders,
        )
      : queryOrders();
  }

  async transitionStatus(
    id: string,
    expectedStatus: string,
    nextStatus: string,
  ): Promise<Order> {
    const allowed = new Map<string, ReadonlySet<string>>([
      ['PENDING', new Set(['CONFIRMED', 'CANCELLED', 'PAYMENT_FAILED'])],
      ['PAYMENT_FAILED', new Set(['CANCELLED'])],
    ]);
    if (!UUID_PATTERN.test(id)) {
      throw this.rpcError(status.INVALID_ARGUMENT, 'orderId must be a UUID');
    }
    if (!allowed.get(expectedStatus)?.has(nextStatus)) {
      throw this.rpcError(
        status.INVALID_ARGUMENT,
        'invalid order status transition',
      );
    }

    const order = await this.db.transaction(async (trx) => {
      // A plain SELECT would not protect the decision below. This row lock makes
      // concurrent transitions for one order wait, then re-check the new state.
      const order = await trx<StoredOrder>('orders')
        .where({ id })
        .forUpdate()
        .first();

      if (!order) {
        throw this.rpcError(status.NOT_FOUND, 'order not found');
      }
      if (order.status !== expectedStatus) {
        throw this.rpcError(
          status.FAILED_PRECONDITION,
          `order is ${order.status}, not ${expectedStatus}`,
        );
      }

      await trx('orders').where({ id }).update({ status: nextStatus });
      return this.findById(id, trx);
    });
    await this.invalidateOrder(order);
    return order;
  }

  private async findStoredByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<StoredOrder | undefined> {
    return this.db<StoredOrder>('orders')
      .where({ idempotency_key: idempotencyKey })
      .first();
  }

  private toOrderSummary(
    order: Pick<
      StoredOrder,
      'id' | 'status' | 'total_amount_minor' | 'currency' | 'created_at'
    >,
  ): OrderSummary {
    return {
      id: order.id,
      status: order.status,
      totalAmountMinor: String(order.total_amount_minor),
      currency: order.currency,
      createdAt: new Date(order.created_at).toISOString(),
    };
  }

  private encodeCursor(createdAt: Date | string, id: string): string {
    return Buffer.from(
      JSON.stringify({ createdAt: new Date(createdAt).toISOString(), id }),
    ).toString('base64url');
  }

  private decodeCursor(cursor: string): { createdAt: string; id: string } {
    try {
      const decoded: unknown = JSON.parse(
        Buffer.from(cursor, 'base64url').toString('utf8'),
      );
      if (
        typeof decoded !== 'object' ||
        decoded === null ||
        !('createdAt' in decoded) ||
        !('id' in decoded) ||
        typeof decoded.createdAt !== 'string' ||
        typeof decoded.id !== 'string' ||
        !UUID_PATTERN.test(decoded.id) ||
        Number.isNaN(Date.parse(decoded.createdAt))
      ) {
        throw new Error('invalid cursor');
      }
      return { createdAt: decoded.createdAt, id: decoded.id };
    } catch {
      throw this.rpcError(status.INVALID_ARGUMENT, 'cursor is invalid');
    }
  }

  private isOrderStatus(value: string): boolean {
    return ['PENDING', 'CONFIRMED', 'CANCELLED', 'PAYMENT_FAILED'].includes(
      value,
    );
  }

  private async reserveInventory(
    items: ValidatedItem[],
    trx: Knex.Transaction,
  ): Promise<void> {
    // Every checkout takes inventory row locks in the same order. The conditional
    // UPDATE is the availability check and decrement in one statement, so a stale
    // read can never overwrite another reservation.
    for (const item of [...items].sort((left, right) =>
      left.productId.localeCompare(right.productId),
    )) {
      const reserved = await trx('inventory')
        .where({ product_id: item.productId })
        .where('available_quantity', '>=', item.quantity)
        .decrement('available_quantity', item.quantity)
        .returning('product_id');

      if (reserved.length !== 1) {
        throw this.rpcError(
          status.RESOURCE_EXHAUSTED,
          `insufficient inventory for product ${item.productId}`,
        );
      }
    }
  }

  private async findById(
    id: string,
    connection: Knex = this.db,
  ): Promise<Order> {
    const order = await connection<StoredOrder>('orders').where({ id }).first();
    if (!order) {
      throw this.rpcError(status.NOT_FOUND, 'order not found');
    }
    const items = await connection<StoredOrderItem>('order_items')
      .where('order_id', id)
      .orderBy('product_id');

    return {
      id: order.id,
      customerId: order.customer_id,
      status: order.status,
      totalAmountMinor: String(order.total_amount_minor),
      currency: order.currency,
      idempotencyKey: order.idempotency_key,
      items: items.map((item) => ({
        id: item.id,
        productId: item.product_id,
        productName: item.product_name,
        quantity: item.quantity,
        unitPriceMinor: String(item.unit_price_minor),
        lineTotalMinor: String(item.line_total_minor),
      })),
    };
  }

  private async getCachedById(id: string): Promise<Order> {
    const load = () =>
      this.db.transaction(
        (trx) => this.findById(id, trx),
        CONSISTENT_READ_TRANSACTION,
      );
    return this.cache ? this.cache.order(id, load) : load();
  }

  private async invalidateOrder(order: Order): Promise<void> {
    // This runs after the transaction commits. A cache outage must never turn a
    // durable write into an error, and the short TTL bounds any missed eviction.
    await this.cache?.invalidateOrder(order.id, order.customerId);
  }

  private validateCreateInput(input: CreateOrderInput): ValidatedCreateOrder {
    if (!UUID_PATTERN.test(input.customerId)) {
      throw this.rpcError(status.INVALID_ARGUMENT, 'customerId must be a UUID');
    }
    if (!input.idempotencyKey || input.idempotencyKey.length > 128) {
      throw this.rpcError(
        status.INVALID_ARGUMENT,
        'idempotencyKey must be between 1 and 128 characters',
      );
    }
    const currency = (input.currency || 'INR').toUpperCase();
    if (!CURRENCY_PATTERN.test(currency)) {
      throw this.rpcError(status.INVALID_ARGUMENT, 'currency must be ISO-4217');
    }
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw this.rpcError(
        status.INVALID_ARGUMENT,
        'an order needs at least one item',
      );
    }

    const seenProducts = new Set<string>();
    const items = input.items.map((item) => {
      if (!item.productId || item.productId.length > 100) {
        throw this.rpcError(status.INVALID_ARGUMENT, 'productId is invalid');
      }
      if (!item.productName || item.productName.length > 200) {
        throw this.rpcError(status.INVALID_ARGUMENT, 'productName is invalid');
      }
      if (
        !Number.isInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > 100
      ) {
        throw this.rpcError(
          status.INVALID_ARGUMENT,
          'quantity must be between 1 and 100',
        );
      }
      if (seenProducts.has(item.productId)) {
        throw this.rpcError(
          status.INVALID_ARGUMENT,
          'productIds must be unique per order',
        );
      }
      seenProducts.add(item.productId);

      const unitPriceMinor = this.parseMinor(
        item.unitPriceMinor,
        'unitPriceMinor',
      );
      const lineTotalMinor = unitPriceMinor * BigInt(item.quantity);
      if (lineTotalMinor > MAX_MONEY_MINOR) {
        throw this.rpcError(status.INVALID_ARGUMENT, 'line total is too large');
      }
      return {
        productId: item.productId,
        productName: item.productName,
        quantity: item.quantity,
        unitPriceMinor,
        lineTotalMinor,
      };
    });
    const totalAmountMinor = items.reduce(
      (total, item) => total + item.lineTotalMinor,
      0n,
    );
    if (totalAmountMinor > MAX_MONEY_MINOR) {
      throw this.rpcError(status.INVALID_ARGUMENT, 'order total is too large');
    }

    const canonicalPayload = {
      customerId: input.customerId.toLowerCase(),
      currency,
      items: [...items]
        .sort((left, right) => left.productId.localeCompare(right.productId))
        .map((item) => ({
          productId: item.productId,
          productName: item.productName,
          quantity: item.quantity,
          unitPriceMinor: item.unitPriceMinor.toString(),
        })),
    };
    return {
      customerId: input.customerId,
      idempotencyKey: input.idempotencyKey,
      currency,
      items,
      totalAmountMinor,
      requestHash: createHash('sha256')
        .update(JSON.stringify(canonicalPayload))
        .digest('hex'),
    };
  }

  private parseMinor(value: string | number, field: string): bigint {
    const text = String(value);
    if (!/^(0|[1-9][0-9]*)$/.test(text)) {
      throw this.rpcError(
        status.INVALID_ARGUMENT,
        `${field} must be a non-negative integer`,
      );
    }
    const parsed = BigInt(text);
    if (parsed > MAX_MONEY_MINOR) {
      throw this.rpcError(status.INVALID_ARGUMENT, `${field} is too large`);
    }
    return parsed;
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '23505'
    );
  }

  private rpcError(code: status, message: string): RpcException {
    return new RpcException({ code, message });
  }
}
