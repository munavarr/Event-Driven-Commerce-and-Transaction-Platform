import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { CacheModule } from '../cache/cache.module.js';
import { OrderService } from './order.service.js';

@Module({
  imports: [DatabaseModule, CacheModule],
  providers: [OrderService],
  exports: [OrderService],
})
export class OrdersModule {}
