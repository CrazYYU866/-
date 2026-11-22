import { HttpStatus, Injectable, type OnModuleInit } from '@nestjs/common';
import { ERROR_CODES, toCustomerVisibleStatus, type OrderStatus, type Payer } from '@kovsh/contracts';
import { SettlementService } from '../finance/settlement.service';
import { firstPaymentKopecks } from '../finance/split';
import { sql } from 'drizzle-orm';
import { AppException } from '../common/app-exception';
import { SettingsService } from '../settings/settings.service';
import { MatchingService } from './matching.service';
import { OrderCore, type OrderRow } from './order-core';

const BEFORE_PAYMENT: OrderStatus[] = ['searching', 'offered', 'awaiting_prepayment'];
const AFTER_PAYMENT_CANCELLABLE: OrderStatus[] = ['awaiting_assignment', 'assigned', 'en_route', 'arrived', 'in_progress'];

@Injectable()
export class OrdersService implements OnModuleInit {
  constructor(
    private readonly core: OrderCore,
    private readonly matching: MatchingService,
    private readonly settings: SettingsService,
    private readonly settlement: SettlementService,
  ) {}

  onModuleInit(): void {
    this.core.jobs.register('auto_complete', (p) => this.autoComplete(String(p['orderId'])));
    this.core.jobs.register('final_payment_deadline', (p) => this.finalPaymentDeadline(String(p['orderId'])));
  }

  /** Оформление заказа из расчёта: цена берётся из расчёта без изменений и сразу запускается поиск (Н-1, Н-16). */
  async create(customerId: string, quoteId: string, siteComment?: string, payer: Payer = { kind: 'individual' }): Promise<{ id: string }> {
    return this.core.db.transaction(async (tx) => {
      let inn: string | null = null;
      if (payer.kind === 'legal') {
        const lp = await tx.execute<{ inn: string }>(sql`
          SELECT inn FROM customer_legal_profiles WHERE id = ${payer.legalProfileId} AND user_id = ${customerId} AND archived_at IS NULL`);
        if (!lp.rows[0]) throw new AppException(ERROR_CODES.NOT_FOUND, 'Юрлицо не найдено', HttpStatus.NOT_FOUND);
        inn = lp.rows[0].inn;
      }
      // Пока есть непогашенный долг, новые заказы оформлять нельзя (К-9).
      if (await this.settlement.hasOpenDebt(tx, customerId, inn)) {
        throw new AppException(ERROR_CODES.DEBT_EXISTS, 'Погасите задолженность по предыдущему заказу', HttpStatus.CONFLICT);
      }
      const q = await tx.execute<Record<string, unknown>>(sql`SELECT * FROM quotes WHERE id = ${quoteId} AND customer_id = ${customerId} FOR UPDATE`);
      const quote = q.rows[0];
      if (!quote) throw new AppException(ERROR_CODES.NOT_FOUND, 'Расчёт не найден', HttpStatus.NOT_FOUND);
      if (quote['used_at']) throw new AppException(ERROR_CODES.CONFLICT, 'Заказ по этому расчёту уже оформлен', HttpStatus.CONFLICT);
      const fresh = await tx.execute<{ ok: boolean }>(sql`SELECT ${quote['expires_at'] as Date}::timestamptz > now() AS ok`);
      if (!fresh.rows[0]?.ok) throw new AppException(ERROR_CODES.QUOTE_EXPIRED, 'Цена устарела, пересчитайте заказ', HttpStatus.CONFLICT);
      // Первый платёж: физлицо — 100%, юрлицо — 50% (решения 07).
      const percent = await this.settings.get('prepayment_percent');
      const prepayment = firstPaymentKopecks(Number(quote['total_kopecks']), payer.kind, percent);

      const ins = await tx.execute<{ id: string }>(sql`
        INSERT INTO orders (customer_id, quote_id, category_id, region_id, site_point, site_address, site_comment, requirements, urgency,
          first_start_at, last_end_at, total_hours, status, rent_tariff_id, delivery_tariff_id, hour_price_kopecks, km_price_kopecks,
          rent_kopecks, customer_delivery_kopecks, customer_delivery_km, total_kopecks, prepayment_kopecks, payer_kind, payer_legal_profile_id)
        SELECT customer_id, id, category_id, region_id, site_point, site_address, ${siteComment ?? null}, requirements, urgency,
          first_start_at, last_end_at, total_hours, 'searching', rent_tariff_id, delivery_tariff_id, hour_price_kopecks, km_price_kopecks,
          rent_kopecks, delivery_kopecks, reference_route_km, total_kopecks, ${prepayment}, ${payer.kind},
          ${payer.kind === 'legal' ? payer.legalProfileId : null}
        FROM quotes WHERE id = ${quoteId}
        RETURNING id`);
      const orderId = ins.rows[0]?.id as string;
      await tx.execute(sql`
        INSERT INTO order_shifts (order_id, seq, starts_at, ends_at, hours, work_date)
        SELECT ${orderId}, s.i, (s.v->>'start')::timestamptz, (s.v->>'end')::timestamptz, (s.v->>'hours')::numeric::int,
               ((s.v->>'start')::timestamptz AT TIME ZONE r.timezone)::date
        FROM quotes q JOIN regions r ON r.id = q.region_id, jsonb_array_elements(q.shifts) WITH ORDINALITY AS s(v, i)
        WHERE q.id = ${quoteId}`);
      await tx.execute(sql`UPDATE quotes SET used_at = now() WHERE id = ${quoteId}`);
      await tx.execute(sql`
        INSERT INTO order_status_history (order_id, from_status, to_status, actor_type, actor_id) VALUES (${orderId}, NULL, 'searching', 'customer', ${customerId})`);
      const order = await this.core.get(orderId, tx);
      await this.matching.startSearch(tx as never, order);
      await this.core.events.emit({ type: 'order.created', orderId, userIds: [customerId] }, tx);
      return { id: orderId };
    });
  }

