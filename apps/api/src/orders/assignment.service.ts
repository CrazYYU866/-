import { HttpStatus, Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ERROR_CODES } from '@kovsh/contracts';
import { sql } from 'drizzle-orm';
import { AppException } from '../common/app-exception';
import { ROUTING, type RoutingProvider } from '../geo/routing.provider';
import type { OrgContext } from '../organizations/org-context.guard';
import { SettingsService } from '../settings/settings.service';
import { MatchingService } from './matching.service';
import { OrderCore, type OrderRow, type ShiftRow, type Tx } from './order-core';

export interface AvailableOperator {
  memberId: string;
  userId: string;
  fullName: string | null;
  free: boolean;
  /** Занят в этот день другим заказом (без подробностей — П-10). */
  busy: boolean;
}

const conflict = (code: string, message: string) => new AppException(code, message, HttpStatus.CONFLICT);

/**
 * После принятия: предоплата (Н-8), назначение машиниста за 10 минут (Р-7), замены (Р-3, Р-8, Р-16, Л-6),
 * возврат в общий поиск (Р-3, Р-7, Р-16, К-8).
 */
@Injectable()
export class AssignmentService implements OnModuleInit {
  constructor(
    private readonly core: OrderCore,
    private readonly matching: MatchingService,
    private readonly settings: SettingsService,
    @Inject(ROUTING) private readonly routing: RoutingProvider,
  ) {}

  onModuleInit(): void {
    this.core.jobs.register('prepayment_timeout', (p) => this.prepaymentTimeout(String(p['orderId'])));
    this.core.jobs.register('assignment_reminder', (p) => this.assignmentReminder(String(p['orderId']), Number(p['minute'])));
    this.core.jobs.register('assignment_deadline', (p) => this.assignmentDeadline(String(p['orderId'])));
    this.core.jobs.register('replacement_deadline', (p) => this.replacementDeadline(String(p['orderId'])));
    this.core.jobs.register('shift_assign_deadline', (p) => this.shiftAssignDeadline(String(p['orderId']), String(p['shiftId'])));
  }

  // ── Предоплата ────────────────────────────────────────────────────────────

  /** Предоплата поступила (вызывается модулем платежей). Отсчёт 10 минут на машиниста — с этого момента (Н-8). */
  async confirmPrepayment(orderId: string): Promise<void> {
    await this.core.db.transaction(async (tx) => {
      const order = await this.core.lock(tx, orderId);
      if (order.status !== 'awaiting_prepayment' || order.prepaid_at) return;
      const deadlineMin = await this.settings.get('assignment_deadline_min');
      const deadline = new Date(Date.now() + deadlineMin * 60_000);
      await this.core.jobs.cancel(`order:${orderId}:prepay`, tx);
      await this.core.transition(tx, order, 'awaiting_assignment', { type: 'system' }, {
        patch: [sql`prepaid_at = now()`, sql`assignment_deadline_at = ${deadline.toISOString()}`],
      });
      await this.matching.scheduleAssignmentTimers(tx, orderId, deadline);
      await this.scheduleLaterShiftDeadlines(tx, orderId);
      // Исполнителю об оплате не сообщаем (ТЗ §14, §16): он получает «назначьте машиниста».
      await this.core.events.emit({ type: 'order.prepaid', orderId, userIds: [order.customer_id] }, tx);
      if (order.partner_org_id) {
        await this.core.events.emit({ type: 'order.assign_operator', orderId, orgId: order.partner_org_id, userIds: await this.core.partnerStaff(order.partner_org_id, tx), payload: { deadline: deadline.toISOString() } }, tx);
      }
    });
  }

  /** 10 минут на предоплату истекли: заказ отменяется, исполнитель освобождается, новый поиск не запускается (Н-8). */
  async prepaymentTimeout(orderId: string): Promise<void> {
    await this.core.db.transaction(async (tx) => {
      const order = await this.core.lock(tx, orderId);
      if (order.status !== 'awaiting_prepayment' || order.prepaid_at) return;
      await this.core.releaseResources(tx, orderId, 'cancelled');
      await this.core.cancelTimers(tx, orderId);
      await this.core.transition(tx, order, 'cancelled_unpaid', { type: 'system' }, {
        reason: 'Предоплата не поступила вовремя',
        patch: [sql`cancelled_at = now()`, sql`cancelled_by = 'system'`, sql`cancellation_reason = 'Предоплата не поступила'`],
      });
      const staff = order.partner_org_id ? await this.core.partnerStaff(order.partner_org_id, tx) : [];
      await this.core.events.emit({ type: 'order.cancelled', orderId, orgId: order.partner_org_id, userIds: [order.customer_id, ...staff], payload: { reason: 'unpaid' } }, tx);
    });
  }

