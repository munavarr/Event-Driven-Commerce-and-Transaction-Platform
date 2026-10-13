import { Inject, Injectable } from '@nestjs/common';
import { type Knex } from 'knex';
import { KNEX } from './database.module.js';

@Injectable()
export class DatabaseService {
  constructor(@Inject(KNEX) private readonly db: Knex) {}

  async checkConnection() {
    const result = await this.db.raw(
      'SELECT current_database() AS database, version() AS version',
    );

    return result.rows[0];
  }
}