  /**
   * Условия отмены: до оплаты — бесплатно; после оплаты — решение принимает поддержка (полный, частичный возврат
   * или полное удержание), автоматически деньги не возвращаются и не удерживаются (решения 07).
   */
  async cancelPreview(customerId: string, orderId: string): Promise<{ allowed: boolean; paidKopecks: number; policy: 'free' | 'support_review' | 'not_allowed' }> {
    const order = await this.ownOrder(customerId, orderId);
    const paid = Number(order.paid_kopecks) - Number(order.refunded_kopecks);
    if (!(BEFORE_PAYMENT.includes(order.status) || AFTER_PAYMENT_CANCELLABLE.includes(order.status))) {
      return { allowed: false, paidKopecks: paid, policy: 'not_allowed' };
    }
    return { allowed: true, paidKopecks: paid, policy: paid > 0 ? 'support_review' : 'free' };
  }

  async cancelByCustomer(customerId: string, orderId: string, reason?: string): Promise<void> {
    await this.core.db.transaction(async (tx) => {
      const order = await this.core.lock(tx, orderId);
      if (order.customer_id !== customerId) throw new AppException(ERROR_CODES.NOT_FOUND, 'Заказ не найден', HttpStatus.NOT_FOUND);
      if (!(BEFORE_PAYMENT.includes(order.status) || AFTER_PAYMENT_CANCELLABLE.includes(order.status))) {
        throw new AppException(ERROR_CODES.ORDER_STATUS_CONFLICT, 'Заказ уже нельзя отменить', HttpStatus.CONFLICT);
      }
      const staff = order.partner_org_id ? await this.core.partnerStaff(order.partner_org_id, tx) : [];
      const operators = await this.core.operatorsOf(orderId, tx);
      await tx.execute(sql`UPDATE order_offers SET status = 'revoked', responded_at = now() WHERE order_id = ${orderId} AND status = 'pending'`);
      await this.core.releaseResources(tx, orderId, 'cancelled');
      await this.core.cancelTimers(tx, orderId);
      await this.core.transition(tx, order, 'cancelled', { type: 'customer', id: customerId }, {
        reason: reason ?? 'Отменён заказчиком',
        patch: [sql`cancelled_at = now()`, sql`cancelled_by = 'customer'`, sql`cancellation_reason = ${reason ?? null}`],
      });
      await this.settlement.openCancellationReview(tx, orderId, 'customer', reason ?? null);
      const paid = Number(order.paid_kopecks) - Number(order.refunded_kopecks);
      await this.core.events.emit({ type: 'order.cancelled', orderId, orgId: order.partner_org_id, userIds: [customerId, ...staff, ...operators], payload: { by: 'customer', supportReview: paid > 0 } }, tx);
    });
  }

