import { Inject, Injectable } from '@nestjs/common';
import { DB, type Database } from '../database/database.module';
import { adminAuditLog } from '../database/schema';

export interface AuditEntry {
  adminId: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  ip?: string | null;
}

type Tx = Pick<Database, 'insert'>;

/** Журнал действий администраторов (ТЗ §19). Запись — в той же транзакции, что и само действие. */
@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async log(entry: AuditEntry, tx: Tx = this.db): Promise<void> {
    await tx.insert(adminAuditLog).values({
      adminId: entry.adminId,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
      reason: entry.reason ?? null,
      ip: entry.ip ?? null,
    });
  }
}
