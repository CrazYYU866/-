import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { APP_ENV } from '../config/config.module';
import type { AppEnv } from '../config/env';
import { DB, type Database } from '../database/database.module';

type Executor = Pick<Database, 'execute'>;
export type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

/**
 * Отложенные задания в PostgreSQL. Задание создаётся в транзакции вместе с изменением данных,
 * поэтому таймер не теряется при сбое. Выборка — FOR UPDATE SKIP LOCKED: несколько экземпляров API
 * не выполнят одно задание дважды. Обработчики обязаны быть идемпотентными.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobsService.name);
  private readonly handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  async schedule(type: string, payload: Record<string, unknown>, runAt: Date, opts: { dedupeKey?: string; tx?: Executor } = {}): Promise<void> {
    const db = opts.tx ?? this.db;
    await db.execute(sql`
      INSERT INTO scheduled_jobs (type, payload, run_at, dedupe_key)
      VALUES (${type}, ${JSON.stringify(payload)}::jsonb, ${runAt.toISOString()}, ${opts.dedupeKey ?? null})
      ON CONFLICT (dedupe_key) WHERE status = 'pending' AND dedupe_key IS NOT NULL
      DO UPDATE SET run_at = EXCLUDED.run_at, payload = EXCLUDED.payload`);
  }

  async cancel(dedupeKey: string, tx?: Executor): Promise<void> {
    await (tx ?? this.db).execute(sql`UPDATE scheduled_jobs SET status = 'cancelled' WHERE dedupe_key = ${dedupeKey} AND status = 'pending'`);
  }

  /**
   * Выполнить созревшие задания. Возвращает число выполненных. В тестах вызывается напрямую.
   * Задание сначала «забирается» короткой транзакцией (status = running), затем выполняется вне её:
   * обработчик может ставить новое задание с тем же ключом, не упираясь в блокировку текущего.
   * Зависшие «running» (процесс упал) возвращаются в очередь через 5 минут.
   */
  async runDue(limit = 50): Promise<number> {
    await this.db.execute(sql`
      UPDATE scheduled_jobs SET status = 'pending', locked_at = NULL
      WHERE status = 'running' AND locked_at < now() - interval '5 minutes'`);
    let done = 0;
    for (let i = 0; i < limit; i++) {
      const res = await this.db.execute<{ id: number; type: string; payload: Record<string, unknown>; attempts: number }>(sql`
        UPDATE scheduled_jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
        WHERE id = (SELECT id FROM scheduled_jobs WHERE status = 'pending' AND run_at <= now()
                    ORDER BY run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id, type, payload, attempts`);
      const job = res.rows[0];
      if (!job) break;
      const handler = this.handlers.get(job.type);
      try {
        if (!handler) throw new Error(`Нет обработчика задания ${job.type}`);
        await handler(job.payload);
        await this.db.execute(sql`UPDATE scheduled_jobs SET status = 'done', done_at = now() WHERE id = ${job.id}`);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.logger.error(`Задание ${job.type}#${job.id}: ${message}`);
        const failed = job.attempts >= 5;
        await this.db.execute(sql`
          UPDATE scheduled_jobs SET last_error = ${message}, locked_at = NULL,
            status = ${failed ? 'failed' : 'pending'}, run_at = now() + (interval '5 seconds' * ${job.attempts})
          WHERE id = ${job.id}`);
      }
      done++;
    }
    return done;
  }

  onApplicationBootstrap(): void {
    if (this.env.NODE_ENV === 'test' || !this.env.JOBS_AUTORUN) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.runDue().catch((e: unknown) => this.logger.error(e)).finally(() => (this.running = false));
    }, 1000);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
