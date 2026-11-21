import { Pool } from 'pg';
import { loadEnv } from '../config/env';
import { runMigrations } from './migrator';

async function main(): Promise<void> {
  const env = loadEnv();
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  try {
    const { applied, skipped } = await runMigrations(pool);
    console.log(`Миграции: применено ${applied.length}, пропущено ${skipped.length}`);
    applied.forEach((m) => console.log(`  + ${m}`));
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
