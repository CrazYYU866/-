import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Database } from '../database/database.module';
import { SettingsService } from '../settings/settings.service';
import { ACC, LedgerService } from './ledger.service';
import { completionSplit, type CompletionSplit } from './split';

type Executor = Pick<Database, 'execute'>;

export interface SettleableOrder {
  id: string;
  agent_org_id: string | null;
  partner_org_id: string | null;
  total_kopecks: string | number;
  extra_kopecks?: string | number | null;
  customer_delivery_kopecks: string | number;
  partner_delivery_kopecks: string | number | null;
}

/** Финансовые последствия жизненного цикла заказа: расчёт при завершении, заявка поддержке при отмене после оплаты. */
@Injectable()
export class SettlementService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly settings: SettingsService,
  ) {}

  async split(order: SettleableOrder): Promise<CompletionSplit> {
    const [commissionPercent, agentPercent] = await Promise.all([
      this.settings.get('platform_commission_percent'),
      this.settings.get('agent_commission_percent'),
    ]);
    const customerDelivery = Number(order.customer_delivery_kopecks);
    return completionSplit({
      // Сумма заказа включает подтверждённые дополнительные часы (Н-5, Н-28) — комиссия считается от полной суммы (Ф-1).
      totalKopecks: Number(order.total_kopecks) + Number(order.extra_kopecks ?? 0),
      commissionPercent,
      agentPercent,
      hasAgent: Boolean(order.agent_org_id),
      customerDeliveryKopecks: customerDelivery,
      partnerDeliveryKopecks: order.partner_delivery_kopecks === null ? customerDelivery : Number(order.partner_delivery_kopecks),
    });
  }

  /**
   * Завершение заказа: начисления исполнителю, диспетчеру и платформе, компенсация доставки (Ф-1, Ф-2, П-3).
   * Повторный вызов ничего не начисляет (ключ settle:{order}).
   */
  async settleCompletion(tx: Executor, order: SettleableOrder): Promise<CompletionSplit> {
    if (!order.partner_org_id) throw new Error('Завершённый заказ без исполнителя');
    const s = await this.split(order);
    const total = Number(order.total_kopecks) + Number(order.extra_kopecks ?? 0);
    const lines = [
      { account: ACC.customer(order.id), amount: total },
      { account: ACC.partner(order.partner_org_id), amount: -(total - s.commission) },
      { account: ACC.platformCommission, amount: -s.platform },
    ];
    if (s.agent > 0 && order.agent_org_id) lines.push({ account: ACC.agent(order.agent_org_id), amount: -s.agent });
    if (s.deliverySubsidy > 0) {
      lines.push({ account: ACC.platformDeliverySubsidy, amount: s.deliverySubsidy }, { account: ACC.partner(order.partner_org_id), amount: -s.deliverySubsidy });
    } else if (s.deliverySubsidy < 0) {
      lines.push({ account: ACC.partner(order.partner_org_id), amount: -s.deliverySubsidy }, { account: ACC.platformDeliverySavings, amount: s.deliverySubsidy });
    }
    const posted = await this.ledger.post(tx, 'order_settled', `settle:${order.id}`, order.id, lines, { ...s });
    if (posted) {
      await tx.execute(sql`
        UPDATE orders SET settled_at = now(), commission_kopecks = ${s.commission}, agent_kopecks = ${s.agent}, platform_kopecks = ${s.platform},
          partner_amount_kopecks = ${s.partner}, delivery_subsidy_kopecks = ${s.deliverySubsidy}
        WHERE id = ${order.id}`);
    }
    return s;
  }

  /** Есть ли у заказчика открытый долг (К-9): по пользователю или по ИНН его юрлица. */
  async hasOpenDebt(tx: Executor, customerId: string, inn?: string | null): Promise<boolean> {
    const res = await tx.execute<{ ok: boolean }>(sql`
      SELECT true AS ok FROM customer_debts WHERE status = 'open' AND (customer_id = ${customerId} ${inn ? sql`OR inn = ${inn}` : sql``}) LIMIT 1`);
    return Boolean(res.rows[0]);
  }

  /** Отмена после оплаты: решение принимает поддержка (решения 07). Автоматического возврата и удержания нет. */
  async openCancellationReview(tx: Executor, orderId: string, initiatedBy: 'customer' | 'partner' | 'system' | 'admin', reason: string | null): Promise<void> {
    await tx.execute(sql`
      INSERT INTO cancellation_reviews (order_id, initiated_by, reason, paid_kopecks)
      SELECT id, ${initiatedBy}, ${reason}, paid_kopecks - refunded_kopecks FROM orders WHERE id = ${orderId} AND paid_kopecks > refunded_kopecks
      ON CONFLICT (order_id) DO NOTHING`);
  }
}
