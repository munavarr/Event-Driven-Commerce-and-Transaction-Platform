import { Module } from '@nestjs/common';
import { OrderCacheService } from './order-cache.service.js';

@Module({
  providers: [OrderCacheService],
  exports: [OrderCacheService],
})
export class CacheModule {}
