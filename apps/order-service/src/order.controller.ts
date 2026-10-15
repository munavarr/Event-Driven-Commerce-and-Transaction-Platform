import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { OrderService } from './orders/order.service.js';
import type { CreateOrderInput } from './orders/order.service.js';

@Controller()
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  @GrpcMethod('OrderService', 'GetOrder')
  async getOrder(data: { orderId: string }) {
    const order = await this.orderService.getById(data.orderId);
    return this.toGrpcOrder(order);
  }

  @GrpcMethod('OrderService', 'ListCustomerOrders')
  async listCustomerOrders(data: {
    customerId: string;
    status?: string;
    pageSize?: number;
    cursor?: string;
  }) {
    const result = await this.orderService.listCustomerOrders(data);
    return {
      orders: result.orders.map((order) => ({
        orderId: order.id,
        status: order.status,
        totalAmountMinor: order.totalAmountMinor,
        currency: order.currency,
        createdAt: order.createdAt,
      })),
      nextCursor: result.nextCursor ?? '',
    };
  }

  @GrpcMethod('OrderService', 'CreateOrder')
  async createOrder(data: CreateOrderInput) {
    const result = await this.orderService.create(data);
    return { order: this.toGrpcOrder(result.order), replayed: result.replayed };
  }

  private toGrpcOrder(order: Awaited<ReturnType<OrderService['getById']>>) {
    return {
      orderId: order.id,
      customerId: order.customerId,
      status: order.status,
      totalAmountMinor: order.totalAmountMinor,
      currency: order.currency,
      idempotencyKey: order.idempotencyKey,
      items: order.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        productName: item.productName,
        quantity: item.quantity,
        unitPriceMinor: item.unitPriceMinor,
        lineTotalMinor: item.lineTotalMinor,
      })),
    };
  }
}
