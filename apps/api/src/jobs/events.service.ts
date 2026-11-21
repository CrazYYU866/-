import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Database } from '../database/database.module';

type Executor = Pick<Database, 'execute'>;

export interface DomainEvent {
  type: string;
  orderId?: string | null;
  orgId?: string | null;
  /** Кому адресовано (для push и центра уведомлений). */
  userIds?: string[];
  payload?: Record<string, unknown>;
}

/** Доменные события (outbox). Пишутся в транзакции с изменением; доставку делает модуль уведомлений. */
@Injectable()
export class EventsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async emit(e: DomainEvent, tx?: Executor): Promise<void> {
    const ids = e.userIds ?? [];
    await (tx ?? this.db).execute(sql`
      INSERT INTO domain_events (type, order_id, org_id, user_ids, payload)
      VALUES (${e.type}, ${e.orderId ?? null}, ${e.orgId ?? null},
        ${ids.length ? sql`ARRAY[${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}]` : sql`'{}'::uuid[]`},
        ${JSON.stringify(e.payload ?? {})}::jsonb)`);
  }
}