  /** Подтверждение завершения заказчиком (Н-19). */
  async confirmCompletion(customerId: string, orderId: string): Promise<void> {
    await this.complete(orderId, { customerId });
  }

  async autoComplete(orderId: string): Promise<void> {
    await this.complete(orderId, null);
  }

  private async complete(orderId: string, by: { customerId: string } | null): Promise<void> {
    await this.core.db.transaction(async (tx) => {
      const order = await this.core.lock(tx, orderId);
      if (by && order.customer_id !== by.customerId) throw new AppException(ERROR_CODES.NOT_FOUND, 'Заказ не найден', HttpStatus.NOT_FOUND);
      if (order.status !== 'awaiting_completion_confirmation') {
        if (by) throw new AppException(ERROR_CODES.ORDER_STATUS_CONFLICT, 'Заказ не ожидает подтверждения', HttpStatus.CONFLICT);
        return;
      }
      await this.core.jobs.cancel(`order:${orderId}:autocomplete`, tx);
      // Начисления исполнителю, диспетчеру и платформе — в момент окончательного завершения (Ф-1, Н-10).
      await this.settlement.settleCompletion(tx, order);
      const remaining = Number(order.total_kopecks) - Number(order.paid_kopecks);
      const actor = by ? { type: 'customer' as const, id: by.customerId } : { type: 'system' as const };
      const reason = by ? 'Завершение подтверждено заказчиком' : 'Автоматическое завершение через 24 часа';
      if (remaining > 0) {
        // Юрлицо: оставшиеся 50% — в течение 24 часов после окончательного завершения (07, К-9).
        const hours = await this.settings.get('final_payment_timeout_hours');
        const due = new Date(Date.now() + hours * 3_600_000);
        await this.core.transition(tx, order, 'awaiting_final_payment', actor, {
          reason, patch: [sql`completed_at = now()`, sql`auto_completed = ${!by}`, sql`final_payment_due_at = ${due.toISOString()}`],
        });
        await this.core.jobs.schedule('final_payment_deadline', { orderId }, due, { dedupeKey: `order:${orderId}:final`, tx });
      } else {
        await this.core.transition(tx, order, 'completed', actor, { reason, patch: [sql`completed_at = now()`, sql`auto_completed = ${!by}`] });
      }
      const staff = order.partner_org_id ? await this.core.partnerStaff(order.partner_org_id, tx) : [];
      await this.core.events.emit({ type: 'order.completed', orderId, orgId: order.partner_org_id, userIds: [order.customer_id, ...staff], payload: { auto: !by } }, tx);
    });
  }

  /** Вторая часть не оплачена за 24 часа: фиксируется задолженность, новые заказы блокируются (Н-9, К-9). */
  async finalPaymentDeadline(orderId: string): Promise<void> {
    await this.core.db.transaction(async (tx) => {
      const order = await this.core.lock(tx, orderId);
      if (order.status !== 'awaiting_final_payment') return;
      const debt = Number(order.total_kopecks) - Number(order.paid_kopecks);
      if (debt <= 0) return;
      await tx.execute(sql`
        INSERT INTO customer_debts (order_id, customer_id, legal_profile_id, inn, amount_kopecks)
        SELECT o.id, o.customer_id, o.payer_legal_profile_id, lp.inn, ${debt}
        FROM orders o LEFT JOIN customer_legal_profiles lp ON lp.id = o.payer_legal_profile_id WHERE o.id = ${orderId}
        ON CONFLICT (order_id) DO NOTHING`);
      await tx.execute(sql`
        INSERT INTO order_status_history (order_id, from_status, to_status, actor_type, reason)
        VALUES (${orderId}, ${order.status}, ${order.status}, 'system', 'Вторая часть не оплачена в срок — задолженность')`);
      await this.core.events.emit({ type: 'order.debt_created', orderId, userIds: [order.customer_id], payload: { amountKopecks: debt, admin: true } }, tx);
    });
  }

