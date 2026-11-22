import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { APP_ENV } from '../config/config.module';
import type { AppEnv } from '../config/env';
import { DB, type Database } from '../database/database.module';
import { PUSH_PROVIDER, type PushProvider } from './push.provider';
import { RealtimeGateway } from './realtime.gateway';
import { TEMPLATES } from './templates';

type EventRow = {
  id: number;
  type: string;
  order_id: string | null;
  user_ids: string[];
  payload: Record<string, unknown>;
};

/**
 * Доставка доменных событий: центр уведомлений, push и события в реальном времени (ТЗ §16).
 * Читает outbox (domain_events) пачками с SKIP LOCKED — несколько экземпляров не дублируют доставку.
 */
@Injectable()
export class NotificationsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(NotificationsService.name);
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(PUSH_PROVIDER) private readonly push: PushProvider,
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly realtime: RealtimeGateway,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.NODE_ENV === 'test' || !this.env.JOBS_AUTORUN) return;
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      this.processPending().catch((e: unknown) => this.logger.error(e)).finally(() => (this.busy = false));
    }, 1500);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async processPending(limit = 200): Promise<number> {
    const events = await this.db.transaction(async (tx) => {
      const res = await tx.execute<EventRow>(sql`
        SELECT id, type, order_id, user_ids, payload FROM domain_events WHERE processed_at IS NULL ORDER BY id LIMIT ${limit} FOR UPDATE SKIP LOCKED`);
      if (res.rows.length) {
        await tx.execute(sql`UPDATE domain_events SET processed_at = now() WHERE id IN (${sql.join(res.rows.map((r) => sql`${r.id}`), sql`, `)})`);
      }
      return res.rows;
    });
    for (const e of events) await this.deliver(e);
    return events.length;
  }

  private async deliver(e: EventRow): Promise<void> {
    if (e.order_id) this.realtime.toOrder(e.order_id, 'order.event', { type: e.type, orderId: e.order_id, payload: e.payload });
    const template = TEMPLATES[e.type];
    const users = [...new Set(e.user_ids ?? [])];
    if (!template || users.length === 0) return;
    const { title, body } = template(e.payload ?? {});
    for (const userId of users) {
      const res = await this.db.execute<{ id: number }>(sql`
        INSERT INTO notifications (user_id, type, title, body, order_id, payload)
        VALUES (${userId}, ${e.type}, ${title}, ${body}, ${e.order_id}, ${JSON.stringify(e.payload ?? {})}::jsonb) RETURNING id`);
      this.realtime.toUser(userId, 'notification', { id: res.rows[0]?.id, type: e.type, title, body, orderId: e.order_id, payload: e.payload });
      const tokens = await this.db.execute<{ token: string }>(sql`SELECT token FROM push_devices WHERE user_id = ${userId} AND active`);
      await this.push.send(tokens.rows.map((t) => t.token), { title, body, data: { type: e.type, orderId: e.order_id } });
    }
  }

  async list(userId: string, limit = 100) {
    const res = await this.db.execute(sql`
      SELECT id, type, title, body, order_id, payload, read_at, created_at FROM notifications WHERE user_id = ${userId} ORDER BY id DESC LIMIT ${limit}`);
    const unread = await this.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${userId} AND read_at IS NULL`);
    return { items: res.rows, unread: unread.rows[0]?.n ?? 0 };
  }

  async markRead(userId: string, ids: number[] | undefined, all: boolean | undefined): Promise<void> {
    if (all) await this.db.execute(sql`UPDATE notifications SET read_at = now() WHERE user_id = ${userId} AND read_at IS NULL`);
    else if (ids?.length) {
      await this.db.execute(sql`UPDATE notifications SET read_at = now() WHERE user_id = ${userId} AND read_at IS NULL AND id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
    }
  }

  /** Рассылка из админки. */
  async broadcast(audience: 'all_customers' | 'all_partners' | 'user', userId: string | undefined, title: string, body: string): Promise<number> {
    const users =
      audience === 'user'
        ? userId ? [userId] : []
        : audience === 'all_partners'
          ? (await this.db.execute<{ user_id: string }>(sql`SELECT DISTINCT user_id FROM organization_members WHERE status = 'active'`)).rows.map((r) => r.user_id)
          : (await this.db.execute<{ id: string }>(sql`SELECT id FROM users WHERE status = 'active' AND id NOT IN (SELECT user_id FROM organization_members WHERE status = 'active')`)).rows.map((r) => r.id);
    if (users.length === 0) return 0;
    await this.db.execute(sql`
      INSERT INTO domain_events (type, user_ids, payload)
      VALUES ('broadcast', ARRAY[${sql.join(users.map((u) => sql`${u}::uuid`), sql`, `)}], ${JSON.stringify({ title, body })}::jsonb)`);
    return users.length;
  }
}