  // ── Назначение машиниста ──────────────────────────────────────────────────

  async assignmentReminder(orderId: string, minute: number): Promise<void> {
    const order = await this.core.get(orderId);
    if (!['awaiting_assignment', 'assigned'].includes(order.status) || !order.partner_org_id) return;
    const unassigned = (await this.core.shifts(orderId)).some((s) => s.status === 'pending' && !s.operator_user_id);
    if (!unassigned) return;
    await this.core.events.emit({ type: 'order.assign_reminder', orderId, orgId: order.partner_org_id, userIds: await this.core.partnerStaff(order.partner_org_id), payload: { minute } });
  }

  /**
   * Истекли 10 минут на назначение (Р-7, П-6, С-28).
   * Первая смена без машиниста — заказ возвращается в общий поиск.
   * Первая назначена, но не все дни многодневного заказа — фиксируем и уведомляем компанию и администрацию (С-28).
   */
  async assignmentDeadline(orderId: string): Promise<void> {
    await this.core.db.transaction(async (tx) => {
      const order = await this.core.lock(tx, orderId);
      if (!order.partner_org_id || !['awaiting_assignment', 'assigned'].includes(order.status)) return;
      const pending = (await this.core.shifts(orderId, tx)).filter((s) => s.status === 'pending');
      const first = pending[0];
      if (order.status === 'awaiting_assignment' && first && !first.operator_user_id) {
        await this.core.partnerIncident(tx, order.partner_org_id, orderId, 'assignment_timeout');
        await this.returnToSearch(tx, order, { type: 'system' }, 'Машинист не назначен вовремя');
        return;
      }
      const unassigned = pending.filter((s) => !s.operator_user_id);
      if (unassigned.length > 0) {
        await this.core.partnerIncident(tx, order.partner_org_id, orderId, 'assignment_timeout', { shiftIds: unassigned.map((s) => s.id) });
        await this.core.events.emit({
          type: 'order.shifts_unassigned', orderId, orgId: order.partner_org_id, userIds: await this.core.partnerStaff(order.partner_org_id, tx),
          payload: { shiftIds: unassigned.map((s) => s.id), admin: true },
        }, tx);
      }
    });
  }

  /** Свободные машинисты компании на смену (Р-6): активные, проверенные, без другого заказа в этот день. */
  async availableOperators(org: OrgContext, orderId: string, shiftId?: string): Promise<{ shiftId: string; workDate: string; operators: AvailableOperator[] }> {
    const order = await this.core.get(orderId);
    this.assertPartner(order, org);
    const shift = await this.targetShift(orderId, shiftId);
    const res = await this.core.db.execute<{ member_id: string; user_id: string; full_name: string | null; busy: boolean }>(sql`
      SELECT m.id AS member_id, m.user_id, u.full_name,
        EXISTS (SELECT 1 FROM operator_day_assignments d WHERE d.user_id = m.user_id AND d.work_date = ${shift.work_date}::date AND d.status = 'active') AS busy
      FROM organization_members m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = ${org.orgId} AND m.status = 'active' AND m.can_operate AND m.operator_verification = 'approved'
      ORDER BY u.full_name NULLS LAST`);
    return {
      shiftId: shift.id,
      workDate: shift.work_date,
      operators: res.rows.map((r) => ({ memberId: r.member_id, userId: r.user_id, fullName: r.full_name, busy: r.busy, free: !r.busy })),
    };
  }

