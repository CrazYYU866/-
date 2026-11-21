import { Pool } from 'pg';
import { runMigrations } from '../src/database/migrator';

/** Пересоздаёт схему тестовой БД и применяет все миграции. */
export async function resetTestDatabase(): Promise<Pool> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool);
  return pool;
}
