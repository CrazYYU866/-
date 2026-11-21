import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES, type OrderStatus } from '@kovsh/contracts';
import { sql } from 'drizzle-orm';
import { AppException } from '../common/app-exception';
import { DB, type Database } from '../database/database.module';
import { EventsService } from '../jobs/events.service';
import { JobsService } from '../jobs/jobs.service';

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export type OrderRow = {
  id: string;
  number: string;
  customer_id: string;
  agent_org_id: string | null;
  category_id: string;
  region_id: string;
  site_address: string;
  site_comment: string | null;
  site_lat: number;
  site_lng: number;
  requirements: Record<string, unknown>;
  urgency: 'urgent' | 'scheduled';
  first_start_at: Date;
  last_end_at: Date;
  total_hours: number;
  status: OrderStatus;
  version: number;
  km_price_kopecks: string;
  hour_price_kopecks: string;
  rent_kopecks: string;
  customer_delivery_kopecks: string;
  customer_delivery_km: string;
  total_kopecks: string;
  prepayment_kopecks: string;
  partner_delivery_km: string | null;
  partner_delivery_kopecks: string | null;
  partner_org_id: string | null;
  equipment_unit_id: string | null;
  managing_member_id: string | null;
  search_started_at: Date | null;
  search_deadline_at: Date | null;
  search_round: number;
  prepaid_at: Date | null;
  timezone: string;
};

export type ShiftRow = {
  id: string;
  order_id: string;
  seq: number;
  starts_at: Date;
  ends_at: Date;
  hours: number;
  work_date: string;
  operator_user_id: string | null;
  operator_member_id: string | null;
  status: 'pending' | 'en_route' | 'arrived' | 'in_progress' | 'finished' | 'cancelled';
};

export type Actor = { type: 'customer' | 'partner' | 'operator' | 'system' | 'admin'; id?: string | null };

/** Допустимые переходы статусов заказа (ТЗ §11 + решения 02–04). */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  searching: ['offered', 'search_failed', 'refund_pending', 'cancelled'],
  offered: ['searching', 'awaiting_prepayment', 'awaiting_assignment', 'search_failed', 'refund_pending', 'cancelled'],
  search_failed: [],
  accepted: [],
  awaiting_prepayment: ['awaiting_assignment', 'cancelled_unpaid', 'cancelled', 'searching'],
  cancelled_unpaid: [],
  awaiting_assignment: ['assigned', 'searching', 'cancelled'],
  assigned: ['en_route', 'awaiting_assignment', 'searching', 'cancelled'],
  en_route: ['arrived', 'searching', 'cancelled'],
  arrived: ['in_progress', 'searching', 'cancelled'],
  in_progress: ['assigned', 'awaiting_assignment', 'awaiting_completion_confirmation', 'cancelled'],
  awaiting_completion_confirmation: ['awaiting_final_payment', 'disputed'],
  awaiting_final_payment: ['completed', 'disputed'],
  completed: [],
  cancelled: [],
  refund_pending: ['cancelled'],
  disputed: ['awaiting_final_payment', 'completed', 'cancelled', 'refund_pending'],
};

export const ACTIVE_PARTNER_STATUSES: OrderStatus[] = ['awaiting_prepayment', 'awaiting_assignment', 'assigned', 'en_route', 'arrived', 'in_progress'];

@Injectable()
export class OrderCore {
  constructor(
    @Inject(DB) readonly db: Database,
    readonly jobs: JobsService,
    readonly events: EventsService,
  ) {}

  /** Загрузить заказ с блокировкой строки (все изменения заказа — строго последовательно). */
  async lock(tx: Tx, orderId: string): Promise<OrderRow> {
    const res = await tx.execute<OrderRow>(sql`
      SELECT o.*, ST_Y(o.site_point::geometry) AS site_lat, ST_X(o.site_point::geometry) AS site_lng, r.timezone
      FROM orders o JOIN regions r ON r.id = o.region_id WHERE o.id = ${orderId} FOR UPDATE OF o`);
    const row = res.rows[0];
    if (!row) throw new AppException(ERROR_CODES.NOT_FOUND, 'Заказ не найден', HttpStatus.NOT_FOUND);
    return row;
  }

  async get(orderId: string, db: Pick<Database, 'execute'> = this.db): Promise<OrderRow> {
    const res = await db.execute<OrderRow>(sql`
      SELECT o.*, ST_Y(o.site_point::geometry) AS site_lat, ST_X(o.site_point::geometry) AS site_lng, r.timezone
      FROM orders o JOIN regions r ON r.id = o.region_id WHERE o.id = ${orderId}`);
    const row = res.rows[0];
    if (!row) throw new AppException(ERROR_CODES.NOT_FOUND, 'Заказ не найден', HttpStatus.NOT_FOUND);
    return row;
  }

