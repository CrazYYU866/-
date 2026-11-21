import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { runMigrations } from '../src/database/migrator';

describe('runMigrations', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });
  beforeEach(async () => {
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  });
  afterAll(async () => {
    await pool.end();
  });

  it('применяет миграции проекта один раз и пропускает при повторном запуске', async () => {
    const first = await runMigrations(pool);
    expect(first.applied).toContain('0001_foundation.sql');
    const second = await runMigrations(pool);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain('0001_foundation.sql');
    const { rows } = await pool.query<{ v: string }>('SELECT postgis_version() AS v');
    expect(rows[0]?.v).toBeTruthy();
  });

  it('отказывается применять изменённую уже применённую миграцию', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mig-'));
    await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE t_a (id int);');
    await runMigrations(pool, dir);
    await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE t_a (id bigint);');
    await expect(runMigrations(pool, dir)).rejects.toThrow(/содержимое изменилось/);
  });

  it('откатывает миграцию с ошибкой целиком', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mig-'));
    await writeFile(join(dir, '0001_bad.sql'), 'CREATE TABLE t_ok (id int); SELECT * FROM no_such_table;');
    await expect(runMigrations(pool, dir)).rejects.toThrow(/0001_bad\.sql/);
    const { rows } = await pool.query("SELECT to_regclass('public.t_ok') AS t");
    expect(rows[0].t).toBeNull();
  });
});
