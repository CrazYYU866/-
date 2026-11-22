import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Database } from '../database/database.module';

type Executor = Pick<Database, 'execute'>;

export interface LedgerLine {
  account: string;
  /** Дебет — положительное, кредит — отрицательное (копейки). */
  amount: number;
}

/** Счета журнала. */
export const ACC = {
  cash: (provider: string) => `cash:${provider}`,
  customer: (orderId: string) => `customer:${orderId}`,
  partner: (orgId: string) => `partner:${orgId}`,
  agent: (orgId: string) => `agent:${orgId}`,
  platformCommission: 'platform:commission',
  platformDeliverySubsidy: 'platform:delivery_subsidy',
  platformDeliverySavings: 'platform:delivery_savings',
};

/**
 * Финансовый журнал двойной записи (ТЗ §14, §19). Проводки транзакции в сумме дают ноль (проверяет БД).
 * Ключ идемпотентности уникален: одна и та же операция не будет проведена дважды.
 */
@Injectable()
export class LedgerService {
  /** Провести транзакцию. Возвращает false, если операция с таким ключом уже проведена. */
  async post(tx: Executor, kind: string, key: string, orderId: string | null, lines: LedgerLine[], meta?: Record<string, unknown>): Promise<boolean> {
    const nonZero = lines.filter((l) => l.amount !== 0);
    const sum = nonZero.reduce((s, l) => s + l.amount, 0);
    if (sum !== 0) throw new Error(`Несбалансированная транзакция ${kind}: ${sum}`);
    const res = await tx.execute<{ id: number }>(sql`
      INSERT INTO ledger_transactions (kind, order_id, idempotency_key, meta)
      VALUES (${kind}, ${orderId}, ${key}, ${meta ? JSON.stringify(meta) : null}::jsonb)
      ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`);
    const id = res.rows[0]?.id;
    if (!id) return false;
    for (const l of nonZero) {
      await tx.execute(sql`INSERT INTO ledger_entries (transaction_id, account, amount_kopecks, order_id) VALUES (${id}, ${l.account}, ${l.amount}, ${orderId})`);
    }
    return true;
  }

  async balance(tx: Executor, account: string): Promise<number> {
    const res = await tx.execute<{ s: string | null }>(sql`SELECT sum(amount_kopecks) AS s FROM ledger_entries WHERE account = ${account}`);
    return Number(res.rows[0]?.s ?? 0);
  }
}
