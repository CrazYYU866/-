import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES, type RateInput } from '@kovsh/contracts';
import { sql } from 'drizzle-orm';
import type { AuthAdmin } from '../admin/admin-auth.guard';
import { AuditService } from '../audit/audit.service';
import { AppException } from '../common/app-exception';
import { OrderCore } from '../orders/order-core';

const RATEABLE = ['completed', 'awaiting_final_payment'];

/**
 * Оценки (В-29, В-30): заказчик оценивает машиниста, исполнитель — заказчика. Публичных отзывов нет:
 * оценки видят участники заказа и администрация. Рейтинг — только у машиниста; учитывается в подборе.
 */
@Injectable()
export class RatingsService {
  constructor(
    private readonly core: OrderCore,
    private readonly audit: AuditService,
  ) {}

  async rateByCustomer(orderId: string, customerId: string, dto: RateInput) {
    const order = await this.core.get(orderId);
    if (order.customer_id !== customerId) throw new AppException(ERROR_CODES.NOT_FOUND, 'Заказ не найден', HttpStatus.NOT_FOUND);
    if (!RATEABLE.includes(order.status)) throw new AppException(ERROR_CODES.RATING_NOT_ALLOWED, 'Оценить можно после завершения заказа', HttpStatus.CONFLICT);
    const operators = (await this.core.db.execute<{ operator_user_id: string }>(sql`
      SELECT DISTINCT operator_user_id FROM order_shifts WHERE order_id = ${orderId} AND status = 'finished' AND operator_user_id IS NOT NULL`)).rows.map((r) => r.operator_user_id);
    const target = dto.targetUserId ?? (operators.length === 1 ? operators[0] : undefined);
    if (!target || !operators.includes(target)) throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'Укажите машиниста, работавшего на заказе', HttpStatus.BAD_REQUEST);
    return this.insert(orderId, customerId, 'customer', target, 'operator', dto);
  }

  async rateByPartner(orderId: string, userId: string, dto: RateInput) {
    const p = await this.core.participant(orderId, userId);
    if (!p.staffRole && !p.operator) throw new AppException(ERROR_CODES.NOT_FOUND, 'Заказ не найден', HttpStatus.NOT_FOUND);
    if (!RATEABLE.includes(p.order.status)) throw new AppException(ERROR_CODES.RATING_NOT_ALLOWED, 'Оценить можно после завершения заказа', HttpStatus.CONFLICT);
    return this.insert(orderId, userId, 'partner', p.order.customer_id, 'customer', dto);
  }

  private async insert(orderId: string, author: string, side: 'customer' | 'partner', target: string, kind: 'operator' | 'customer', dto: RateInput) {
    const res = await this.core.db.execute(sql`
      INSERT INTO ratings (order_id, author_user_id, author_side, target_user_id, target_kind, stars, text)
      VALUES (${orderId}, ${author}, ${side}, ${target}, ${kind}, ${dto.stars}, ${dto.text ?? null})
      ON CONFLICT (order_id, author_side, target_user_id) DO NOTHING RETURNING id, stars, text, created_at`);
    if (!res.rows[0]) throw new AppException(ERROR_CODES.CONFLICT, 'Оценка уже поставлена', HttpStatus.CONFLICT);
    return res.rows[0];
  }

  /** Оценки по заказу — только участникам заказа (В-29). */
  async forOrder(orderId: string, userId: string) {
    const p = await this.core.participant(orderId, userId);
    if (!p.customer && !p.staffRole && !p.operator) throw new AppException(ERROR_CODES.NOT_FOUND, 'Заказ не найден', HttpStatus.NOT_FOUND);
    const res = await this.core.db.execute(sql`
      SELECT id, author_side, target_kind, target_user_id, stars, text, created_at FROM ratings WHERE order_id = ${orderId} AND status = 'visible' ORDER BY created_at`);
    return res.rows;
  }

  async complain(ratingId: string, userId: string, reason: string) {
    const r = (await this.core.db.execute<{ target_user_id: string }>(sql`SELECT target_user_id FROM ratings WHERE id = ${ratingId}`)).rows[0];
    if (!r || r.target_user_id !== userId) throw new AppException(ERROR_CODES.NOT_FOUND, 'Оценка не найдена', HttpStatus.NOT_FOUND);
    const res = await this.core.db.execute(sql`
      INSERT INTO rating_complaints (rating_id, author_id, reason) VALUES (${ratingId}, ${userId}, ${reason})
      ON CONFLICT (rating_id, author_id) DO NOTHING RETURNING id`);
    if (!res.rows[0]) throw new AppException(ERROR_CODES.CONFLICT, 'Жалоба уже отправлена', HttpStatus.CONFLICT);
    return res.rows[0];
  }

  async complaints(status = 'open') {
    const res = await this.core.db.execute(sql`
      SELECT c.*, r.stars, r.text, r.order_id, r.status AS rating_status FROM rating_complaints c JOIN ratings r ON r.id = c.rating_id
      WHERE c.status = ${status} ORDER BY c.created_at`);
    return res.rows;
  }

  async setHidden(ratingId: string, hidden: boolean, reason: string | null, admin: AuthAdmin) {
    const res = await this.core.db.execute(sql`
      UPDATE ratings SET status = ${hidden ? 'hidden' : 'visible'}, hidden_reason = ${hidden ? reason : null} WHERE id = ${ratingId} RETURNING id, status`);
    if (!res.rows[0]) throw new AppException(ERROR_CODES.NOT_FOUND, 'Оценка не найдена', HttpStatus.NOT_FOUND);
    await this.core.db.execute(sql`UPDATE rating_complaints SET status = 'resolved', resolution = ${hidden ? 'hidden' : 'kept'}, resolved_by = ${admin.adminId} WHERE rating_id = ${ratingId} AND status = 'open'`);
    await this.audit.log({ adminId: admin.adminId, action: hidden ? 'rating.hide' : 'rating.show', entity: 'rating', entityId: ratingId, reason, ip: admin.ip });
    return res.rows[0];
  }
}

/** Средний рейтинг машиниста (видимые оценки заказчиков). */
export const operatorRatingSql = (userId: string) => sql`
  SELECT round(avg(stars)::numeric, 2)::float AS avg, count(*)::int AS n FROM ratings
  WHERE target_user_id = ${userId} AND target_kind = 'operator' AND status = 'visible'`;