  async shifts(orderId: string, db: Pick<Database, 'execute'> = this.db): Promise<ShiftRow[]> {
    const res = await db.execute<ShiftRow>(sql`SELECT * FROM order_shifts WHERE order_id = ${orderId} ORDER BY seq`);
    return res.rows.map((s) => ({ ...s, work_date: typeof s.work_date === 'string' ? s.work_date : new Date(s.work_date).toISOString().slice(0, 10) }));
  }

  /** Переход статуса с проверкой допустимости, записью истории и увеличением версии. */
  async transition(
    tx: Tx,
    order: OrderRow,
    to: OrderStatus,
    actor: Actor,
    opts: { reason?: string | null; meta?: Record<string, unknown>; patch?: SQLPatch; shiftId?: string | null } = {},
  ): Promise<void> {
    if (order.status !== to && !TRANSITIONS[order.status].includes(to)) {
      throw new AppException(ERROR_CODES.ORDER_STATUS_CONFLICT, `Действие недоступно в статусе «${order.status}»`, HttpStatus.CONFLICT, {
        from: order.status,
        to,
      });
    }
    const sets = [sql`status = ${to}`, sql`version = version + 1`, ...(opts.patch ?? [])];
    await tx.execute(sql`UPDATE orders SET ${sql.join(sets, sql`, `)} WHERE id = ${order.id}`);
    await tx.execute(sql`
      INSERT INTO order_status_history (order_id, shift_id, from_status, to_status, actor_type, actor_id, reason, meta)
      VALUES (${order.id}, ${opts.shiftId ?? null}, ${order.status}, ${to}, ${actor.type}, ${actor.id ?? null},
        ${opts.reason ?? null}, ${opts.meta ? JSON.stringify(opts.meta) : null}::jsonb)`);
    order.status = to;
  }

  /** Освободить технику и машинистов по незавершённым сменам (возврат в поиск, отмена). */
  async releaseResources(tx: Tx, orderId: string, reason: 'cancelled' | 'replaced'): Promise<void> {
    await tx.execute(sql`UPDATE unit_bookings SET status = 'released' WHERE order_id = ${orderId} AND status = 'active'`);
    await tx.execute(sql`
      UPDATE operator_day_assignments SET status = ${reason}, ended_at = now()
      WHERE order_id = ${orderId} AND status = 'active'
        AND shift_id IN (SELECT id FROM order_shifts WHERE order_id = ${orderId} AND status <> 'finished')`);
    await tx.execute(sql`
      UPDATE order_shifts SET operator_user_id = NULL, operator_member_id = NULL, status = 'pending', assign_deadline_at = NULL
      WHERE order_id = ${orderId} AND status NOT IN ('finished', 'cancelled')`);
  }

  async cancelTimers(tx: Tx, orderId: string): Promise<void> {
    await tx.execute(sql`
      UPDATE scheduled_jobs SET status = 'cancelled'
      WHERE status = 'pending' AND (payload->>'orderId') = ${orderId} AND type <> 'notify'`);
  }

  /** Сотрудники компании, которым приходят предложения и уведомления по заказам (Р-4, П-8). */
  async partnerStaff(orgId: string, db: Pick<Database, 'execute'> = this.db): Promise<string[]> {
    const res = await db.execute<{ user_id: string }>(sql`
      SELECT user_id FROM organization_members WHERE org_id = ${orgId} AND status = 'active'
        AND role IN ('owner', 'manager', 'dispatcher')`);
    return res.rows.map((r) => r.user_id);
  }

  async operatorsOf(orderId: string, db: Pick<Database, 'execute'> = this.db): Promise<string[]> {
    const res = await db.execute<{ operator_user_id: string }>(sql`
      SELECT DISTINCT operator_user_id FROM order_shifts WHERE order_id = ${orderId} AND operator_user_id IS NOT NULL`);
    return res.rows.map((r) => r.operator_user_id);
  }

  async partnerIncident(tx: Tx, orgId: string, orderId: string | null, type: string, meta?: Record<string, unknown>): Promise<void> {
    await tx.execute(sql`INSERT INTO partner_incidents (org_id, order_id, type, meta) VALUES (${orgId}, ${orderId}, ${type}, ${meta ? JSON.stringify(meta) : null}::jsonb)`);
  }

  async assignmentLog(
    tx: Tx,
    e: { orderId: string; shiftId?: string | null; orgId: string; unitId?: string | null; operatorUserId?: string | null; kind: string; actorId?: string | null; reason?: string | null },
  ): Promise<void> {
    await tx.execute(sql`
      INSERT INTO order_assignments (order_id, shift_id, org_id, unit_id, operator_user_id, kind, actor_id, reason)
      VALUES (${e.orderId}, ${e.shiftId ?? null}, ${e.orgId}, ${e.unitId ?? null}, ${e.operatorUserId ?? null}, ${e.kind}, ${e.actorId ?? null}, ${e.reason ?? null})`);
  }
}

export type SQLPatch = ReturnType<typeof sql>[];
