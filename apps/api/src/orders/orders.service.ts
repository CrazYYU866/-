import { HttpStatus, Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { SMS_PROVIDER, type SmsProvider } from '../auth/sms/sms.provider';
import { ERROR_CODES, toCustomerVisibleStatus, type OrderStatus, type Payer } from '@kovsh/contracts';
import { PromoService } from '../finance/promo.service';
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
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    private readonly promo: PromoService,
  ) {}

  onModuleInit(): void {
    this.core.jobs.register('auto_complete', (p) => this.autoComplete(String(p['orderId'])));
    this.core.jobs.register('final_payment_deadline', (p) => this.finalPaymentDeadline(String(p['orderId'])));
    this.core.jobs.register('agent_confirmation_deadline', (p) => this.agentConfirmationDeadline(String(p['orderId'])));
  }

  /** Оформление заказа из расчёта: цена берётся из расчёта без изменений и сразу запускается поиск (Н-1, Н-16). */
  async create(customerId: string, quoteId: string, siteComment?: string, payer: Payer = { kind: 'individual' }): Promise<{ id: string }> {
    return this.core.db.transaction(async (tx) => {
      let inn: string | null = null;
      if (payer.kind === 'legal') {
        inn = await this.accessibleOrgInn(tx, customerId, payer.legalProfileId);
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
      // Промокод перепроверяется с учётом плательщика (для юрлица — по ИНН); одновременные заказы сериализуются.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${customerId}))`);
      if (quote['promo_code_id']) {
        const code = await tx.execute<{ code: string }>(sql`SELECT code FROM promo_codes WHERE id = ${quote['promo_code_id'] as string}`);
        await this.promo.validate(tx, code.rows[0]?.code as string, customerId, inn);
      }
      const payable = Number(quote['total_kopecks']) - Number(quote['discount_kopecks']);
      // Первый платёж: физлицо — 100%, юрлицо — 50% (решения 07).
      const percent = await this.settings.get('prepayment_percent');
      const prepayment = firstPaymentKopecks(payable, payer.kind, percent);

      const ins = await tx.execute<{ id: string }>(sql`
        INSERT INTO orders (customer_id, quote_id, category_id, region_id, site_point, site_address, site_comment, requirements, urgency,
          first_start_at, last_end_at, total_hours, status, rent_tariff_id, delivery_tariff_id, hour_price_kopecks, km_price_kopecks,
          rent_kopecks, customer_delivery_kopecks, customer_delivery_km, total_kopecks, prepayment_kopecks, payer_kind, payer_legal_profile_id,
          promo_code_id, discount_kopecks)
        SELECT customer_id, id, category_id, region_id, site_point, site_address, ${siteComment ?? null}, requirements, urgency,
          first_start_at, last_end_at, total_hours, 'searching', rent_tariff_id, delivery_tariff_id, hour_price_kopecks, km_price_kopecks,
          rent_kopecks, delivery_kopecks, reference_route_km, total_kopecks, ${prepayment}, ${payer.kind},
          ${payer.kind === 'legal' ? payer.legalProfileId : null}, promo_code_id, discount_kopecks
        FROM quotes WHERE id = ${quoteId}
        RETURNING id`);
      const orderId = ins.rows[0]?.id as string;
      await this.insertShifts(tx, orderId, quoteId);
      await tx.execute(sql`UPDATE quotes SET used_at = now() WHERE id = ${quoteId}`);
      await tx.execute(sql`
        INSERT INTO order_status_history (order_id, from_status, to_status, actor_type, actor_id) VALUES (${orderId}, NULL, 'searching', 'customer', ${customerId})`);
      const order = await this.core.get(orderId, tx);
      await this.matching.startSearch(tx as never, order);
      await this.core.events.emit({ type: 'order.created', orderId, userIds: [customerId] }, tx);
      return { id: orderId };
    });
  }

  private async insertShifts(tx: Pick<OrderCore['db'], 'execute'>, orderId: string, quoteId: string): Promise<void> {
    await tx.execute(sql`
      INSERT INTO order_shifts (order_id, seq, starts_at, ends_at, hours, work_date)
      SELECT ${orderId}, s.i, (s.v->>'start')::timestamptz, (s.v->>'end')::timestamptz, (s.v->>'hours')::numeric::int,
             ((s.v->>'start')::timestamptz AT TIME ZONE r.timezone)::date
      FROM quotes q JOIN regions r ON r.id = q.region_id, jsonb_array_elements(q.shifts) WITH ORDINALITY AS s(v, i)
      WHERE q.id = ${quoteId}`);
  }

  /** Организация, от имени которой пользователь может оформлять заказы: руководитель или приглашённый сотрудник (Н-30). */
  async accessibleOrgInn(tx: Pick<OrderCore['db'], 'execute'>, userId: string, profileId: string): Promise<string> {
    const lp = await tx.execute<{ inn: string }>(sql`
      SELECT p.inn FROM customer_org_members m JOIN customer_legal_profiles p ON p.id = m.profile_id
      WHERE m.profile_id = ${profileId} AND m.user_id = ${userId} AND m.status = 'active' AND p.archived_at IS NULL`);
    if (!lp.rows[0]) throw new AppException(ERROR_CODES.NOT_FOUND, 'Организация не найдена или нет доступа', HttpStatus.NOT_FOUND);
    return lp.rows[0].inn;
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

  private async complete(orderId: string, by: { customerId: string } | null, admin?: { adminId: string; reason: string }): Promise<void> {
    await this.core.db.transaction(async (tx) => {
      const order = await this.core.lock(tx, orderId);
      if (by && order.customer_id !== by.customerId) throw new AppException(ERROR_CODES.NOT_FOUND, 'Заказ не найден', HttpStatus.NOT_FOUND);
      const expected = admin ? 'disputed' : 'awaiting_completion_confirmation';
      if (order.status !== expected) {
        if (by || admin) throw new AppException(ERROR_CODES.ORDER_STATUS_CONFLICT, admin ? 'По заказу нет открытого спора' : 'Заказ не ожидает подтверждения', HttpStatus.CONFLICT);
        return;
      }
      await this.core.jobs.cancel(`order:${orderId}:autocomplete`, tx);
      // Начисления исполнителю, диспетчеру и платформе — в момент окончательного завершения (Ф-1, Н-10).
      await this.settlement.settleCompletion(tx, order);
      const remaining = payableOf(order) - Number(order.paid_kopecks);
      const actor = admin ? { type: 'admin' as const, id: admin.adminId } : by ? { type: 'customer' as const, id: by.customerId } : { type: 'system' as const };
      const reason = admin ? `Спор закрыт: работа принята. ${admin.reason}` : by ? 'Завершение подтверждено заказчиком' : 'Автоматическое завершение через 24 часа';
      if (remaining > 0) {
        // Юрлицо: оставшиеся 50%; физлицо: неоплаченные дополнительные часы — в течение 24 часов, иначе долг (07, К-9, Н-28).
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
      await this.core.events.emit({ type: 'order.completed', orderId, orgId: order.partner_org_id, userIds: [order.customer_id, ...staff], payload: { auto: !by && !admin, disputeClosed: Boolean(admin) } }, tx);
    });
  }

  /**
   * Закрытие спора поддержкой (С-35). Два исхода, оба по уже утверждённым правилам:
   * «работа принята» — обычное завершение (начисления, вторая часть оплаты/долг — 07, К-9);
   * «отменить» — отмена после оплаты, сумму возврата решает поддержка (решения 07, Ф-3).
   * GPS-трек удаляется через 48 часов после закрытия спора (С-31).
   */
  async resolveDispute(orderId: string, adminId: string, outcome: 'accept_work' | 'cancel', reason: string): Promise<void> {
    if (outcome === 'accept_work') return this.complete(orderId, null, { adminId, reason });
    await this.core.db.transaction(async (tx) => {
      const order = await this.core.lock(tx, orderId);
      if (order.status !== 'disputed') throw new AppException(ERROR_CODES.ORDER_STATUS_CONFLICT, 'По заказу нет открытого спора', HttpStatus.CONFLICT);
      const staff = order.partner_org_id ? await this.core.partnerStaff(order.partner_org_id, tx) : [];
      const operators = await this.core.operatorsOf(orderId, tx);
      await this.core.releaseResources(tx, orderId, 'cancelled');
      await this.core.cancelTimers(tx, orderId);
      await this.core.transition(tx, order, 'cancelled', { type: 'admin', id: adminId }, {
        reason: `Спор закрыт: заказ отменён. ${reason}`,
        patch: [sql`cancelled_at = now()`, sql`cancelled_by = 'admin'`, sql`cancellation_reason = ${reason}`],
      });
      await this.settlement.openCancellationReview(tx, orderId, 'admin', reason);
      const paid = Number(order.paid_kopecks) - Number(order.refunded_kopecks);
      await this.core.events.emit({ type: 'order.cancelled', orderId, orgId: order.partner_org_id, userIds: [order.customer_id, ...staff, ...operators], payload: { by: 'admin', supportReview: paid > 0, admin: true } }, tx);
    });
  }

  // ── Продление работ (Н-5, Н-28, К-4) ────────────────────────────────────

  async extensions(orderId: string) {
    const res = await this.core.db.execute(sql`SELECT id, hours, amount_kopecks, status, created_at, decided_at FROM order_extensions WHERE order_id = ${orderId} ORDER BY created_at`);
    return res.rows;
  }

  /**
   * Заказчик подтверждает или отклоняет продление. После подтверждения машинист продолжает работу сразу,
   * сумма выставляется к оплате; неоплата становится задолженностью (Н-28). Работает тот же машинист на той же технике (К-4).
   */
  async decideExtension(customerId: string, orderId: string, extensionId: string, approve: boolean): Promise<void> {
    await this.core.db.transaction(async (tx) => {
      const order = await this.core.lock(tx, orderId);
      if (order.customer_id !== customerId) throw new AppException(ERROR_CODES.NOT_FOUND, 'Заказ не найден', HttpStatus.NOT_FOUND);
      const res = await tx.execute<{ id: string; shift_id: string; hours: number; amount_kopecks: string }>(sql`
        SELECT id, shift_id, hours, amount_kopecks FROM order_extensions WHERE id = ${extensionId} AND order_id = ${orderId} AND status = 'requested' FOR UPDATE`);
      const ext = res.rows[0];
      if (!ext) throw new AppException(ERROR_CODES.NOT_FOUND, 'Запрос не найден', HttpStatus.NOT_FOUND);
      const recipients = [...(await this.core.operatorsOf(orderId, tx)), ...(order.partner_org_id ? await this.core.partnerStaff(order.partner_org_id, tx) : [])];
      if (!approve) {
        await tx.execute(sql`UPDATE order_extensions SET status = 'rejected', decided_by = ${customerId}, decided_at = now() WHERE id = ${ext.id}`);
        await this.core.events.emit({ type: 'order.extension_rejected', orderId, userIds: recipients, payload: { extensionId } }, tx);
        return;
      }
      const ms = ext.hours * 3_600_000;
      try {
        await tx.execute(sql`SAVEPOINT ext`);
        // Бронь техники продлевается; пересечение с другим заказом отклонит БД.
        await tx.execute(sql`
          UPDATE unit_bookings SET period = tstzrange(lower(period), upper(period) + ${`${ext.hours} hours`}::interval)
          WHERE order_id = ${orderId} AND status = 'active'`);
        await tx.execute(sql`RELEASE SAVEPOINT ext`);
      } catch (e) {
        if (((e as { cause?: { code?: string } }).cause ?? (e as { code?: string })).code !== '23P01') throw e;
        await tx.execute(sql`ROLLBACK TO SAVEPOINT ext`);
        throw new AppException(ERROR_CODES.EXTENSION_UNAVAILABLE, 'Техника занята после окончания заказа — продление невозможно', HttpStatus.CONFLICT);
      }
      await tx.execute(sql`UPDATE order_shifts SET ends_at = ends_at + ${`${ext.hours} hours`}::interval, hours = hours + ${ext.hours} WHERE id = ${ext.shift_id}`);
      await tx.execute(sql`UPDATE order_extensions SET status = 'approved', decided_by = ${customerId}, decided_at = now() WHERE id = ${ext.id}`);
      await tx.execute(sql`
        UPDATE orders SET extra_hours = extra_hours + ${ext.hours}, extra_kopecks = extra_kopecks + ${Number(ext.amount_kopecks)},
          last_end_at = GREATEST(last_end_at, (SELECT max(ends_at) FROM order_shifts WHERE order_id = ${orderId})),
          version = version + 1
        WHERE id = ${orderId}`);
      await tx.execute(sql`
        INSERT INTO order_status_history (order_id, shift_id, from_status, to_status, actor_type, actor_id, reason, meta)
        VALUES (${orderId}, ${ext.shift_id}, ${order.status}, ${order.status}, 'customer', ${customerId}, 'Продление подтверждено', ${JSON.stringify({ hours: ext.hours, amountKopecks: Number(ext.amount_kopecks) })}::jsonb)`);
      await this.core.events.emit({ type: 'order.extension_approved', orderId, userIds: recipients, payload: { extensionId, hours: ext.hours, ms } }, tx);
      await this.core.events.emit({ type: 'order.payment_due', orderId, userIds: [customerId], payload: { reason: 'extension', amountKopecks: Number(ext.amount_kopecks) } }, tx);
    });
  }

  // ── Заказ независимого диспетчера (Н-27, Н-30) ──────────────────────────

  /**
   * Диспетчер оформляет заявку за фактического заказчика. Поиск не запускается до подтверждения заказчиком
   * по SMS-ссылке; тип заказчика и плательщика выбирает сам заказчик.
   */
  async createForAgent(agentOrgId: string, agentUserId: string, quoteId: string, siteComment: string | undefined, linkBaseUrl: string): Promise<{ id: string; customerPhone: string }> {
    const token = randomBytes(24).toString('base64url');
    const result = await this.core.db.transaction(async (tx) => {
      const q = await tx.execute<Record<string, unknown>>(sql`SELECT * FROM quotes WHERE id = ${quoteId} AND agent_org_id = ${agentOrgId} FOR UPDATE`);
      const quote = q.rows[0];
      if (!quote) throw new AppException(ERROR_CODES.NOT_FOUND, 'Расчёт не найден', HttpStatus.NOT_FOUND);
      if (quote['used_at']) throw new AppException(ERROR_CODES.CONFLICT, 'Заявка по этому расчёту уже оформлена', HttpStatus.CONFLICT);
      const fresh = await tx.execute<{ ok: boolean }>(sql`SELECT ${quote['expires_at'] as Date}::timestamptz > now() AS ok`);
      if (!fresh.rows[0]?.ok) throw new AppException(ERROR_CODES.QUOTE_EXPIRED, 'Цена устарела, пересчитайте заявку', HttpStatus.CONFLICT);
      const ins = await tx.execute<{ id: string }>(sql`
        INSERT INTO orders (customer_id, quote_id, category_id, region_id, site_point, site_address, site_comment, requirements, urgency,
          first_start_at, last_end_at, total_hours, status, rent_tariff_id, delivery_tariff_id, hour_price_kopecks, km_price_kopecks,
          rent_kopecks, customer_delivery_kopecks, customer_delivery_km, total_kopecks, prepayment_kopecks, payer_kind,
          agent_org_id, source, created_by_user_id, customer_link_token_hash, promo_code_id, discount_kopecks)
        SELECT customer_id, id, category_id, region_id, site_point, site_address, ${siteComment ?? null}, requirements, urgency,
          first_start_at, last_end_at, total_hours, 'awaiting_customer_confirmation', rent_tariff_id, delivery_tariff_id, hour_price_kopecks, km_price_kopecks,
          rent_kopecks, delivery_kopecks, reference_route_km, total_kopecks, total_kopecks, NULL,
          ${agentOrgId}, 'agent', ${agentUserId}, ${sha256(token)}, promo_code_id, discount_kopecks
        FROM quotes WHERE id = ${quoteId} RETURNING id`);
      const orderId = ins.rows[0]?.id as string;
      await this.insertShifts(tx, orderId, quoteId);
      await tx.execute(sql`UPDATE quotes SET used_at = now() WHERE id = ${quoteId}`);
      await tx.execute(sql`INSERT INTO order_status_history (order_id, from_status, to_status, actor_type, actor_id, reason)
        VALUES (${orderId}, NULL, 'awaiting_customer_confirmation', 'partner', ${agentUserId}, 'Заявка независимого диспетчера')`);
      // Подтвердить можно, пока до начала работ больше минимального срока подачи; потом заявка отменяется сама (Н-32).
      const lead = await this.settings.get('min_lead_time_min');
      const deadline = new Date(new Date(quote['first_start_at'] as Date).getTime() - lead * 60_000);
      await this.core.jobs.schedule('agent_confirmation_deadline', { orderId }, deadline, { dedupeKey: `order:${orderId}:confirm`, tx });
      const phone = await tx.execute<{ phone: string }>(sql`SELECT phone FROM users WHERE id = ${quote['customer_id'] as string}`);
      return { id: orderId, customerPhone: phone.rows[0]?.phone as string };
    });
    await this.sms.send(result.customerPhone, `Для вас оформлена заявка на спецтехнику «Ковш на Час». Проверьте и подтвердите: ${linkBaseUrl}/o/${token}`);
    return result;
  }

  /** Заказ по ссылке из SMS: доступ — по секретному токену, без регистрации (Н-27). */
  async byLinkToken(token: string): Promise<{ orderId: string; customerId: string }> {
    const res = await this.core.db.execute<{ id: string; customer_id: string }>(sql`SELECT id, customer_id FROM orders WHERE customer_link_token_hash = ${sha256(token)}`);
    const row = res.rows[0];
    if (!row) throw new AppException(ERROR_CODES.NOT_FOUND, 'Ссылка недействительна', HttpStatus.NOT_FOUND);
    return { orderId: row.id, customerId: row.customer_id };
  }

  /** Фактический заказчик подтверждает заявку и выбирает плательщика — только после этого начинается поиск (Н-27). */
  async confirmByCustomer(customerId: string, orderId: string, payer: Payer): Promise<void> {
    await this.core.db.transaction(async (tx) => {
      const order = await this.core.lock(tx, orderId);
      if (order.customer_id !== customerId) throw new AppException(ERROR_CODES.NOT_FOUND, 'Заказ не найден', HttpStatus.NOT_FOUND);
      if (order.status !== 'awaiting_customer_confirmation') throw new AppException(ERROR_CODES.ORDER_STATUS_CONFLICT, 'Заявка уже подтверждена или отменена', HttpStatus.CONFLICT);
      const inn = payer.kind === 'legal' ? await this.accessibleOrgInn(tx, customerId, payer.legalProfileId) : null;
      if (await this.settlement.hasOpenDebt(tx, customerId, inn)) {
        throw new AppException(ERROR_CODES.DEBT_EXISTS, 'Погасите задолженность по предыдущему заказу', HttpStatus.CONFLICT);
      }
      const lead = await this.settings.get('min_lead_time_min');
      if (new Date(order.first_start_at).getTime() < Date.now() + lead * 60_000) {
        throw new AppException(ERROR_CODES.INVALID_SCHEDULE, 'Время начала работ уже слишком близко — попросите диспетчера оформить заявку заново', HttpStatus.CONFLICT);
      }
      if (order.promo_code_id) {
        const code = await tx.execute<{ code: string }>(sql`SELECT code FROM promo_codes WHERE id = ${order.promo_code_id}`);
        await this.promo.validate(tx, code.rows[0]?.code as string, customerId, inn, orderId);
      }
      const prepayment = firstPaymentKopecks(Number(order.total_kopecks) - Number(order.discount_kopecks), payer.kind, await this.settings.get('prepayment_percent'));
      await this.core.transition(tx, order, 'searching', { type: 'customer', id: customerId }, {
        reason: 'Заявка подтверждена заказчиком',
        patch: [
          sql`payer_kind = ${payer.kind}`, sql`payer_legal_profile_id = ${payer.kind === 'legal' ? payer.legalProfileId : null}`,
          sql`prepayment_kopecks = ${prepayment}`, sql`customer_confirmed_at = now()`,
        ],
      });
      await this.core.jobs.cancel(`order:${orderId}:confirm`, tx);
      await this.matching.startSearch(tx as never, order);
      if (order.agent_org_id) {
        await this.core.events.emit({ type: 'order.customer_confirmed', orderId, orgId: order.agent_org_id, userIds: await this.core.partnerStaff(order.agent_org_id, tx) }, tx);
      }
    });
  }

  /** Заказчик не подтвердил заявку диспетчера вовремя — заявка отменяется, диспетчер получает уведомление (Н-32). */
  async agentConfirmationDeadline(orderId: string): Promise<void> {
    await this.core.db.transaction(async (tx) => {
      const order = await this.core.lock(tx, orderId);
      if (order.status !== 'awaiting_customer_confirmation') return;
      await this.core.transition(tx, order, 'cancelled', { type: 'system' }, {
        reason: 'Заказчик не подтвердил заявку вовремя',
        patch: [sql`cancelled_at = now()`, sql`cancelled_by = 'system'`, sql`cancellation_reason = 'Заказчик не подтвердил заявку'`],
      });
      const staff = order.agent_org_id ? await this.core.partnerStaff(order.agent_org_id, tx) : [];
      await this.core.events.emit({ type: 'order.agent_request_expired', orderId, orgId: order.agent_org_id, userIds: [...staff, order.customer_id] }, tx);
    });
  }

  /** Вторая часть не оплачена за 24 часа: фиксируется задолженность, новые заказы блокируются (Н-9, К-9). */
  async finalPaymentDeadline(orderId: string): Promise<void> {
    await this.core.db.transaction(async (tx) => {
      const order = await this.core.lock(tx, orderId);
      if (order.status !== 'awaiting_final_payment') return;
      const debt = payableOf(order) - Number(order.paid_kopecks);
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
      ? (await this.core.db.execute<{ id: string; full_name: string | null; photo_file_id: string | null; rating: number | null }>(sql`
          SELECT u.id, u.full_name, u.photo_file_id,
            (SELECT round(avg(stars)::numeric, 2)::float FROM ratings r WHERE r.target_user_id = u.id AND r.target_kind = 'operator' AND r.status = 'visible') AS rating
          FROM users u WHERE u.id IN (${sql.join(operatorIds.map((i) => sql`${i}`), sql`, `)})`)).rows
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
      extraHours: order.extra_hours,
      extraKopecks: Number(order.extra_kopecks),
      discountKopecks: Number(order.discount_kopecks),
      payableKopecks: payableOf(order),
      remainingKopecks: Math.max(0, payableOf(order) - Number(order.paid_kopecks)),
      prepaid: Boolean(order.prepaid_at),
    };
    if (audience === 'customer') {
      // Отмена после оплаты: заказчик видит, что решение принимает поддержка, и итог возврата (решения 07).
      const review = (await this.core.db.execute<{ status: string; decision: string | null; refund_kopecks: string | null; decision_reason: string | null; decided_at: Date | null }>(sql`
        SELECT status, decision, refund_kopecks, decision_reason, decided_at FROM cancellation_reviews WHERE order_id = ${order.id}`)).rows[0];
      const refundReview = review
        ? {
            status: review.status === 'decided' ? ('decided' as const) : ('in_review' as const),
            decision: review.status === 'decided' ? review.decision : null,
            refundKopecks: review.status === 'decided' && review.refund_kopecks !== null ? Number(review.refund_kopecks) : null,
            reason: review.status === 'decided' ? review.decision_reason : null,
            decidedAt: review.status === 'decided' && review.decided_at ? new Date(review.decided_at).toISOString() : null,
          }
        : null;
      return { ...base, price: customerPrice, refundReview };
    }
    // Компании — сумма к получению после комиссии (Н-22) и статус оплаты заказчиком (П-9); без уведомлений об оплате (ТЗ §14).
    const amount = order.partner_amount_kopecks !== null
      ? Number(order.partner_amount_kopecks)
      : order.partner_org_id ? (await this.settlement.split(order)).partner : null;
    const paid = Number(order.paid_kopecks);
    const manager = order.managing_member_id
      ? (await this.core.db.execute<{ id: string; full_name: string | null }>(sql`
          SELECT m.id, u.full_name FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.id = ${order.managing_member_id}`)).rows[0] ?? null
      : null;
    const partnerView = {
      ...base,
      // Управляющий диспетчер (Р-1, П-8).
      manager: manager ? { memberId: manager.id, fullName: manager.full_name } : null,
      partnerPrice: {
        amountKopecks: amount,
        deliveryKm: order.partner_delivery_km !== null ? Number(order.partner_delivery_km) : null,
        final: order.partner_amount_kopecks !== null,
      },
      customerPaymentStatus: paid === 0 ? 'not_paid' : paid >= payableOf(order) ? 'paid' : 'partially_paid',
    };
    return audience === 'admin' ? { ...partnerView, price: customerPrice } : partnerView;
  }

  private async ownOrder(customerId: string, orderId: string): Promise<OrderRow> {
    const order = await this.core.get(orderId);
    if (order.customer_id !== customerId) throw new AppException(ERROR_CODES.NOT_FOUND, 'Заказ не найден', HttpStatus.NOT_FOUND);
    return order;
  }
}

/** Заказчик видит ФИО, фото и рейтинг назначенного машиниста (ТЗ §4, В-30). */
function toOperator(u: { id: string; full_name: string | null; photo_file_id: string | null; rating: number | null } | undefined) {
  return u ? { userId: u.id, fullName: u.full_name, photoFileId: u.photo_file_id, rating: u.rating } : null;
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/** Сумма к оплате заказчиком: полная стоимость + продления − скидка. */
export const payableOf = (o: { total_kopecks: string; extra_kopecks: string; discount_kopecks: string }) =>
  Number(o.total_kopecks) + Number(o.extra_kopecks) - Number(o.discount_kopecks);
