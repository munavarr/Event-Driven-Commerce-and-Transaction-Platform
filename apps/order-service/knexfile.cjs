const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const poolMin = Number(process.env.DB_POOL_MIN ?? 0);
const poolMax = Number(process.env.DB_POOL_MAX ?? 10);

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not configured');
}

if (
  !Number.isInteger(poolMin) ||
  !Number.isInteger(poolMax) ||
  poolMin < 0 ||
  poolMax <= 0 ||
  poolMin > poolMax
) {
  throw new Error('Set DB_POOL_MIN and DB_POOL_MAX to valid pool bounds');
}

module.exports = {
  development: {
    client: 'pg',
    connection: process.env.DATABASE_URL,
    pool: {
      min: poolMin,
      max: poolMax,
      acquireTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
    },
    migrations: {
      directory: './migrations',
      extension: 'cjs',
      tableName: 'knex_migrations',
    },
  },
};
