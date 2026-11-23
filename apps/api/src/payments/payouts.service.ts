import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { APP_ENV } from '../config/config.module';
import type { AppEnv } from '../config/env';
import { sql } from 'drizzle-orm';
import { FieldCipher } from '../common/crypto/field-cipher';
import { ACC, LedgerService } from '../finance/ledger.service';
import { OrderCore } from '../orders/order-core';
import { SettingsService } from '../settings/settings.service';
import { PAYMENT_PROVIDER, type PaymentProvider } from './payment.provider';

const TZ = 'Europe/Moscow';

type Accrual = {
  order_id: string;
  org_id: string;
  kind: 'partner' | 'agent';
  source: 'completion' | 'cancellation';
  amount: string;
};

/**
 * Выплаты исполнителям и независимым диспетчерам на следующий календарный день после окончательного завершения (Н-10)
 * или решения по отмене. Не зависят от оплаты второй части. Спорные заказы не выплачиваются до решения.
 * Одна выплата по каждому заказу и получателю (PK payout_items) — повторная выплата невозможна.
 */
@Injectable()
export class PayoutsService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    private readonly core: OrderCore,
    private readonly ledger: LedgerService,
    private readonly cipher: FieldCipher,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly settings: SettingsService,
  ) {}

  /** Первое ежедневное задание ставится при старте (ключ не даёт поставить дубль). */
  async onApplicationBootstrap(): Promise<void> {
    if (this.env.NODE_ENV !== 'test') await this.scheduleNext();
  }

  onModuleInit(): void {
    this.core.jobs.register('payouts_daily', async () => {
      await this.run();
      await this.scheduleNext();
    });
  }

  async scheduleNext(): Promise<void> {
    const res = await this.core.db.execute<{ at: Date }>(sql`
      SELECT ((date_trunc('day', now() AT TIME ZONE ${TZ}) + interval '1 day 10 minutes') AT TIME ZONE ${TZ}) AS at`);
    await this.core.jobs.schedule('payouts_daily', {}, new Date(res.rows[0]?.at ?? Date.now() + 86_400_000), { dedupeKey: 'payouts:daily' });
  }

  /** Начисления, созревшие к выплате: завершены или решены до начала текущих суток (МСК). */
  async run(): Promise<{ payouts: number; blocked: number }> {
    // «today.start» — граница: выплачивается то, что созрело раньше начала суток (МСК) минус (задержка − 1) дней.
    const delay = await this.settings.get('payout_delay_days');
    const accruals = await this.core.db.execute<Accrual>(sql`
      WITH today AS (SELECT (date_trunc('day', now() AT TIME ZONE ${TZ}) AT TIME ZONE ${TZ}) - (${delay - 1} * interval '1 day') AS start)
      SELECT o.id AS order_id, o.partner_org_id AS org_id, 'partner' AS kind, 'completion' AS source, o.partner_amount_kopecks AS amount
        FROM orders o, today WHERE o.settled_at IS NOT NULL AND o.completed_at < today.start
          AND o.status IN ('completed', 'awaiting_final_payment') AND o.partner_amount_kopecks > 0
      UNION ALL
      SELECT o.id, o.agent_org_id, 'agent', 'completion', o.agent_kopecks
        FROM orders o, today WHERE o.settled_at IS NOT NULL AND o.completed_at < today.start
          AND o.status IN ('completed', 'awaiting_final_payment') AND o.agent_org_id IS NOT NULL AND o.agent_kopecks > 0
      UNION ALL
      SELECT r.order_id, o.partner_org_id, 'partner', 'cancellation', r.partner_kopecks
        FROM cancellation_reviews r JOIN orders o ON o.id = r.order_id, today
        WHERE r.status = 'decided' AND r.decided_at < today.start AND r.partner_kopecks > 0 AND o.partner_org_id IS NOT NULL
      UNION ALL
      SELECT r.order_id, o.agent_org_id, 'agent', 'cancellation', r.agent_kopecks
        FROM cancellation_reviews r JOIN orders o ON o.id = r.order_id, today
        WHERE r.status = 'decided' AND r.decided_at < today.start AND r.agent_kopecks > 0 AND o.agent_org_id IS NOT NULL`);
    const pending: Accrual[] = [];
    for (const a of accruals.rows) {
      const paid = await this.core.db.execute(sql`SELECT 1 FROM payout_items WHERE order_id = ${a.order_id} AND kind = ${a.kind}`);
      if (!paid.rows[0]) pending.push(a);
    }
    const groups = new Map<string, Accrual[]>();
    for (const a of pending) groups.set(`${a.org_id}:${a.kind}`, [...(groups.get(`${a.org_id}:${a.kind}`) ?? []), a]);

    let payouts = 0;
    let blocked = 0;
    const date = (await this.core.db.execute<{ d: string }>(sql`SELECT to_char(now() AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS d`)).rows[0]?.d as string;
    for (const items of groups.values()) {
      const first = items[0] as Accrual;
      const ok = await this.payOne(first.org_id, first.kind, date, items);
      if (ok) payouts++;
      else blocked++;
    }
    return { payouts, blocked };
  }

  private async payOne(orgId: string, kind: 'partner' | 'agent', date: string, items: Accrual[]): Promise<boolean> {
    const amount = items.reduce((s, i) => s + Number(i.amount), 0);
    const bank = await this.core.db.execute<{ id: string; bik: string; account_number_enc: string; inn: string }>(sql`
      SELECT b.id, b.bik, b.account_number_enc, o.inn FROM organization_bank_accounts b JOIN organizations o ON o.id = b.org_id
      WHERE b.org_id = ${orgId} AND b.is_current`);
    const account = bank.rows[0];
    if (!account) {
      // Без реквизитов выплата не создаётся; начисления останутся до появления реквизитов.
      await this.core.events.emit({ type: 'payout.blocked_no_bank_account', orgId, userIds: [], payload: { kind, amountKopecks: amount, admin: true } });
      return false;
    }
    let payoutId: string | null = null;
    await this.core.db.transaction(async (tx) => {
      const ins = await tx.execute<{ id: string }>(sql`
        INSERT INTO payouts (org_id, kind, payout_date, amount_kopecks, bank_account_id, provider)
        VALUES (${orgId}, ${kind}, ${date}::date, ${amount}, ${account.id}, ${this.provider.name})
        ON CONFLICT (org_id, kind, payout_date) DO NOTHING RETURNING id`);
      payoutId = ins.rows[0]?.id ?? null;
      if (!payoutId) return;
      for (const i of items) {
        await tx.execute(sql`INSERT INTO payout_items (payout_id, order_id, kind, source, amount_kopecks) VALUES (${payoutId}, ${i.order_id}, ${kind}, ${i.source}, ${Number(i.amount)})`);
      }
    });
    if (!payoutId) return false;
    const r = await this.provider.payout({
      amountKopecks: amount, bik: account.bik, accountNumber: this.cipher.decrypt(account.account_number_enc), recipientInn: account.inn,
      idempotencyKey: `payout:${payoutId}`, description: `Выплата «Ковш на Час» за ${date}`,
    });
    await this.core.db.execute(sql`UPDATE payouts SET provider_payout_id = ${r.providerPayoutId} WHERE id = ${payoutId}`);
    // Выплата у реального провайдера может завершиться позже — тогда итог придёт уведомлением (payout.succeeded / payout.cancelled).
    if (r.status === 'succeeded') await this.completePayout(payoutId);
    this.logger.log(`Выплата ${kind} ${orgId}: ${amount} коп.`);
    return true;
  }

  /** Выплата подтверждена провайдером: проводка по счёту исполнителя/диспетчера. Повторный вызов ничего не меняет. */
  async completePayout(payoutId: string): Promise<void> {
    await this.core.db.transaction(async (tx) => {
      const p = (await tx.execute<{ org_id: string; kind: 'partner' | 'agent'; amount_kopecks: string; payout_date: string }>(sql`
        UPDATE payouts SET status = 'paid', paid_at = now() WHERE id = ${payoutId} AND status = 'processing'
        RETURNING org_id, kind, amount_kopecks, payout_date::text AS payout_date`)).rows[0];
      if (!p) return;
      const amount = Number(p.amount_kopecks);
      await this.ledger.post(tx, 'payout', `payout:${payoutId}`, null, [
        { account: p.kind === 'partner' ? ACC.partner(p.org_id) : ACC.agent(p.org_id), amount },
        { account: ACC.cash(this.provider.name), amount: -amount },
      ], { orgId: p.org_id, kind: p.kind, date: p.payout_date });
    });
  }

  /** Провайдер не смог выплатить (например, неверные реквизиты): выплата отмечается, финансист получает задачу. */
  async failPayout(payoutId: string, reason: string): Promise<void> {
    await this.core.db.transaction(async (tx) => {
      const p = (await tx.execute<{ org_id: string }>(sql`
        UPDATE payouts SET status = 'failed', status_reason = ${reason} WHERE id = ${payoutId} AND status = 'processing' RETURNING org_id`)).rows[0];
      if (!p) return;
      const staff = await this.core.partnerStaff(p.org_id, tx);
      await this.core.events.emit({ type: 'payout.failed', orgId: p.org_id, userIds: staff, payload: { reason, admin: true } }, tx);
    });
  }
}