  /** Назначение без подтверждения машиниста (Р-9). Повторно — замена машиниста (Р-8). */
  async assignOperator(org: OrgContext, actorUserId: string, orderId: string, memberId: string, shiftId?: string): Promise<void> {
    await this.core.db.transaction(async (tx) => {
      const order = await this.core.lock(tx, orderId);
      this.assertPartner(order, org);
      if (!['awaiting_assignment', 'assigned', 'en_route', 'arrived', 'in_progress'].includes(order.status)) {
        throw conflict(ERROR_CODES.ORDER_STATUS_CONFLICT, 'Назначение сейчас недоступно');
      }
      const shift = await this.targetShift(orderId, shiftId, tx);
      if (shift.status !== 'pending') throw conflict(ERROR_CODES.ORDER_STATUS_CONFLICT, 'Смена уже началась');
      const member = await this.eligibleOperator(tx, org.orgId, memberId);
      const previous = shift.operator_user_id;
      if (previous === member.user_id) return;

      if (previous) {
        await tx.execute(sql`UPDATE operator_day_assignments SET status = 'replaced', ended_at = now() WHERE shift_id = ${shift.id} AND status = 'active'`);
      }
      try {
        await tx.execute(sql`SAVEPOINT op`);
        await tx.execute(sql`
          INSERT INTO operator_day_assignments (user_id, work_date, order_id, shift_id, org_id, assigned_by)
          VALUES (${member.user_id}, ${shift.work_date}::date, ${orderId}, ${shift.id}, ${org.orgId}, ${actorUserId})`);
        await tx.execute(sql`RELEASE SAVEPOINT op`);
      } catch (e) {
        if (((e as { cause?: { code?: string } }).cause ?? (e as { code?: string })).code !== '23505') throw e;
        throw conflict(ERROR_CODES.OPERATOR_BUSY, 'У машиниста уже есть заказ в этот день');
      }
      await tx.execute(sql`UPDATE order_shifts SET operator_user_id = ${member.user_id}, operator_member_id = ${member.id} WHERE id = ${shift.id}`);
      await this.core.assignmentLog(tx, {
        orderId, shiftId: shift.id, orgId: org.orgId, unitId: order.equipment_unit_id, operatorUserId: member.user_id,
        kind: previous ? 'operator_replaced' : 'operator_assigned', actorId: actorUserId,
      });

      if (order.status === 'awaiting_assignment') {
        const shifts = await this.core.shifts(orderId, tx);
        const next = shifts.find((s) => s.status === 'pending');
        if (next?.operator_user_id) {
          await this.core.transition(tx, order, 'assigned', { type: 'partner', id: actorUserId }, { shiftId: shift.id, patch: [sql`replacement_deadline_at = NULL`] });
          await this.core.jobs.cancel(`order:${orderId}:replace`, tx);
        }
      }
      // Все дни назначены — таймер 10 минут и напоминания больше не нужны (С-28).
      if ((await this.core.shifts(orderId, tx)).every((s) => s.status !== 'pending' || s.operator_user_id)) {
        await this.core.jobs.cancel(`order:${orderId}:assign`, tx);
        for (const m of await this.settings.get('assignment_reminder_minutes')) await this.core.jobs.cancel(`order:${orderId}:remind:${m}`, tx);
      }
      await this.core.jobs.cancel(`shift:${shift.id}:assign`, tx);
      await this.core.events.emit({ type: 'order.operator_assigned', orderId, orgId: org.orgId, userIds: [member.user_id], payload: { shiftId: shift.id } }, tx);
      await this.core.events.emit({
        type: previous ? 'order.operator_changed' : 'order.operator_assigned_customer', orderId, userIds: [order.customer_id],
        payload: { shiftId: shift.id, operatorUserId: member.user_id },
      }, tx);
      if (previous) await this.core.events.emit({ type: 'order.operator_unassigned', orderId, userIds: [previous], payload: { shiftId: shift.id } }, tx);
    });
  }