  /** Спор по выполнению — до автозавершения; автозавершение приостанавливается (Н-19). */
  async openDispute(customerId: string, orderId: string, reason: string): Promise<void> {
    await this.core.db.transaction(async (tx) => {
      const order = await this.core.lock(tx, orderId);
      if (order.customer_id !== customerId) throw new AppException(ERROR_CODES.NOT_FOUND, 'Заказ не найден', HttpStatus.NOT_FOUND);
      if (order.status !== 'awaiting_completion_confirmation') {
        throw new AppException(ERROR_CODES.ORDER_STATUS_CONFLICT, 'Спор можно открыть до подтверждения завершения', HttpStatus.CONFLICT);
      }
      await this.core.jobs.cancel(`order:${orderId}:autocomplete`, tx);
      await this.core.transition(tx, order, 'disputed', { type: 'customer', id: customerId }, { reason });
      const staff = order.partner_org_id ? await this.core.partnerStaff(order.partner_org_id, tx) : [];
      await this.core.events.emit({ type: 'order.disputed', orderId, orgId: order.partner_org_id, userIds: staff, payload: { reason, admin: true } }, tx);
    });
  }

  // ── Просмотр ──────────────────────────────────────────────────────────────

  async listForCustomer(customerId: string) {
    const res = await this.core.db.execute<{ id: string; number: string; status: OrderStatus; category: string; site_address: string; first_start_at: Date; total_kopecks: string; created_at: Date }>(sql`
      SELECT o.id, o.number, o.status, c.name AS category, o.site_address, o.first_start_at, o.total_kopecks, o.created_at
      FROM orders o JOIN equipment_categories c ON c.id = o.category_id
      WHERE o.customer_id = ${customerId} ORDER BY o.created_at DESC LIMIT 200`);
    return res.rows.map((r) => ({
      id: r.id, number: Number(r.number), status: r.status, visibleStatus: toCustomerVisibleStatus(r.status), category: r.category,
      siteAddress: r.site_address, firstStartAt: new Date(r.first_start_at).toISOString(), totalKopecks: Number(r.total_kopecks),
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  /** Карточка заказа для заказчика: после назначения — компания, техника, машинист (ТЗ §4). Телефоны не раскрываются (ТЗ §10). */
  async viewForCustomer(customerId: string, orderId: string) {
    const order = await this.ownOrder(customerId, orderId);
    return this.view(order, 'customer');
  }

  async view(order: OrderRow, audience: 'customer' | 'partner' | 'operator' | 'admin') {
    const shifts = await this.core.shifts(order.id);
    const cat = await this.core.db.execute<{ name: string }>(sql`SELECT name FROM equipment_categories WHERE id = ${order.category_id}`);
    const partner = order.partner_org_id
      ? (await this.core.db.execute<{ name: string }>(sql`SELECT name FROM organizations WHERE id = ${order.partner_org_id}`)).rows[0] ?? null
      : null;
    const unit = order.equipment_unit_id
      ? (await this.core.db.execute<{ id: string; brand: string; model: string; reg_number: string | null; year: number | null; photo_ids: string[] | null }>(sql`
          SELECT u.id, u.brand, u.model, u.reg_number, u.year,
            (SELECT array_agg(file_id ORDER BY sort) FROM equipment_photos p WHERE p.unit_id = u.id) AS photo_ids
          FROM equipment_units u WHERE u.id = ${order.equipment_unit_id}`)).rows[0] ?? null
      : null;
    const operatorIds = [...new Set(shifts.map((s) => s.operator_user_id).filter((x): x is string => Boolean(x)))];
    const operators = operatorIds.length
      ? (await this.core.db.execute<{ id: string; full_name: string | null; photo_file_id: string | null }>(sql`
          SELECT id, full_name, photo_file_id FROM users WHERE id IN (${sql.join(operatorIds.map((i) => sql`${i}`), sql`, `)})`)).rows
      : [];
    const history = await this.core.db.execute<{ to_status: string; from_status: string | null; reason: string | null; actor_type: string; created_at: Date; device_recorded_at: Date | null }>(sql`
      SELECT to_status, from_status, reason, actor_type, created_at, device_recorded_at FROM order_status_history WHERE order_id = ${order.id} ORDER BY id`);
    const showPartner = !['searching', 'offered', 'search_failed'].includes(order.status) && partner;

    const base = {
      id: order.id,
      number: Number(order.number),
      status: order.status,
      visibleStatus: toCustomerVisibleStatus(order.status),
      category: cat.rows[0]?.name ?? '',
      site: { lat: Number(order.site_lat), lng: Number(order.site_lng), address: order.site_address, comment: order.site_comment },
      urgency: order.urgency,
      totalHours: order.total_hours,
      shifts: shifts.map((s) => ({
        id: s.id, seq: s.seq, start: new Date(s.starts_at).toISOString(), end: new Date(s.ends_at).toISOString(), hours: s.hours, status: s.status,
        operator: s.operator_user_id ? toOperator(operators.find((o) => o.id === s.operator_user_id)) : null,
      })),
      partner: showPartner ? { name: partner.name } : null,
      equipment: showPartner && unit ? { id: unit.id, brand: unit.brand, model: unit.model, regNumber: unit.reg_number, year: unit.year, photoFileIds: unit.photo_ids ?? [] } : null,
      history: history.rows.map((h) => ({
        status: h.to_status, from: h.from_status, reason: h.reason, actor: h.actor_type,
        at: new Date(h.created_at).toISOString(), deviceRecordedAt: h.device_recorded_at ? new Date(h.device_recorded_at).toISOString() : null,
      })),
    };
    if (audience === 'operator') return base;
    const customerPrice = {
      rentKopecks: Number(order.rent_kopecks),
      deliveryKopecks: Number(order.customer_delivery_kopecks),
      deliveryKm: Number(order.customer_delivery_km),
      totalKopecks: Number(order.total_kopecks),
      payerKind: order.payer_kind,
      firstPaymentKopecks: Number(order.prepayment_kopecks),
      paidKopecks: Number(order.paid_kopecks),
      refundedKopecks: Number(order.refunded_kopecks),
      remainingKopecks: Math.max(0, Number(order.total_kopecks) - Number(order.paid_kopecks)),
      prepaid: Boolean(order.prepaid_at),
    };
    if (audience === 'customer') return { ...base, price: customerPrice };
    // Компании — сумма к получению после комиссии (Н-22) и статус оплаты заказчиком (П-9); без уведомлений об оплате (ТЗ §14).
    const amount = order.partner_amount_kopecks !== null
      ? Number(order.partner_amount_kopecks)
      : order.partner_org_id ? (await this.settlement.split(order)).partner : null;
    const paid = Number(order.paid_kopecks);
    const partnerView = {
      ...base,
      partnerPrice: {
        amountKopecks: amount,
        deliveryKm: order.partner_delivery_km !== null ? Number(order.partner_delivery_km) : null,
        final: order.partner_amount_kopecks !== null,
      },
      customerPaymentStatus: paid === 0 ? 'not_paid' : paid >= Number(order.total_kopecks) ? 'paid' : 'partially_paid',
    };
    return audience === 'admin' ? { ...partnerView, price: customerPrice } : partnerView;
  }

  private async ownOrder(customerId: string, orderId: string): Promise<OrderRow> {
    const order = await this.core.get(orderId);
    if (order.customer_id !== customerId) throw new AppException(ERROR_CODES.NOT_FOUND, 'Заказ не найден', HttpStatus.NOT_FOUND);
    return order;
  }
}

function toOperator(u: { id: string; full_name: string | null; photo_file_id: string | null } | undefined) {
  return u ? { userId: u.id, fullName: u.full_name, photoFileId: u.photo_file_id, rating: null as number | null } : null;
}
