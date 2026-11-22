import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@kovsh/contracts';
import { sql } from 'drizzle-orm';
import { AppException } from '../common/app-exception';
import type { Database } from '../database/database.module';

type Executor = Pick<Database, 'execute'>;

const ACTIVE = sql`('awaiting_customer_confirmation', 'searching', 'offered', 'awaiting_prepayment', 'awaiting_assignment', 'assigned',
  'en_route', 'arrived', 'in_progress', 'awaiting_completion_confirmation', 'disputed')`;
const SUCCESS = sql`('completed', 'awaiting_final_payment')`;

const invalid = (message: string) => new AppException(ERROR_CODES.PROMO_INVALID, message, HttpStatus.UNPROCESSABLE_ENTITY);

/**
 * Промокоды (В-33, К-13, Л-8, Н-15).
 * — «Первый заказ» = первый успешно завершённый; отменённый заказ право на скидку не тратит.
 * — Один телефон = один заказчик; для юрлица ограничение по ИНН.
 * — Скидка закреплена только за одним активным заказом; при отмене освобождается.
 */
@Injectable()
export class PromoService {
  async validate(tx: Executor, code: string, customerId: string, inn: string | null, excludeOrderId?: string): Promise<{ id: string; percent: number }> {
    const res = await tx.execute<{ id: string; percent: number; first_order_only: boolean; valid_from: Date | null; valid_to: Date | null; max_uses: number | null; personal_user_id: string | null; active: boolean }>(sql`
      SELECT * FROM promo_codes WHERE code = ${code}`);
    const p = res.rows[0];
    if (!p || !p.active) throw invalid('Промокод не найден');
    const now = Date.now();
    if (p.valid_from && new Date(p.valid_from).getTime() > now) throw invalid('Промокод ещё не действует');
    if (p.valid_to && new Date(p.valid_to).getTime() < now) throw invalid('Срок действия промокода истёк');
    if (p.personal_user_id && p.personal_user_id !== customerId) throw invalid('Этот промокод выдан другому заказчику');
    const exclude = excludeOrderId ? sql`AND o.id <> ${excludeOrderId}` : sql``;
    if (p.max_uses !== null) {
      const used = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM orders o WHERE o.promo_code_id = ${p.id} AND (o.status IN ${ACTIVE} OR o.status IN ${SUCCESS}) ${exclude}`);
      if ((used.rows[0]?.n ?? 0) >= p.max_uses) throw invalid('Лимит использований промокода исчерпан');
    }
    const who = inn
      ? sql`(o.customer_id = ${customerId} OR lp.inn = ${inn})`
      : sql`(o.customer_id = ${customerId})`;
    if (p.first_order_only) {
      const done = await tx.execute(sql`
        SELECT 1 FROM orders o LEFT JOIN customer_legal_profiles lp ON lp.id = o.payer_legal_profile_id
        WHERE ${who} AND o.status IN ${SUCCESS} ${exclude} LIMIT 1`);
      if (done.rows[0]) throw invalid('Скидка действует только на первый заказ');
    }
    // Скидка закреплена только за одним активным заказом (Л-8).
    const reserved = await tx.execute(sql`
      SELECT 1 FROM orders o LEFT JOIN customer_legal_profiles lp ON lp.id = o.payer_legal_profile_id
      WHERE ${who} AND o.discount_kopecks > 0 AND o.status IN ${ACTIVE} ${exclude} LIMIT 1`);
    if (reserved.rows[0]) throw invalid('Скидка уже применена к другому активному заказу');
    return { id: p.id, percent: p.percent };
  }

  /** Скидка от полной стоимости, до целого рубля (Н-6). */
  discount(totalKopecks: number, percent: number): number {
    return Math.round((totalKopecks * percent) / 100 / 100) * 100;
  }
}
