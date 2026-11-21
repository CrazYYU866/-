import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES, type OperatorStatus, type ReportIncident, type StatusEvents } from '@kovsh/contracts';
import { sql } from 'drizzle-orm';
import { AppException } from '../common/app-exception';
import type { OrgContext } from '../organizations/org-context.guard';
import { SettingsService } from '../settings/settings.service';
import { OrderCore, type ShiftRow } from './order-core';

const NEXT: Record<ShiftRow['status'], OperatorStatus | null> = {
  pending: 'en_route', en_route: 'arrived', arrived: 'in_progress', in_progress: 'finished', finished: null, cancelled: null,
};

export interface EventResult {
  clientEventId: string;
  result: 'applied' | 'duplicate' | 'ignored';
  reason?: string;
}

/** Действия машиниста (Р-17, Р-18, П-15): кнопки статусов работают и без GPS, и без интернета. */
@Injectable()
export class OperatorService {
  constructor(
    private readonly core: OrderCore,
    private readonly settings: SettingsService,
  ) {}

  async myOrders(org: OrgContext, userId: string) {
    const res = await this.core.db.execute<{ order_id: string; number: string; seq: number; starts_at: Date; ends_at: Date; status: string; site_address: string; category: string }>(sql`
      SELECT s.order_id, o.number, s.seq, s.starts_at, s.ends_at, s.status, o.site_address, c.name AS category
      FROM order_shifts s JOIN orders o ON o.id = s.order_id JOIN equipment_categories c ON c.id = o.category_id
      WHERE s.operator_user_id = ${userId} AND o.partner_org_id = ${org.orgId}
        AND o.status NOT IN ('cancelled', 'cancelled_unpaid', 'search_failed')
      ORDER BY s.starts_at`);
    return res.rows.map((r) => ({
      orderId: r.order_id, number: Number(r.number), shiftSeq: r.seq, start: new Date(r.starts_at).toISOString(),
      end: new Date(r.ends_at).toISOString(), shiftStatus: r.status, siteAddress: r.site_address, category: r.category,
    }));
  }

  /**
   * Машинист назначен на заказ сейчас или был назначен раньше (заказ отменён или его сняли):
   * во втором случае события принимаются и помечаются «не применено», чтобы офлайн-очередь телефона очистилась (П-15).
   */
  async assertAssigned(org: OrgContext, userId: string, orderId: string): Promise<void> {
    const res = await this.core.db.execute<{ ok: boolean }>(sql`
      SELECT true AS ok FROM order_shifts s JOIN orders o ON o.id = s.order_id
      WHERE s.order_id = ${orderId} AND s.operator_user_id = ${userId} AND o.partner_org_id = ${org.orgId}
      UNION ALL
      SELECT true FROM order_assignments a WHERE a.order_id = ${orderId} AND a.operator_user_id = ${userId} AND a.org_id = ${org.orgId}
      LIMIT 1`);
    if (!res.rows[0]) throw new AppException(ERROR_CODES.NOT_FOUND, 'Заказ не найден', HttpStatus.NOT_FOUND);
  }

