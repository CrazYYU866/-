import { HttpStatus, Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ERROR_CODES } from '@kovsh/contracts';
import { sql } from 'drizzle-orm';
import type { AuthAdmin } from '../admin/admin-auth.guard';
import { AuditService } from '../audit/audit.service';
import { AppException } from '../common/app-exception';
import { ACC, LedgerService } from '../finance/ledger.service';
import { retentionSplit } from '../finance/split';
import { OrderCore, type Tx } from '../orders/order-core';
import { SettingsService } from '../settings/settings.service';
import { PAYMENT_PROVIDER, type PaymentProvider } from './payment.provider';

type ReviewRow = {
  id: string;
  order_id: string;
  status: 'pending' | 'awaiting_approval' | 'decided';
  paid_kopecks: string;
  retained_kopecks: string | null;
  refund_kopecks: string | null;
  decision_reason: string | null;
  decided_by: string | null;
};

/**
 * Отмена после оплаты (решения 07): поддержка решает — полный возврат, частичный возврат или полное удержание.
 * Удержанное делится по Ф-3. Возврат сверх лимита поддержки (К-14, по сумме возвратов заказа — Л-9) подтверждает финансист или суперадмин.
 */
@Injectable()
export class CancellationService implements OnModuleInit {
  constructor(
    private readonly core: OrderCore,
    private readonly ledger: LedgerService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  onModuleInit(): void {
    this.core.jobs.register('auto_refund', (p) => this.autoRefund(String(p['orderId'])));
    this.core.jobs.register('refund_execute', (p) => this.executeRefund(String(p['refundId'])));
  }

  /**
   * Автоматический полный возврат без поддержки (повторно не выполняется — ключи возвратов по платежам):
   * — исполнитель или замена не найдены после оплаты (Н-29);
   * — оплата пришла, когда заказ уже был отменён без оплаты, например истекли 10 минут (Н-31).
   * Если по заказу уже есть решение поддержки об отмене, автоматического возврата нет.
   */
  async autoRefund(orderId: string): Promise<void> {
    await this.core.db.transaction(async (tx) => {
      const order = await this.core.lock(tx, orderId);
      const review = await tx.execute(sql`SELECT 1 FROM cancellation_reviews WHERE order_id = ${orderId}`);
      const lateAfterCancel = ['cancelled_unpaid', 'cancelled', 'search_failed'].includes(order.status) && !review.rows[0];
      if (order.status !== 'refund_pending' && !lateAfterCancel) return;
      const refundable = Number(order.paid_kopecks) - Number(order.refunded_kopecks);
      if (refundable <= 0) return;
      const reason = order.status === 'refund_pending' ? 'Исполнитель не найден — полный возврат' : 'Оплата поступила после отмены заказа — полный возврат';
      await this.history(tx, orderId, `Автоматический возврат: ${reason}`, null, { refund: refundable });
      await this.execute(tx, orderId, 0, refundable, reason, null, null);
    });
  }

  async list(status?: string) {
    const res = await this.core.db.execute(sql`
      SELECT r.*, o.number, o.status AS order_status, o.cancelled_by, o.cancellation_reason, o.agent_org_id IS NOT NULL AS via_agent
      FROM cancellation_reviews r JOIN orders o ON o.id = r.order_id
      ${status ? sql`WHERE r.status = ${status}` : sql``} ORDER BY r.created_at`);
    return res.rows;
  }

  async decide(orderId: string, retained: number, reason: string, admin: AuthAdmin) {
    const review = await this.loadReview(orderId);
    if (review.status !== 'pending') throw new AppException(ERROR_CODES.REVIEW_NOT_PENDING, 'Решение по этой отмене уже принято или ждёт подтверждения', HttpStatus.CONFLICT);
    const paid = Number(review.paid_kopecks);
    if (retained > paid) throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'Удержание не может быть больше оплаченной суммы', HttpStatus.BAD_REQUEST);
    const refund = paid - retained;
    const decision = refund === 0 ? 'full_retention' : retained === 0 ? 'full_refund' : 'partial_refund';
    const limit = await this.settings.get('support_refund_limit_kopecks');
    const refundedSoFar = await this.refundedTotal(orderId);
    const needsApproval = admin.role === 'support' && refund > 0 && refundedSoFar + refund > limit;

    await this.core.db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE cancellation_reviews SET status = ${needsApproval ? 'awaiting_approval' : 'decided'}, decision = ${decision},
          retained_kopecks = ${retained}, refund_kopecks = ${refund}, decision_reason = ${reason}, decided_by = ${admin.adminId}, decided_at = now()
        WHERE id = ${review.id}`);
      await this.history(tx, orderId, `Решение поддержки: ${label(decision)}${needsApproval ? ' (ждёт подтверждения финансиста)' : ''}`, admin.adminId, { retained, refund, reason });
      await this.audit.log({ adminId: admin.adminId, action: 'cancellation.decide', entity: 'order', entityId: orderId, after: { decision, retained, refund, needsApproval }, reason, ip: admin.ip }, tx);
      if (!needsApproval) await this.execute(tx, orderId, retained, refund, reason, admin.adminId, admin.adminId);
    });
    return this.loadReview(orderId);
  }

  /** Подтверждение крупного возврата финансистом или суперадминистратором (К-14). */
  async approve(orderId: string, admin: AuthAdmin) {
    const review = await this.loadReview(orderId);
    if (review.status !== 'awaiting_approval') throw new AppException(ERROR_CODES.REVIEW_NOT_PENDING, 'Нет решения, ожидающего подтверждения', HttpStatus.CONFLICT);
    await this.core.db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE cancellation_reviews SET status = 'decided' WHERE id = ${review.id}`);
      await this.history(tx, orderId, 'Возврат подтверждён', admin.adminId, null);
      await this.audit.log({ adminId: admin.adminId, action: 'cancellation.approve', entity: 'order', entityId: orderId, ip: admin.ip }, tx);
      await this.execute(tx, orderId, Number(review.retained_kopecks), Number(review.refund_kopecks), review.decision_reason ?? '', review.decided_by, admin.adminId);
    });
    return this.loadReview(orderId);
  }

  /** Отклонение: решение возвращается поддержке на пересмотр. */
  async reject(orderId: string, reason: string, admin: AuthAdmin) {
    const review = await this.loadReview(orderId);
    if (review.status !== 'awaiting_approval') throw new AppException(ERROR_CODES.REVIEW_NOT_PENDING, 'Нет решения, ожидающего подтверждения', HttpStatus.CONFLICT);
    await this.core.db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE cancellation_reviews SET status = 'pending', decision = NULL, retained_kopecks = NULL, refund_kopecks = NULL,
          decision_reason = NULL, decided_by = NULL, decided_at = NULL WHERE id = ${review.id}`);
      await this.history(tx, orderId, `Возврат не подтверждён: ${reason}`, admin.adminId, null);
      await this.audit.log({ adminId: admin.adminId, action: 'cancellation.reject', entity: 'order', entityId: orderId, reason, ip: admin.ip }, tx);
    });
    return this.loadReview(orderId);
  }

  /** Проводки удержания (Ф-3) и возврат через провайдера. Каждая операция — по своему ключу, повтор невозможен. */
  private async execute(tx: Tx, orderId: string, retained: number, refund: number, reason: string, requestedBy: string | null, approvedBy: string | null): Promise<void> {
    const order = await this.core.lock(tx, orderId);
    if (retained > 0) {
      if (!order.partner_org_id) {
        // Исполнителя нет (например, не найден) — удержанное целиком остаётся платформе.
        await this.ledger.post(tx, 'cancellation_retained', `retain:${orderId}`, orderId, [
          { account: ACC.customer(orderId), amount: retained },
          { account: ACC.platformCommission, amount: -retained },
        ]);
        await tx.execute(sql`UPDATE cancellation_reviews SET partner_kopecks = 0, agent_kopecks = 0, platform_kopecks = ${retained} WHERE order_id = ${orderId}`);
      } else {
        const [commission, agentPct] = await Promise.all([this.settings.get('platform_commission_percent'), this.settings.get('agent_commission_percent')]);
        const s = retentionSplit(retained, commission, agentPct, Boolean(order.agent_org_id));
        const lines = [
          { account: ACC.customer(orderId), amount: retained },
          { account: ACC.partner(order.partner_org_id), amount: -s.partner },
          { account: ACC.platformCommission, amount: -s.platform },
        ];
        if (s.agent > 0 && order.agent_org_id) lines.push({ account: ACC.agent(order.agent_org_id), amount: -s.agent });
        await this.ledger.post(tx, 'cancellation_retained', `retain:${orderId}`, orderId, lines, { ...s });
        await tx.execute(sql`UPDATE cancellation_reviews SET partner_kopecks = ${s.partner}, agent_kopecks = ${s.agent}, platform_kopecks = ${s.platform} WHERE order_id = ${orderId}`);
      }
    }
    if (refund > 0) {
      const payments = await tx.execute<{ id: string; provider_payment_id: string; amount_kopecks: string }>(sql`
        SELECT id, provider_payment_id, amount_kopecks FROM payments WHERE order_id = ${orderId} AND status = 'succeeded' ORDER BY paid_at DESC`);
      let left = refund;
      for (const p of payments.rows) {
        if (left <= 0) break;
        const amount = Math.min(left, Number(p.amount_kopecks));
        const key = `refund:${orderId}:${p.id}`;
        const ins = await tx.execute<{ id: string }>(sql`
          INSERT INTO refunds (order_id, payment_id, amount_kopecks, status, reason, requested_by, approved_by, idempotency_key)
          VALUES (${orderId}, ${p.id}, ${amount}, 'processing', ${reason}, ${requestedBy}, ${approvedBy}, ${key})
          ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`);
        const refundId = ins.rows[0]?.id;
        if (!refundId) continue;
        // Обращение к провайдеру — после фиксации транзакции, заданием (внешний вызов внутри транзакции мог бы
        // вернуть деньги, а запись о возврате откатить). Повтор задания безопасен: ключ идемпотентности тот же.
        await this.core.jobs.schedule('refund_execute', { refundId }, new Date(), { dedupeKey: `refund:${refundId}`, tx });
        left -= amount;
      }
    }
    if (order.status === 'refund_pending') {
      await this.core.transition(tx, order, 'cancelled', approvedBy ? { type: 'admin', id: approvedBy } : { type: 'system' }, { reason: 'Возврат оформлен' });
    }
    await this.core.events.emit({ type: 'order.cancellation_decided', orderId, userIds: [order.customer_id], payload: { retained, refund } }, tx);
  }

  /** Передать возврат провайдеру. Итог приходит сразу или позже уведомлением (refund.succeeded / refund.cancelled). */
  async executeRefund(refundId: string): Promise<void> {
    const row = (await this.core.db.execute<{ status: string; provider_refund_id: string | null; amount_kopecks: string; idempotency_key: string; provider_payment_id: string }>(sql`
      SELECT r.status, r.provider_refund_id, r.amount_kopecks, r.idempotency_key, p.provider_payment_id
      FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE r.id = ${refundId}`)).rows[0];
    if (!row || row.status !== 'processing' || row.provider_refund_id) return;
    const r = await this.provider.refund(row.provider_payment_id, Number(row.amount_kopecks), row.idempotency_key);
    await this.core.db.execute(sql`UPDATE refunds SET provider_refund_id = ${r.providerRefundId} WHERE id = ${refundId}`);
    if (r.status === 'succeeded') await this.completeRefund(refundId);
  }

  /** Возврат подтверждён провайдером: проводка и сумма возврата по заказу. Повторный вызов ничего не меняет. */
  async completeRefund(refundId: string): Promise<void> {
    await this.core.db.transaction(async (tx) => {
      const r = (await tx.execute<{ order_id: string; amount_kopecks: string }>(sql`
        UPDATE refunds SET status = 'succeeded', completed_at = now() WHERE id = ${refundId} AND status = 'processing' RETURNING order_id, amount_kopecks`)).rows[0];
      if (!r) return;
      const amount = Number(r.amount_kopecks);
      await this.ledger.post(tx, 'refund', `refund:${refundId}`, r.order_id, [
        { account: ACC.customer(r.order_id), amount },
        { account: ACC.cash(this.provider.name), amount: -amount },
      ]);
      await tx.execute(sql`UPDATE orders SET refunded_kopecks = refunded_kopecks + ${amount} WHERE id = ${r.order_id}`);
      const order = await this.core.get(r.order_id, tx);
      await this.core.events.emit({ type: 'refund.succeeded', orderId: r.order_id, userIds: [order.customer_id], payload: { amountKopecks: amount } }, tx);
    });
  }

  /** Повтор возврата, отклонённого провайдером: новый ключ идемпотентности для каждой отклонённой попытки. */
  async retryRefund(refundId: string): Promise<void> {
    const r = (await this.core.db.execute<{ status: string; idempotency_key: string; provider_refund_id: string | null }>(sql`
      SELECT status, idempotency_key, provider_refund_id FROM refunds WHERE id = ${refundId}`)).rows[0];
    if (!r) throw new AppException(ERROR_CODES.NOT_FOUND, 'Возврат не найден', HttpStatus.NOT_FOUND);
    if (r.status !== 'failed') throw new AppException(ERROR_CODES.CONFLICT, 'Повторить можно только возврат, отклонённый провайдером', HttpStatus.CONFLICT);
    const key = `${r.idempotency_key.split(':after:')[0]}:after:${r.provider_refund_id ?? 'none'}`;
    const upd = await this.core.db.execute(sql`
      UPDATE refunds SET status = 'processing', provider_refund_id = NULL, idempotency_key = ${key} WHERE id = ${refundId} AND status = 'failed' RETURNING id`);
    if (!upd.rows[0]) return;
    await this.executeRefund(refundId);
  }

  async failedRefunds() {
    const res = await this.core.db.execute(sql`
      SELECT r.id, r.order_id, o.number, r.amount_kopecks, r.reason, r.created_at FROM refunds r JOIN orders o ON o.id = r.order_id
      WHERE r.status = 'failed' ORDER BY r.created_at DESC`);
    return res.rows;
  }

  /** Провайдер отказал в возврате: отмечаем, поддержка получает задачу (деньги не считаются возвращёнными). */
  async failRefund(refundId: string, reason: string): Promise<void> {
    await this.core.db.transaction(async (tx) => {
      const r = (await tx.execute<{ order_id: string }>(sql`
        UPDATE refunds SET status = 'failed' WHERE id = ${refundId} AND status = 'processing' RETURNING order_id`)).rows[0];
      if (!r) return;
      await this.core.events.emit({ type: 'refund.failed', orderId: r.order_id, userIds: [], payload: { reason, admin: true } }, tx);
    });
  }

  private async refundedTotal(orderId: string): Promise<number> {
    const res = await this.core.db.execute<{ s: string | null }>(sql`
      SELECT sum(amount_kopecks) AS s FROM refunds WHERE order_id = ${orderId} AND status IN ('processing', 'succeeded', 'pending_approval')`);
    return Number(res.rows[0]?.s ?? 0);
  }

  private async loadReview(orderId: string): Promise<ReviewRow> {
    const res = await this.core.db.execute<ReviewRow>(sql`SELECT * FROM cancellation_reviews WHERE order_id = ${orderId}`);
    const r = res.rows[0];
    if (!r) throw new AppException(ERROR_CODES.NOT_FOUND, 'По заказу нет отмены на рассмотрении', HttpStatus.NOT_FOUND);
    return r;
  }

  private async history(tx: Tx, orderId: string, reason: string, adminId: string | null, meta: Record<string, unknown> | null): Promise<void> {
    await tx.execute(sql`
      INSERT INTO order_status_history (order_id, from_status, to_status, actor_type, actor_id, reason, meta)
      SELECT id, status, status, 'admin', ${adminId}, ${reason}, ${meta ? JSON.stringify(meta) : null}::jsonb FROM orders WHERE id = ${orderId}`);
  }
}

const label = (d: string) => ({ full_refund: 'полный возврат', partial_refund: 'частичный возврат', full_retention: 'полное удержание' })[d] ?? d;
