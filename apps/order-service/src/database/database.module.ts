import {
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import knex, { Knex } from 'knex';
import { KNEX } from './database.constants.js';
import { DatabaseService } from './database.service.js';

export { KNEX } from './database.constants.js';

function getPoolSize(
  config: ConfigService,
  key: 'DB_POOL_MIN' | 'DB_POOL_MAX',
  defaultValue: number,
): number {
  const value = config.get<string>(key);

  if (value === undefined) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }

  return parsed;
}

@Injectable()
class DatabaseLifecycle implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseLifecycle.name);

  constructor(@Inject(KNEX) private readonly db: Knex) {}

  async onModuleInit() {
    await this.db.raw('SELECT 1');
    this.logger.log('PostgreSQL connection verified');
  }

  async onApplicationShutdown() {
    await this.db.destroy();
    this.logger.log('PostgreSQL connection pool closed');
  }
}

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: KNEX,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Knex => {
        const connection = config.get<string>('DATABASE_URL');

        if (!connection) {
          throw new Error('DATABASE_URL is not configured');
        }

        const min = getPoolSize(config, 'DB_POOL_MIN', 0);
        const max = getPoolSize(config, 'DB_POOL_MAX', 10);

        if (min > max || max === 0) {
          throw new Error(
            'DB_POOL_MIN must not exceed DB_POOL_MAX, and DB_POOL_MAX must be positive',
          );
        }

        return knex({
          client: 'pg',
          connection,
          pool: {
            min,
            max,
            acquireTimeoutMillis: 10_000,
            idleTimeoutMillis: 30_000,
          },
        });
      },
    },
    DatabaseLifecycle,
    DatabaseService,
  ],
  exports: [KNEX, DatabaseService],
})
export class DatabaseModule {}
