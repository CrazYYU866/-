import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

/** Произвольная константа для advisory lock: не даёт двум процессам мигрировать одновременно. */
const MIGRATION_LOCK_ID = 7_310_042;

export const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Применяет SQL-миграции из папки по порядку имён. Каждая миграция — в своей транзакции.
 * Уже применённые миграции пропускаются; изменение содержимого применённой миграции — ошибка.
 */
export async function runMigrations(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<MigrationResult> {
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const done = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const file of files) {
      const sql = await readFile(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prev = done.get(file);
      if (prev !== undefined) {
        if (prev !== checksum) {
          throw new Error(`Миграция ${file} уже применена, но её содержимое изменилось. Создайте новую миграцию.`);
        }
        result.skipped.push(file);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        result.applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Ошибка в миграции ${file}: ${(err as Error).message}`);
      }
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}
