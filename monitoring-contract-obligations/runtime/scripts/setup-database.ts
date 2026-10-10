import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import type { Pool } from 'pg';
import { createDatabasePool } from '../src/infrastructure/database.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('Set DATABASE_URL in runtime/.env. See runtime/.env.example.');
}

async function migrateDatabase(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await runner({
      dbClient: client,
      dir: fileURLToPath(new URL('../migrations', import.meta.url)),
      direction: 'up',
      migrationsTable: 'monitoring_migrations',
      schema: 'public',
      migrationsSchema: 'public',
      checkOrder: true,
      singleTransaction: true,
      advisoryLockMode: 'wait',
      log: () => undefined,
    });
  } finally {
    client.release();
  }
}

const pool = createDatabasePool(databaseUrl);
try {
  await migrateDatabase(pool);
  console.log('PostgreSQL schema is ready.');
} finally {
  await pool.end();
}
