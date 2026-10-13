import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';

const ORDER_TTL_SECONDS = 60;
const HISTORY_TTL_SECONDS = 20;
const HISTORY_VERSION_TTL_SECONDS = HISTORY_TTL_SECONDS * 2;
const LOCK_TTL_MS = 1_000;
const LOCK_WAIT_MS = 200;
const LOCK_POLL_MS = 25;

@Injectable()
export class OrderCacheService implements OnApplicationShutdown {
  private readonly logger = new Logger(OrderCacheService.name);
  private readonly redis?: Redis;
  private readonly prefix: string;

  constructor(config: ConfigService) {
    const url = config.get<string>('REDIS_URL');
    this.prefix = config.get<string>('REDIS_KEY_PREFIX') ?? 'commerce:orders:';
    if (!url) {
      return;
    }

    this.redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 500,
      retryStrategy: () => null,
      enableOfflineQueue: false,
    });
    this.redis.on('error', (error: Error) =>
      this.logger.warn(`Redis unavailable; bypassing cache: ${error.message}`),
    );
  }

  async getOrLoad<T>(
    key: string,
    ttlSeconds: number,
    load: () => Promise<T>,
  ): Promise<T> {
    if (!this.redis) return load();

    const cached = await this.get<T>(key);
    if (cached !== undefined) return cached;

    const lockKey = `${key}:lock`;
    const owner = randomUUID();
    if (await this.acquireLock(lockKey, owner)) {
      try {
        // A peer may have populated it in the interval between GET and SET NX.
        const filled = await this.get<T>(key);
        if (filled !== undefined) return filled;

        const value = await load();
        await this.set(key, value, ttlSeconds);
        return value;
      } finally {
        await this.releaseLock(lockKey, owner);
      }
    }

    // Do not make callers wait indefinitely on a failed lock holder. A small,
    // bounded wait collapses normal bursts while preserving database availability.
    for (let elapsed = 0; elapsed < LOCK_WAIT_MS; elapsed += LOCK_POLL_MS) {
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
      const filled = await this.get<T>(key);
      if (filled !== undefined) return filled;
    }
    return load();
  }

  async order<T>(id: string, load: () => Promise<T>): Promise<T> {
    return this.getOrLoad(`order:${id}`, ORDER_TTL_SECONDS, load);
  }

  async history<T>(
    customerId: string,
    variant: unknown,
    load: () => Promise<T>,
  ): Promise<T> {
    const version = await this.customerVersion(customerId);
    // If the version read failed, do not guess at a version and accidentally
    // serve an older page. Going to PostgreSQL is the safe failure mode.
    if (version === undefined) return load();
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(variant))
      .digest('base64url');
    return this.getOrLoad(
      `history:${customerId}:v${version}:${fingerprint}`,
      HISTORY_TTL_SECONDS,
      load,
    );
  }

  async invalidateOrder(id: string, customerId: string): Promise<void> {
    if (!this.redis) return;
    await Promise.all([
      this.safe(() => this.redis!.del(this.key(`order:${id}`))),
      // Versioning invalidates every page/status/cursor variant without SCAN.
      this.incrementHistoryVersion(customerId),
    ]);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.redis) await this.redis.quit();
  }

  private async customerVersion(
    customerId: string,
  ): Promise<number | undefined> {
    if (!this.redis) return 0;
    const value = await this.safe(() =>
      this.redis!.get(this.key(`history-version:${customerId}`)),
    );
    if (value === undefined) return undefined;
    return Number(value ?? 0) || 0;
  }

  private async incrementHistoryVersion(customerId: string): Promise<void> {
    const key = this.key(`history-version:${customerId}`);
    await this.safe(async () => {
      await this.redis!.incr(key);
      await this.redis!.expire(key, HISTORY_VERSION_TTL_SECONDS);
    });
  }

  private async get<T>(key: string): Promise<T | undefined> {
    const value = await this.safe<string | null>(() =>
      this.redis!.get(this.key(key)),
    );
    if (!value) return undefined;
    try {
      return JSON.parse(value) as T;
    } catch {
      await this.safe(() => this.redis!.del(this.key(key)));
      return undefined;
    }
  }

  private async set<T>(
    key: string,
    value: T,
    ttlSeconds: number,
  ): Promise<void> {
    await this.safe(() =>
      this.redis!.set(this.key(key), JSON.stringify(value), 'EX', ttlSeconds),
    );
  }

  private async acquireLock(key: string, owner: string): Promise<boolean> {
    return (
      (await this.safe(() =>
        this.redis!.set(this.key(key), owner, 'PX', LOCK_TTL_MS, 'NX'),
      )) === 'OK'
    );
  }

  private async releaseLock(key: string, owner: string): Promise<void> {
    // Only its owner may release a lock; this avoids deleting a lock that expired
    // and was acquired by another process.
    await this.safe(() =>
      this.redis!.eval(
        'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0',
        1,
        this.key(key),
        owner,
      ),
    );
  }

  private key(value: string): string {
    return `${this.prefix}${value}`;
  }

  private async safe<T>(operation: () => Promise<T>): Promise<T | undefined> {
    try {
      if (this.redis!.status === 'wait') await this.redis!.connect();
      return await operation();
    } catch (error) {
      this.logger.debug(
        `Cache operation skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }
}