  /** Отказ машиниста — только до «Выехал» (П-7). Компании 10 минут на замену, затем общий поиск (Л-6). */
  async operatorDecline(org: OrgContext, userId: string, orderId: string, reason: string): Promise<void> {
    await this.core.db.transaction(async (tx) => {
      const order = await this.core.lock(tx, orderId);
      if (order.partner_org_id !== org.orgId) throw new AppException(ERROR_CODES.NOT_FOUND, 'Заказ не найден', HttpStatus.NOT_FOUND);
      const shifts = (await this.core.shifts(orderId, tx)).filter((s) => s.operator_user_id === userId);
      if (shifts.length === 0) throw new AppException(ERROR_CODES.NOT_FOUND, 'Заказ не найден', HttpStatus.NOT_FOUND);
      const pending = shifts.filter((s) => s.status === 'pending');
      if (pending.length === 0 || shifts.some((s) => ['en_route', 'arrived', 'in_progress'].includes(s.status))) {
        throw conflict(ERROR_CODES.ORDER_STATUS_CONFLICT, 'После выезда отказаться нельзя — сообщите о проблеме диспетчеру');
      }
      for (const s of pending) {
        await tx.execute(sql`UPDATE operator_day_assignments SET status = 'declined', ended_at = now() WHERE shift_id = ${s.id} AND status = 'active'`);
        await tx.execute(sql`UPDATE order_shifts SET operator_user_id = NULL, operator_member_id = NULL WHERE id = ${s.id}`);
        await this.core.assignmentLog(tx, { orderId, shiftId: s.id, orgId: org.orgId, operatorUserId: userId, kind: 'operator_declined', actorId: userId, reason });
      }
      await this.core.partnerIncident(tx, org.orgId, orderId, 'operator_declined', { userId, reason });
      if (order.status === 'assigned') await this.awaitInternalReplacement(tx, order, { type: 'operator', id: userId }, `Машинист отказался: ${reason}`);
      await this.core.events.emit({ type: 'order.operator_declined', orderId, orgId: org.orgId, userIds: await this.core.partnerStaff(org.orgId, tx), payload: { userId, reason } }, tx);
    });
  }

  async replacementDeadline(orderId: string): Promise<void> {
    await this.core.db.transaction(async (tx) => {
      const order = await this.core.lock(tx, orderId);
      if (order.status !== 'awaiting_assignment' || !order.partner_org_id || !order.prepaid_at) return;
      const next = (await this.core.shifts(orderId, tx)).find((s) => s.status === 'pending');
      if (next?.operator_user_id) return;
      await this.core.partnerIncident(tx, order.partner_org_id, orderId, 'replacement_timeout');
      await this.returnToSearch(tx, order, { type: 'system' }, 'Компания не обеспечила замену вовремя');
    });
  }

  /**
   * Последующие смены: машинист — не позже чем за 24 часа (Л-2).
   * Что делать, если не назначен, не утверждено (М-4): фиксируем и уведомляем компанию и администрацию.
   */
  async shiftAssignDeadline(orderId: string, shiftId: string): Promise<void> {
    await this.core.db.transaction(async (tx) => {
      const order = await this.core.lock(tx, orderId);
      const shift = (await this.core.shifts(orderId, tx)).find((s) => s.id === shiftId);
      if (!shift || shift.operator_user_id || shift.status !== 'pending' || !order.partner_org_id) return;
      await this.core.partnerIncident(tx, order.partner_org_id, orderId, 'assignment_timeout', { shiftId });
      await this.core.events.emit({ type: 'order.shift_unassigned', orderId, orgId: order.partner_org_id, userIds: await this.core.partnerStaff(order.partner_org_id, tx), payload: { shiftId, admin: true } }, tx);
    });
  }

  // ── Замена техники ────────────────────────────────────────────────────────

  async replacementUnits(org: OrgContext, orderId: string) {
    const order = await this.core.get(orderId);
    this.assertPartner(order, org);
    const res = await this.core.db.execute<{ id: string; brand: string; model: string; reg_number: string | null }>(sql`
      SELECT u.id, u.brand, u.model, u.reg_number FROM equipment_units u
      WHERE u.org_id = ${org.orgId} AND u.category_id = ${order.category_id} AND u.id <> ${order.equipment_unit_id}
        AND u.verification_status = 'approved' AND u.archived_at IS NULL ORDER BY u.brand, u.model`);
    return res.rows;
  }

