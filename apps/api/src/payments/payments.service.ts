import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES, type PaymentView } from '@kovsh/contracts';
import { sql } from 'drizzle-orm';
import { AppException } from '../common/app-exception';
import { ACC, LedgerService } from '../finance/ledger.service';
import { SettlementService } from '../finance/settlement.service';
import { AssignmentService } from '../orders/assignment.service';
import { OrderCore } from '../orders/order-core';
import { PAYMENT_PROVIDER, type PaymentEvent, type PaymentProvider } from './payment.provider';

type PaymentRow = {
  id: string;
  order_id: string;
  part: 'first' | 'final';
  amount_kopecks: string;
  provider: string;
  provider_payment_id: string | null;
  confirmation_url: string | null;
  status: PaymentView['status'];
  created_at: Date;
  paid_at: Date | null;
};

const toView = (p: PaymentRow): PaymentView => ({
  id: p.id, part: p.part, amountKopecks: Number(p.amount_kopecks), status: p.status, confirmationUrl: p.confirmation_url,
  createdAt: new Date(p.created_at).toISOString(), paidAt: p.paid_at ? new Date(p.paid_at).toISOString() : null,
});

/**
 * Приём оплаты (ТЗ §14; решения 07): физлицо — 100% после принятия, юрлицо — 50% после принятия и 50% после завершения.
 * Защита от повторного списания: один ожидающий и один успешный платёж каждой части (уникальные индексы),
 * уведомления провайдера обрабатываются один раз (event_id), проводки — по ключу платежа.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly core: OrderCore,
    private readonly ledger: LedgerService,
    private readonly settlement: SettlementService,
    private readonly assignment: AssignmentService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  /** Какую часть и сколько заказчик должен оплатить сейчас. */
  private due(order: { status: string; prepayment_kopecks: string; total_kopecks: string; paid_kopecks: string; prepaid_at: Date | null }):
    { part: 'first' | 'final'; amount: number } | null {
    if (order.status === 'awaiting_prepayment' && !order.prepaid_at) return { part: 'first', amount: Number(order.prepayment_kopecks) };
    if (order.status === 'awaiting_final_payment') {
      const remaining = Number(order.total_kopecks) - Number(order.paid_kopecks);
      return remaining > 0 ? { part: 'final', amount: remaining } : null;
    }
    return null;
  }

  /** «Оплатить»: повторное нажатие возвращает тот же ожидающий платёж (без второго списания). */
  async create(customerId: string, orderId: string): Promise<PaymentView> {
    const order = await this.core.get(orderId);
    if (order.customer_id !== customerId) throw new AppException(ERROR_CODES.NOT_FOUND, 'Заказ не найден', HttpStatus.NOT_FOUND);
    const due = this.due(order);
    if (!due) throw new AppException(ERROR_CODES.PAYMENT_NOT_DUE, 'Сейчас по заказу ничего не нужно оплачивать', HttpStatus.CONFLICT);

    const existing = await this.core.db.execute<PaymentRow>(sql`
      SELECT * FROM payments WHERE order_id = ${orderId} AND part = ${due.part} AND status = 'pending' AND amount_kopecks = ${due.amount}`);
    if (existing.rows[0]) return toView(existing.rows[0]);

    const key = `pay:${orderId}:${due.part}:${due.amount}:${Date.now()}`;
    const inserted = await this.core.db.execute<PaymentRow>(sql`
      INSERT INTO payments (order_id, part, amount_kopecks, provider, idempotency_key)
      VALUES (${orderId}, ${due.part}, ${due.amount}, ${this.provider.name}, ${key})
      ON CONFLICT DO NOTHING RETURNING *`);
    const row = inserted.rows[0];
    if (!row) {
      // Параллельный запрос уже создал платёж — вернём его.
      const again = await this.core.db.execute<PaymentRow>(sql`SELECT * FROM payments WHERE order_id = ${orderId} AND part = ${due.part} AND status = 'pending'`);
      if (again.rows[0]) return toView(again.rows[0]);
      throw new AppException(ERROR_CODES.CONFLICT, 'Платёж уже создаётся, повторите', HttpStatus.CONFLICT);
    }
    const created = await this.provider.createPayment({
      amountKopecks: due.amount,
      description: `Заказ №${order.number}: ${due.part === 'first' ? 'оплата' : 'оставшаяся часть'}`,
      idempotencyKey: key,
      metadata: { orderId, paymentId: row.id, part: due.part },
    });
    const upd = await this.core.db.execute<PaymentRow>(sql`
      UPDATE payments SET provider_payment_id = ${created.providerPaymentId}, confirmation_url = ${created.confirmationUrl}
      WHERE id = ${row.id} RETURNING *`);
    return toView(upd.rows[0] as PaymentRow);
  }

  async list(customerId: string | null, orderId: string): Promise<PaymentView[]> {
    if (customerId) {
      const order = await this.core.get(orderId);
      if (order.customer_id !== customerId) throw new AppException(ERROR_CODES.NOT_FOUND, 'Заказ не найден', HttpStatus.NOT_FOUND);
    }
    const res = await this.core.db.execute<PaymentRow>(sql`SELECT * FROM payments WHERE order_id = ${orderId} ORDER BY created_at`);
    return res.rows.map(toView);
  }

  /** Уведомление провайдера. Повторная доставка того же события ничего не меняет. */
  async handleWebhook(headers: Record<string, string | string[] | undefined>, body: unknown): Promise<void> {
    const event = this.provider.parseWebhook(headers, body);
    const fresh = await this.core.db.execute<{ id: number }>(sql`
      INSERT INTO payment_webhook_events (provider, event_id, payload) VALUES (${this.provider.name}, ${event.eventId}, ${JSON.stringify(event)}::jsonb)
      ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`);
    if (!fresh.rows[0]) return;
    await this.applyEvent(event);
    await this.core.db.execute(sql`UPDATE payment_webhook_events SET processed_at = now() WHERE provider = ${this.provider.name} AND event_id = ${event.eventId}`);
  }

  private async applyEvent(event: PaymentEvent): Promise<void> {
    const res = await this.core.db.execute<PaymentRow>(sql`SELECT * FROM payments WHERE provider = ${this.provider.name} AND provider_payment_id = ${event.providerPaymentId}`);
    const payment = res.rows[0];
    if (!payment) {
      this.logger.warn(`Уведомление о неизвестном платеже ${event.providerPaymentId}`);
      return;
    }
    if (event.type === 'payment.cancelled') {
      await this.core.db.execute(sql`UPDATE payments SET status = 'cancelled' WHERE id = ${payment.id} AND status = 'pending'`);
      return;
    }
    if (event.amountKopecks !== Number(payment.amount_kopecks)) throw new Error('Сумма уведомления не совпадает с платежом');

    let confirmFirst = false;
    let finalPaid = false;
    await this.core.db.transaction(async (tx) => {
      const order = await this.core.lock(tx, payment.order_id);
      const upd = await tx.execute<{ id: string }>(sql`UPDATE payments SET status = 'succeeded', paid_at = now() WHERE id = ${payment.id} AND status <> 'succeeded' RETURNING id`);
      if (!upd.rows[0]) return;
      const amount = Number(payment.amount_kopecks);
      await this.ledger.post(tx, 'payment_received', `payment:${payment.id}`, order.id, [
        { account: ACC.cash(this.provider.name), amount },
        { account: ACC.customer(order.id), amount: -amount },
      ], { part: payment.part });
      await tx.execute(sql`UPDATE orders SET paid_kopecks = paid_kopecks + ${amount} WHERE id = ${order.id}`);
      if (payment.part === 'first') {
        if (order.status === 'awaiting_prepayment') confirmFirst = true;
        else {
          // Деньги пришли, когда заказ уже отменён (например, истекли 10 минут) — решение по возврату за поддержкой (07).
          await this.settlement.openCancellationReview(tx, order.id, 'system', 'Оплата поступила после отмены заказа');
        }
      } else if (order.status === 'awaiting_final_payment') {
        finalPaid = true;
        await this.core.jobs.cancel(`order:${order.id}:final`, tx);
        await tx.execute(sql`UPDATE customer_debts SET status = 'paid', closed_at = now() WHERE order_id = ${order.id} AND status = 'open'`);
        await this.core.transition(tx, order, 'completed', { type: 'customer', id: order.customer_id }, { reason: 'Оставшаяся часть оплачена' });
      }
      await this.core.events.emit({ type: 'payment.succeeded', orderId: order.id, userIds: [order.customer_id], payload: { part: payment.part, amountKopecks: amount } }, tx);
    });
    if (confirmFirst) await this.assignment.confirmPrepayment(payment.order_id);
    if (finalPaid) this.logger.log(`Заказ ${payment.order_id}: оплачена оставшаяся часть`);
  }

  /** Тестовая оплата (только dev-провайдер): имитирует уведомление провайдера. */
  async devComplete(providerPaymentId: string, result: 'succeeded' | 'cancelled'): Promise<void> {
    if (this.provider.name !== 'dev') throw new AppException(ERROR_CODES.NOT_FOUND, 'Не найдено', HttpStatus.NOT_FOUND);
    const res = await this.core.db.execute<PaymentRow>(sql`SELECT * FROM payments WHERE provider_payment_id = ${providerPaymentId}`);
    const p = res.rows[0];
    if (!p) throw new AppException(ERROR_CODES.NOT_FOUND, 'Платёж не найден', HttpStatus.NOT_FOUND);
    await this.handleWebhook({}, {
      eventId: `${providerPaymentId}:${result}`, type: result === 'succeeded' ? 'payment.succeeded' : 'payment.cancelled',
      providerPaymentId, amountKopecks: Number(p.amount_kopecks),
    });
  }
}