  /**
   * Пачка офлайн-событий. Идемпотентно по clientEventId; применяются по порядку времени на телефоне.
   * Хранятся время телефона и время сервера; координаты или причина их отсутствия.
   * Статус, пришедший после отмены заказа, не применяется (П-15).
   */
  async applyEvents(org: OrgContext, userId: string, orderId: string, dto: StatusEvents): Promise<EventResult[]> {
    const results: EventResult[] = [];
    const events = [...dto.events].sort((a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime());
    for (const e of events) {
      results.push(await this.core.db.transaction(async (tx) => {
        const dup = await tx.execute<{ id: number }>(sql`SELECT id FROM order_status_history WHERE client_event_id = ${e.clientEventId}`);
        if (dup.rows[0]) return { clientEventId: e.clientEventId, result: 'duplicate' as const };
        const order = await this.core.lock(tx, orderId);
        if (order.partner_org_id !== org.orgId) {
          return { clientEventId: e.clientEventId, result: 'ignored' as const, reason: 'Заказ снят с компании или отменён' };
        }
        const shifts = await this.core.shifts(orderId, tx);
        const shift = shifts.find((s) => s.operator_user_id === userId && s.status !== 'finished' && s.status !== 'cancelled');
        if (!shift) return { clientEventId: e.clientEventId, result: 'ignored' as const, reason: 'Нет активной смены' };
        if (!['assigned', 'en_route', 'arrived', 'in_progress', 'awaiting_assignment'].includes(order.status)) {
          return { clientEventId: e.clientEventId, result: 'ignored' as const, reason: `Заказ в статусе «${order.status}»` };
        }
        if (NEXT[shift.status] !== e.status) {
          return { clientEventId: e.clientEventId, result: 'ignored' as const, reason: `Из «${shift.status}» нельзя перейти в «${e.status}»` };
        }
        await tx.execute(sql`UPDATE order_shifts SET status = ${e.status} WHERE id = ${shift.id}`);
        const isLast = shifts.filter((s) => s.status !== 'cancelled').every((s) => s.id === shift.id || s.status === 'finished');
        let orderTo = order.status;
        if (e.status === 'finished') {
          await tx.execute(sql`UPDATE operator_day_assignments SET status = 'done', ended_at = now() WHERE shift_id = ${shift.id} AND status = 'active'`);
          await tx.execute(sql`UPDATE unit_bookings SET status = 'released' WHERE order_id = ${orderId} AND status = 'active' AND upper(period) <= ${new Date(shift.ends_at).toISOString()}::timestamptz AND lower(period) >= ${new Date(shift.starts_at).toISOString()}::timestamptz`);
          if (isLast) orderTo = 'awaiting_completion_confirmation';
          else orderTo = shifts.find((s) => s.seq > shift.seq && s.status === 'pending')?.operator_user_id ? 'assigned' : 'awaiting_assignment';
        } else {
          orderTo = e.status;
        }
        const point = e.point ? sql`ST_SetSRID(ST_MakePoint(${e.point.lng}, ${e.point.lat}), 4326)::geography` : sql`NULL`;
        const patch = orderTo === 'awaiting_completion_confirmation' ? [sql`completion_reported_at = now()`] : [];
        if (orderTo !== order.status) {
          await this.core.transition(tx, order, orderTo, { type: 'operator', id: userId }, { shiftId: shift.id, patch });
        }
        // Отдельная запись события машиниста с данными устройства.
        await tx.execute(sql`
          INSERT INTO order_status_history (order_id, shift_id, from_status, to_status, actor_type, actor_id, client_event_id,
            device_recorded_at, point, location_unavailable_reason, reason)
          VALUES (${orderId}, ${shift.id}, ${shift.status}, ${'shift:' + e.status}, 'operator', ${userId}, ${e.clientEventId},
            ${e.recordedAt}, ${point}, ${e.point ? null : e.locationUnavailableReason ?? 'unknown'}, NULL)`);
        if (orderTo === 'awaiting_completion_confirmation') {
          const hours = await this.settings.get('completion_auto_confirm_hours');
          await this.core.jobs.schedule('auto_complete', { orderId }, new Date(Date.now() + hours * 3_600_000), { dedupeKey: `order:${orderId}:autocomplete`, tx });
        }
        await this.core.events.emit({ type: `order.${e.status}`, orderId, orgId: org.orgId, userIds: [order.customer_id], payload: { shiftId: shift.id } }, tx);
        return { clientEventId: e.clientEventId, result: 'applied' as const };
      }));
    }
    return results;
  }

  /** «Сообщить о поломке или проблеме» (Р-17): уведомление диспетчерам; при поломке компания организует замену (Р-3). */
  async reportIncident(org: OrgContext, userId: string, orderId: string, dto: ReportIncident): Promise<{ id: string }> {
    await this.assertAssigned(org, userId, orderId);
    const res = await this.core.db.execute<{ id: string }>(sql`
      INSERT INTO order_incidents (order_id, reported_by, type, comment, file_ids)
      VALUES (${orderId}, ${userId}, ${dto.type}, ${dto.comment ?? null},
        ${dto.fileIds.length ? sql`ARRAY[${sql.join(dto.fileIds.map((f) => sql`${f}::uuid`), sql`, `)}]` : sql`'{}'::uuid[]`})
      RETURNING id`);
    await this.core.events.emit({ type: 'order.incident', orderId, orgId: org.orgId, userIds: await this.core.partnerStaff(org.orgId), payload: { type: dto.type, comment: dto.comment ?? null } });
    return { id: res.rows[0]?.id as string };
  }
}