  /**
   * Замена техники из парка компании (Р-3): та же категория, характеристики не ниже заказанных, свободна.
   * Цена заказчика не меняется (Н-21); доставка исполнителя пересчитывается от новой базы (Н-2).
   */
  async replaceUnit(org: OrgContext, actorUserId: string, orderId: string, unitId: string): Promise<void> {
    const pre = await this.core.get(orderId);
    this.assertPartner(pre, org);
    const point = await this.matching.unitPoint(unitId);
    const route = await this.routing.route(point, { lat: pre.site_lat, lng: pre.site_lng });
    await this.core.db.transaction(async (tx) => {
      const order = await this.core.lock(tx, orderId);
      if (!['awaiting_prepayment', 'awaiting_assignment', 'assigned', 'en_route', 'arrived', 'in_progress'].includes(order.status)) {
        throw conflict(ERROR_CODES.ORDER_STATUS_CONFLICT, 'Замена сейчас недоступна');
      }
      const reqs = Object.entries(order.requirements).map(([key, value]) => {
        if (value !== null && typeof value === 'object' && 'min' in value) return sql`(attributes->>${key})::numeric >= ${Number((value as { min: number }).min)}`;
        if (typeof value === 'boolean') return sql`(attributes->${key}) = ${JSON.stringify(value)}::jsonb`;
        return sql`(attributes->>${key}) = ${String(value)}`;
      });
      const ok = await tx.execute<{ id: string }>(sql`
        SELECT id FROM equipment_units WHERE id = ${unitId} AND org_id = ${org.orgId} AND category_id = ${order.category_id}
          AND verification_status = 'approved' AND archived_at IS NULL ${sql.join(reqs.map((c) => sql` AND ${c}`), sql``)}`);
      if (!ok.rows[0]) throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'Эта техника не подходит для заказа', HttpStatus.BAD_REQUEST);

      await tx.execute(sql`UPDATE unit_bookings SET status = 'released' WHERE order_id = ${orderId} AND status = 'active'`);
      const shifts = await this.core.shifts(orderId, tx);
      if (!(await this.matching.tryBook(tx, unitId, orderId, shifts))) throw conflict(ERROR_CODES.OFFER_UNAVAILABLE, 'Эта техника занята на время заказа');
      const kmTenths = Math.round(route.distanceMeters / 100);
      const delivery = Math.round((kmTenths * 2 * Number(order.km_price_kopecks)) / 10);
      await tx.execute(sql`
        UPDATE orders SET equipment_unit_id = ${unitId}, partner_delivery_km = ${kmTenths / 10}, partner_delivery_kopecks = ${delivery}, version = version + 1
        WHERE id = ${orderId}`);
      await this.core.assignmentLog(tx, { orderId, orgId: org.orgId, unitId, kind: 'unit_replaced', actorId: actorUserId });
      await tx.execute(sql`
        INSERT INTO order_status_history (order_id, from_status, to_status, actor_type, actor_id, reason, meta)
        VALUES (${orderId}, ${order.status}, ${order.status}, 'partner', ${actorUserId}, 'Замена техники', ${JSON.stringify({ unitId })}::jsonb)`);
      await this.core.events.emit({ type: 'order.unit_changed', orderId, userIds: [order.customer_id], payload: { unitId } }, tx);
    });
  }

  // ── Возврат в общий поиск ────────────────────────────────────────────────

  /** «Не можем выполнить» — компания отказывается от заказа (Р-3, Р-16, Н-14, К-8). */
  async release(org: OrgContext, actorUserId: string, orderId: string, reason: string): Promise<void> {
    await this.core.db.transaction(async (tx) => {
      const order = await this.core.lock(tx, orderId);
      this.assertPartner(order, org);
      if (!['awaiting_prepayment', 'awaiting_assignment', 'assigned', 'en_route', 'arrived'].includes(order.status)) {
        throw conflict(ERROR_CODES.ORDER_STATUS_CONFLICT, 'Отказаться от заказа на этом этапе нельзя — обратитесь в поддержку');
      }
      await this.core.partnerIncident(tx, org.orgId, orderId, 'released_order', { reason });
      await this.returnToSearch(tx, order, { type: 'partner', id: actorUserId }, reason);
    });
  }

  /**
   * Единый механизм возврата: освободить технику и машинистов, исключить компанию из поиска по заказу (П-12),
   * новый полный срок поиска (Н-18). Цена заказчика не меняется.
   */
  async returnToSearch(tx: Tx, order: OrderRow, actor: { type: 'partner' | 'system' | 'admin'; id?: string }, reason: string): Promise<void> {
    const orgId = order.partner_org_id;
    const staff = orgId ? await this.core.partnerStaff(orgId, tx) : [];
    const operators = await this.core.operatorsOf(order.id, tx);
    await this.core.releaseResources(tx, order.id, 'cancelled');
    await this.core.cancelTimers(tx, order.id);
    if (orgId) {
      await tx.execute(sql`INSERT INTO order_excluded_orgs (order_id, org_id, reason) VALUES (${order.id}, ${orgId}, ${reason}) ON CONFLICT DO NOTHING`);
      await this.core.assignmentLog(tx, { orderId: order.id, orgId, unitId: order.equipment_unit_id, kind: 'returned_to_search', actorId: actor.id ?? null, reason });
    }
    await this.core.transition(tx, order, 'searching', actor, {
      reason,
      patch: [
        sql`partner_org_id = NULL`, sql`equipment_unit_id = NULL`, sql`managing_member_id = NULL`, sql`partner_delivery_km = NULL`,
        sql`partner_delivery_kopecks = NULL`, sql`assignment_deadline_at = NULL`, sql`replacement_deadline_at = NULL`, sql`prepayment_deadline_at = NULL`,
      ],
    });
    order.partner_org_id = null;
    order.equipment_unit_id = null;
    await this.matching.startSearch(tx, order);
    await this.core.events.emit({ type: 'order.replacing_partner', orderId: order.id, userIds: [order.customer_id], payload: {} }, tx);
    if (orgId) await this.core.events.emit({ type: 'order.removed_from_partner', orderId: order.id, orgId, userIds: [...staff, ...operators], payload: { reason } }, tx);
  }

  // ── Внутреннее ────────────────────────────────────────────────────────────

  private async awaitInternalReplacement(tx: Tx, order: OrderRow, actor: { type: 'operator' | 'partner'; id: string }, reason: string): Promise<void> {
    const minutes = await this.settings.get('assignment_deadline_min');
    const deadline = new Date(Date.now() + minutes * 60_000);
    await this.core.transition(tx, order, 'awaiting_assignment', actor, { reason, patch: [sql`replacement_deadline_at = ${deadline.toISOString()}`] });
    await this.core.jobs.schedule('replacement_deadline', { orderId: order.id }, deadline, { dedupeKey: `order:${order.id}:replace`, tx });
  }

  private async scheduleLaterShiftDeadlines(tx: Tx, orderId: string): Promise<void> {
    const shifts = await this.core.shifts(orderId, tx);
    for (const s of shifts.slice(1)) {
      const at = new Date(Math.max(new Date(s.starts_at).getTime() - 24 * 3_600_000, Date.now() + 10 * 60_000));
      await tx.execute(sql`UPDATE order_shifts SET assign_deadline_at = ${at.toISOString()} WHERE id = ${s.id}`);
      await this.core.jobs.schedule('shift_assign_deadline', { orderId, shiftId: s.id }, at, { dedupeKey: `shift:${s.id}:assign`, tx });
    }
  }

  private assertPartner(order: OrderRow, org: OrgContext): void {
    if (order.partner_org_id !== org.orgId) throw new AppException(ERROR_CODES.NOT_FOUND, 'Заказ не найден', HttpStatus.NOT_FOUND);
  }

  private async targetShift(orderId: string, shiftId: string | undefined, db?: Tx): Promise<ShiftRow> {
    const shifts = await this.core.shifts(orderId, db);
    const shift = shiftId ? shifts.find((s) => s.id === shiftId) : shifts.find((s) => s.status === 'pending' && !s.operator_user_id) ?? shifts.find((s) => s.status === 'pending');
    if (!shift) throw new AppException(ERROR_CODES.NOT_FOUND, 'Смена не найдена', HttpStatus.NOT_FOUND);
    return shift;
  }

  private async eligibleOperator(tx: Tx, orgId: string, memberId: string): Promise<{ id: string; user_id: string }> {
    const res = await tx.execute<{ id: string; user_id: string }>(sql`
      SELECT id, user_id FROM organization_members
      WHERE id = ${memberId} AND org_id = ${orgId} AND status = 'active' AND can_operate AND operator_verification = 'approved'`);
    const m = res.rows[0];
    if (!m) throw new AppException(ERROR_CODES.OPERATOR_NOT_ELIGIBLE, 'Машинист не найден или не прошёл проверку', HttpStatus.BAD_REQUEST);
    return m;
  }
}
