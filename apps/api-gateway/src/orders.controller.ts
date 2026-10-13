import {
  Body,
  Controller,
  Get,
  Inject,
  OnModuleInit,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, Observable } from 'rxjs';

interface OrderResponse {
  order: Order;
}

interface Order {
  orderId: string;
  customerId: string;
  status: string;
  totalAmountMinor: string;
  currency: string;
  idempotencyKey: string;
  items: OrderItem[];
}

interface OrderItem {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  unitPriceMinor: string;
  lineTotalMinor: string;
}

interface CreateOrderRequest {
  customerId: string;
  idempotencyKey: string;
  currency?: string;
  items: Array<{
    productId: string;
    productName: string;
    quantity: number;
    unitPriceMinor: string | number;
  }>;
}

interface OrderGrpcService {
  getOrder(data: { orderId: string }): Observable<OrderResponse>;
  listCustomerOrders(data: {
    customerId: string;
    status?: string;
    pageSize?: number;
    cursor?: string;
  }): Observable<{ orders: OrderSummary[]; nextCursor: string }>;
  createOrder(
    data: CreateOrderRequest,
  ): Observable<{ order: Order; replayed: boolean }>;
  transitionOrderStatus(data: {
    orderId: string;
    expectedStatus: string;
    nextStatus: string;
  }): Observable<Order>;
}

interface OrderSummary {
  orderId: string;
  status: string;
  totalAmountMinor: string;
  currency: string;
  createdAt: string;
}

@Controller('orders')
export class OrdersController implements OnModuleInit {
  private orderService!: OrderGrpcService;

  constructor(
    @Inject('ORDER_PACKAGE')
    private readonly grpcClient: ClientGrpc,
  ) {}

  onModuleInit() {
    this.orderService =
      this.grpcClient.getService<OrderGrpcService>('OrderService');
  }

  @Get()
  async listCustomerOrders(
    @Query('customerId') customerId: string,
    @Query('status') status?: string,
    @Query('pageSize') pageSize?: string,
    @Query('cursor') cursor?: string,
  ) {
    const parsedPageSize = pageSize === undefined ? undefined : Number(pageSize);
    return firstValueFrom(
      this.orderService.listCustomerOrders({
        customerId,
        status: status || undefined,
        pageSize: parsedPageSize,
        cursor: cursor || undefined,
      }),
    );
  }

  @Get(':id')
  async getOrder(@Param('id') id: string) {
    const response = await firstValueFrom(
      this.orderService.getOrder({ orderId: id }),
    );
    return response.order;
  }

  @Post()
  async createOrder(@Body() body: CreateOrderRequest) {
    return firstValueFrom(this.orderService.createOrder(body));
  }

  @Patch(':id/status')
  async transitionStatus(
    @Param('id') id: string,
    @Body() body: { expectedStatus: string; nextStatus: string },
  ) {
    return firstValueFrom(
      this.orderService.transitionOrderStatus({ orderId: id, ...body }),
    );
  }
}
