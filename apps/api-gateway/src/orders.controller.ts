import {
  Controller,
  Get,
  Inject,
  OnModuleInit,
  Param,
} from '@nestjs/common';
import type {
  ClientGrpc,
} from '@nestjs/microservices';
import { firstValueFrom, Observable } from 'rxjs';

interface OrderResponse {
  orderId: string;
  status: string;
}

interface OrderGrpcService {
  getOrder(data: { orderId: string }): Observable<OrderResponse>;
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

  @Get(':id')
  async getOrder(@Param('id') id: string) {
    return firstValueFrom(
      this.orderService.getOrder({ orderId: id }),
    );
  }
}