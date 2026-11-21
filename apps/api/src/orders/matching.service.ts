import { HttpStatus, Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ERROR_CODES } from '@kovsh/contracts';
import { sql } from 'drizzle-orm';
import { AppException } from '../common/app-exception';
import { ROUTING, type RoutingProvider } from '../geo/routing.provider';
import type { OrgContext } from '../organizations/org-context.guard';
import { fitsSchedule } from '../pricing/time';
import { SettingsService } from '../settings/settings.service';
import { OrderCore, type OrderRow, type ShiftRow, type Tx } from './order-core';

type CandidateRow = {
  unit_id: string;
  org_id: string;
  lat: number;
  lng: number;
  distance_m: number;
};

interface Scored extends CandidateRow {
  score: number;
  details: Record<string, number | null>;
}

/**
 * Автоматический подбор и последовательная передача заказа (ТЗ §8).
 * Одновременно — одно предложение (уникальный индекс в БД). 40 секунд на ответ. Радиус растёт по шагам (Н-17).
 * Факторы и веса — К-5, К-6, К-7, В-7; срок поиска — К-2, Н-18.
 */
@Injectable()
export class MatchingService implements OnModuleInit {
  constructor(
    private readonly core: OrderCore,
    private readonly settings: SettingsService,
    @Inject(ROUTING) private readonly routing: RoutingProvider,
  ) {}

  onModuleInit(): void {
    this.core.jobs.register('search_tick', (p) => this.tick(String(p['orderId'])));
    this.core.jobs.register('offer_timeout', (p) => this.offerTimeout(String(p['offerId'])));
    this.core.jobs.register('search_deadline', (p) => this.searchDeadline(String(p['orderId']), Number(p['round'])));
  }

  /** Новый раунд поиска с полным сроком (Н-18). */
  async startSearch(tx: Tx, order: OrderRow): Promise<void> {
    const [urgentMin, scheduledMin, stopBefore] = await Promise.all([
      this.settings.get('search_timeout_urgent_min'),
      this.settings.get('search_timeout_scheduled_min'),
      this.settings.get('search_stop_before_start_min'),
    ]);
    const now = Date.now();
    const limit = order.urgency === 'urgent' ? urgentMin : scheduledMin;
    const deadline = new Date(Math.min(now + limit * 60_000, new Date(order.first_start_at).getTime() - stopBefore * 60_000));
    const round = order.search_round + 1;
    await tx.execute(sql`
      UPDATE orders SET search_round = ${round}, search_started_at = now(), search_deadline_at = ${deadline.toISOString()}
      WHERE id = ${order.id}`);
    order.search_round = round;
    order.search_started_at = new Date(now);
    await this.core.jobs.schedule('search_tick', { orderId: order.id }, new Date(now), { dedupeKey: `order:${order.id}:tick`, tx });
    await this.core.jobs.schedule('search_deadline', { orderId: order.id, round }, deadline, { dedupeKey: `order:${order.id}:deadline`, tx });
  }

  /** Шаг поиска: предложить заказ лучшему кандидату в текущем радиусе или ждать расширения радиуса. */
  async tick(orderId: string): Promise<void> {
    await this.core.db.transaction(async (tx) => {
      const order = await this.core.lock(tx, orderId);
      if (order.status !== 'searching') return;
      const [start, step, interval, max, timeoutSec] = await Promise.all([
        this.settings.get('search_radius_start_km'),
        this.settings.get('search_radius_step_km'),
        this.settings.get('search_radius_step_interval_sec'),
        this.settings.get('search_radius_max_km'),
        this.settings.get('offer_timeout_sec'),
      ]);
      const elapsedSec = (Date.now() - new Date(order.search_started_at ?? Date.now()).getTime()) / 1000;
      const radius = Math.min(start + Math.floor(elapsedSec / interval) * step, max);

      const shifts = await this.core.shifts(order.id, tx);
      const best = await this.pickCandidate(tx, order, shifts, radius);
      if (!best) {
        const nextStepAt = new Date(new Date(order.search_started_at ?? Date.now()).getTime() + (Math.floor(elapsedSec / interval) + 1) * interval * 1000);
        await this.core.jobs.schedule('search_tick', { orderId }, nextStepAt, { dedupeKey: `order:${orderId}:tick`, tx });
        return;
      }
      const expires = new Date(Date.now() + timeoutSec * 1000);
      const res = await tx.execute<{ id: string }>(sql`
        INSERT INTO order_offers (order_id, unit_id, org_id, search_round, radius_km, distance_km, score, score_details, expires_at)
        VALUES (${orderId}, ${best.unit_id}, ${best.org_id}, ${order.search_round}, ${radius}, ${Math.round(best.distance_m / 100) / 10},
          ${best.score.toFixed(4)}, ${JSON.stringify(best.details)}::jsonb, ${expires.toISOString()})
        RETURNING id`);
      const offerId = res.rows[0]?.id as string;
      await this.core.transition(tx, order, 'offered', { type: 'system' }, { meta: { offerId, orgId: best.org_id, radius } });
      await this.core.jobs.schedule('offer_timeout', { offerId, orderId }, expires, { dedupeKey: `offer:${offerId}`, tx });
      await this.core.events.emit({
        type: 'offer.new', orderId, orgId: best.org_id, userIds: await this.core.partnerStaff(best.org_id, tx),
        payload: { offerId, expiresAt: expires.toISOString() },
      }, tx);
    });
  }

  async offerTimeout(offerId: string): Promise<void> {
    await this.closeOffer(offerId, 'expired', null);
  }

  /** «Пропустить» — заказ сразу уходит следующему кандидату (ТЗ §8 п. 4). */
  async skip(offerId: string, org: OrgContext, userId: string): Promise<void> {
    await this.closeOffer(offerId, 'skipped', { orgId: org.orgId, userId });
  }

  private async closeOffer(offerId: string, as: 'expired' | 'skipped', by: { orgId: string; userId: string } | null): Promise<void> {
    const orderId = await this.offerOrderId(offerId);
    await this.core.db.transaction(async (tx) => {
      const order = await this.core.lock(tx, orderId);
      const offer = await this.loadOffer(tx, offerId);
      if (by && offer.org_id !== by.orgId) throw new AppException(ERROR_CODES.NOT_FOUND, 'Предложение не найдено', HttpStatus.NOT_FOUND);
      if (offer.status !== 'pending') {
        if (by) throw new AppException(ERROR_CODES.OFFER_EXPIRED, 'Предложение уже неактуально', HttpStatus.CONFLICT);
        return;
      }
      // Таймер мог сработать на долю секунды раньше: проверяем срок по времени БД.
      if (as === 'expired' && new Date(offer.expires_at).getTime() > Date.now()) return;
      await tx.execute(sql`UPDATE order_offers SET status = ${as}, responded_at = now(), responder_id = ${by?.userId ?? null} WHERE id = ${offerId}`);
      await this.core.jobs.cancel(`offer:${offerId}`, tx);
      await this.core.partnerIncident(tx, offer.org_id, orderId, as === 'expired' ? 'offer_expired' : 'offer_skipped');
      if (order.status === 'offered') {
        await this.core.transition(tx, order, 'searching', by ? { type: 'partner', id: by.userId } : { type: 'system' }, { meta: { offerId, result: as } });
        await this.core.jobs.schedule('search_tick', { orderId }, new Date(), { dedupeKey: `order:${orderId}:tick`, tx });
      }
      await this.core.events.emit({ type: `offer.${as}`, orderId, orgId: offer.org_id, userIds: await this.core.partnerStaff(offer.org_id, tx), payload: { offerId } }, tx);
    });
  }

  /**
   * Принятие предложения. Сервер гарантирует ровно одно принятие:
   * блокировка заказа, проверка срока по времени БД, бронь техники с запретом пересечений (EXCLUDE).
   */
  async accept(offerId: string, org: OrgContext, userId: string): Promise<void> {
    const orderId = await this.offerOrderId(offerId);
    const pre = await this.core.get(orderId);
    const offerPre = await this.loadOffer(this.core.db, offerId);
    if (offerPre.org_id !== org.orgId) throw new AppException(ERROR_CODES.NOT_FOUND, 'Предложение не найдено', HttpStatus.NOT_FOUND);
    // Маршрут считаем до транзакции, чтобы не держать блокировку во время внешнего запроса.
    const unit = await this.unitPoint(offerPre.unit_id);
    const route = await this.routing.route(unit, { lat: pre.site_lat, lng: pre.site_lng });
    const shiftsPre = await this.core.shifts(orderId);
    const bufferOk = await this.travelBufferOk(offerPre.unit_id, shiftsPre, { lat: pre.site_lat, lng: pre.site_lng }, orderId);

    const outcome = await this.core.db.transaction(async (tx) => {
      const order = await this.core.lock(tx, orderId);
      const offer = await this.loadOffer(tx, offerId);
      const fresh = await tx.execute<{ ok: boolean }>(sql`SELECT now() < ${offer.expires_at.toISOString()}::timestamptz AS ok`);
      if (offer.status !== 'pending' || !fresh.rows[0]?.ok || order.status !== 'offered') {
        return 'expired' as const;
      }
      const memberRes = await tx.execute<{ id: string }>(sql`
        SELECT id FROM organization_members WHERE org_id = ${org.orgId} AND user_id = ${userId} AND status = 'active'`);
      const memberId = memberRes.rows[0]?.id ?? null;
      const shifts = await this.core.shifts(orderId, tx);
      const booked = bufferOk && (await this.tryBook(tx, offer.unit_id, orderId, shifts));
      if (!booked) {
        await tx.execute(sql`UPDATE order_offers SET status = 'failed', responded_at = now(), responder_id = ${userId} WHERE id = ${offerId}`);
        await this.core.transition(tx, order, 'searching', { type: 'system' }, { reason: 'Техника исполнителя уже занята на это время' });
        await this.core.jobs.schedule('search_tick', { orderId }, new Date(), { dedupeKey: `order:${orderId}:tick`, tx });
        return 'unavailable' as const;
      }
      await tx.execute(sql`UPDATE order_offers SET status = 'accepted', responded_at = now(), responder_id = ${userId} WHERE id = ${offerId}`);
      await this.core.jobs.cancel(`offer:${offerId}`, tx);
      await this.core.jobs.cancel(`order:${orderId}:tick`, tx);
      await this.core.jobs.cancel(`order:${orderId}:deadline`, tx);

      const kmTenths = Math.round(route.distanceMeters / 100);
      const partnerDelivery = Math.round((kmTenths * 2 * Number(order.km_price_kopecks)) / 10);
      const patch = [
        sql`partner_org_id = ${org.orgId}`, sql`equipment_unit_id = ${offer.unit_id}`, sql`managing_member_id = ${memberId}`,
        sql`partner_delivery_km = ${kmTenths / 10}`, sql`partner_delivery_kopecks = ${partnerDelivery}`,
      ];
      const actor = { type: 'partner' as const, id: userId };
      await this.core.assignmentLog(tx, { orderId, orgId: org.orgId, unitId: offer.unit_id, kind: 'accepted', actorId: userId });

      if (order.prepaid_at) {
        // Повторный поиск после замены: предоплата уже внесена, сразу назначение машиниста (Н-8, Л-2).
        const deadlineMin = await this.settings.get('assignment_deadline_min');
        const deadline = new Date(Date.now() + deadlineMin * 60_000);
        await this.core.transition(tx, order, 'awaiting_assignment', actor, { patch: [...patch, sql`assignment_deadline_at = ${deadline.toISOString()}`], meta: { offerId } });
        await this.scheduleAssignmentTimers(tx, orderId, deadline);
      } else {
        const payMin = await this.settings.get('prepayment_timeout_min');
        const deadline = new Date(Date.now() + payMin * 60_000);
        await this.core.transition(tx, order, 'awaiting_prepayment', actor, { patch: [...patch, sql`prepayment_deadline_at = ${deadline.toISOString()}`], meta: { offerId } });
        await this.core.jobs.schedule('prepayment_timeout', { orderId }, deadline, { dedupeKey: `order:${orderId}:prepay`, tx });
      }
      await this.core.events.emit({ type: 'order.partner_found', orderId, orgId: org.orgId, userIds: [order.customer_id], payload: {} }, tx);
      const others = (await this.core.partnerStaff(org.orgId, tx)).filter((u) => u !== userId);
      await this.core.events.emit({ type: 'offer.taken', orderId, orgId: org.orgId, userIds: others, payload: { offerId, by: userId } }, tx);
      return 'ok' as const;
    });
    if (outcome === 'expired') throw new AppException(ERROR_CODES.OFFER_EXPIRED, 'Предложение уже неактуально', HttpStatus.CONFLICT);
    if (outcome === 'unavailable') throw new AppException(ERROR_CODES.OFFER_UNAVAILABLE, 'Техника уже занята на это время', HttpStatus.CONFLICT);
  }

  async scheduleAssignmentTimers(tx: Tx, orderId: string, deadline: Date): Promise<void> {
    const reminders = await this.settings.get('assignment_reminder_minutes');
    const total = await this.settings.get('assignment_deadline_min');
    const startedAt = deadline.getTime() - total * 60_000;
    for (const m of reminders) {
      await this.core.jobs.schedule('assignment_reminder', { orderId, minute: m }, new Date(startedAt + m * 60_000), { dedupeKey: `order:${orderId}:remind:${m}`, tx });
    }
    await this.core.jobs.schedule('assignment_deadline', { orderId }, deadline, { dedupeKey: `order:${orderId}:assign`, tx });
  }

  /** Срок поиска истёк (К-2): без предоплаты — «не найден», с предоплатой — полный возврат (Н-14, К-8). */
  async searchDeadline(orderId: string, round: number): Promise<void> {
    await this.core.db.transaction(async (tx) => {
      const order = await this.core.lock(tx, orderId);
      if (order.search_round !== round || (order.status !== 'searching' && order.status !== 'offered')) return;
      await tx.execute(sql`UPDATE order_offers SET status = 'revoked', responded_at = now() WHERE order_id = ${orderId} AND status = 'pending'`);
      await this.core.cancelTimers(tx, orderId);
      const to = order.prepaid_at ? 'refund_pending' : 'search_failed';
      await this.core.transition(tx, order, to, { type: 'system' }, {
        reason: 'Исполнитель не найден', patch: [sql`cancelled_at = now()`, sql`cancelled_by = 'system'`, sql`cancellation_reason = 'Исполнитель не найден'`],
      });
      await this.core.events.emit({ type: 'order.search_failed', orderId, userIds: [order.customer_id], payload: { refund: Boolean(order.prepaid_at) } }, tx);
    });
  }

  // ── Подбор кандидатов ─────────────────────────────────────────────────────

  private async pickCandidate(tx: Tx, order: OrderRow, shifts: ShiftRow[], radiusKm: number): Promise<Scored | null> {
    const site = sql`ST_SetSRID(ST_MakePoint(${order.site_lng}, ${order.site_lat}), 4326)::geography`;
    const requirements = this.requirementSql(order.requirements);
    const intervals = shifts.filter((s) => s.status !== 'finished' && s.status !== 'cancelled');
    const noOverlap = intervals.map((s) => sql`NOT EXISTS (SELECT 1 FROM unit_bookings b WHERE b.unit_id = u.id AND b.status = 'active'
      AND b.period && tstzrange(${new Date(s.starts_at).toISOString()}, ${new Date(s.ends_at).toISOString()}))`);
    const res = await tx.execute<CandidateRow>(sql`
      SELECT u.id AS unit_id, u.org_id, ST_Y(u.base_point::geometry) AS lat, ST_X(u.base_point::geometry) AS lng,
             ST_Distance(u.base_point, ${site}) AS distance_m
      FROM equipment_units u JOIN organizations o ON o.id = u.org_id AND o.status = 'verified' AND o.kind = 'partner'
      WHERE u.category_id = ${order.category_id} AND u.is_online AND u.verification_status = 'approved' AND u.archived_at IS NULL
        AND ST_DWithin(u.base_point, ${site}, ${radiusKm} * 1000)
        AND (u.allow_beyond_radius OR ST_DWithin(u.base_point, ${site}, u.work_radius_km * 1000))
        AND NOT EXISTS (SELECT 1 FROM order_excluded_orgs x WHERE x.order_id = ${order.id} AND x.org_id = u.org_id)
        AND NOT EXISTS (SELECT 1 FROM order_offers f WHERE f.order_id = ${order.id} AND f.unit_id = u.id AND f.search_round = ${order.search_round})
        ${sql.join([...requirements, ...noOverlap].map((c) => sql` AND ${c}`), sql``)}
      ORDER BY distance_m LIMIT 50`);
    if (res.rows.length === 0) return null;

    const candidates = await this.filterBySchedule(tx, res.rows, intervals, order.timezone);
    const withOperators = await this.filterByOperators(tx, candidates, intervals);
    if (withOperators.length === 0) return null;
    const scored = await this.score(tx, withOperators, intervals, radiusKm);
    for (const c of scored) {
      if (await this.travelBufferOk(c.unit_id, intervals, { lat: order.site_lat, lng: order.site_lng }, order.id)) return c;
    }
    return null;
  }

  private requirementSql(reqs: Record<string, unknown>) {
    return Object.entries(reqs).map(([key, value]) => {
      if (value !== null && typeof value === 'object' && 'min' in value) return sql`(u.attributes->>${key})::numeric >= ${Number((value as { min: number }).min)}`;
      if (typeof value === 'boolean') return sql`(u.attributes->${key}) = ${JSON.stringify(value)}::jsonb`;
      return sql`((u.attributes->>${key}) = ${String(value)} OR (jsonb_typeof(u.attributes->${key}) = 'array' AND (u.attributes->${key}) ? ${String(value)}))`;
    });
  }

  private async filterBySchedule(tx: Tx, rows: CandidateRow[], shifts: ShiftRow[], timeZone: string): Promise<CandidateRow[]> {
    const ids = rows.map((r) => r.unit_id);
    const sch = await tx.execute<{ unit_id: string; weekday: number; start_time: string; end_time: string }>(sql`
      SELECT unit_id, weekday, start_time::text, end_time::text FROM equipment_schedules WHERE unit_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
    return rows.filter((r) => {
      const list = sch.rows.filter((s) => s.unit_id === r.unit_id).map((s) => ({ weekday: s.weekday, start: s.start_time.slice(0, 5), end: s.end_time.slice(0, 5) }));
      return shifts.every((s) => fitsSchedule(new Date(s.starts_at), new Date(s.ends_at), list, timeZone));
    });
  }

  /**
   * Компания должна реально суметь выполнить заказ (ТЗ §8): в каждый день смен у неё есть свободные проверенные машинисты
   * в нужном количестве (один машинист — одна смена в день, Р-5, К-3).
   */
  private async filterByOperators(tx: Tx, rows: CandidateRow[], shifts: ShiftRow[]): Promise<CandidateRow[]> {
    const need = new Map<string, number>();
    for (const s of shifts) need.set(s.work_date, (need.get(s.work_date) ?? 0) + 1);
    const orgIds = [...new Set(rows.map((r) => r.org_id))];
    const ok = new Set<string>();
    for (const orgId of orgIds) {
      let fits = true;
      for (const [date, count] of need) {
        const res = await tx.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM organization_members m
          WHERE m.org_id = ${orgId} AND m.status = 'active' AND m.can_operate AND m.operator_verification = 'approved'
            AND NOT EXISTS (SELECT 1 FROM operator_day_assignments d WHERE d.user_id = m.user_id AND d.work_date = ${date}::date AND d.status = 'active')`);
        if ((res.rows[0]?.n ?? 0) < count) {
          fits = false;
          break;
        }
      }
      if (fits) ok.add(orgId);
    }
    return rows.filter((r) => ok.has(r.org_id));
  }

  /** Балл = Σ вес × фактор (К-6). Без истории фактор нейтральный — среднее по кандидатам (В-7). */
  private async score(tx: Tx, rows: CandidateRow[], shifts: ShiftRow[], radiusKm: number): Promise<Scored[]> {
    const [wd, wr, wrel, wl] = await Promise.all([
      this.settings.get('matching_weight_distance'),
      this.settings.get('matching_weight_rating'),
      this.settings.get('matching_weight_reliability'),
      this.settings.get('matching_weight_load'),
    ]);
    const orgIds = [...new Set(rows.map((r) => r.org_id))];
    const firstDate = shifts[0]?.work_date;
    const raw = new Map<string, { rating: number | null; reliability: number | null; load: number }>();
    for (const orgId of orgIds) {
      raw.set(orgId, {
        rating: await this.orgOperatorRating(tx, orgId, firstDate),
        reliability: await this.reliability(tx, orgId),
        load: firstDate ? await this.loadShare(tx, orgId, shifts) : 0,
      });
    }
    const avg = (xs: (number | null)[]) => {
      const v = xs.filter((x): x is number => x !== null);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0.5;
    };
    const ratingAvg = avg([...raw.values()].map((r) => r.rating));
    const relAvg = avg([...raw.values()].map((r) => r.reliability));
    return rows
      .map((r) => {
        const f = raw.get(r.org_id) as { rating: number | null; reliability: number | null; load: number };
        const distance = Math.max(0, 1 - r.distance_m / (radiusKm * 1000));
        const rating = f.rating ?? ratingAvg;
        const reliability = f.reliability ?? relAvg;
        const freeShare = 1 - f.load;
        const score = (wd * distance + wr * rating + wrel * reliability + wl * freeShare) / 100;
        return { ...r, score, details: { distance, rating, reliability, freeShare, ratingRaw: f.rating, reliabilityRaw: f.reliability } };
      })
      .sort((a, b) => b.score - a.score || a.distance_m - b.distance_m);
  }

  /** Средний рейтинг машинистов компании, доступных в день заказа (К-5). Оценки появятся с модулем отзывов. */
  private async orgOperatorRating(_tx: Tx, _orgId: string, _date: string | undefined): Promise<number | null> {
    return null;
  }

  /** Надёжность за 90 дней: доля принятых предложений минус отказы после принятия (К-7). Меньше 3 предложений — нет данных. */
  private async reliability(tx: Tx, orgId: string): Promise<number | null> {
    const res = await tx.execute<{ total: number; accepted: number; failures: number }>(sql`
      SELECT
        (SELECT count(*)::int FROM order_offers WHERE org_id = ${orgId} AND status IN ('accepted', 'skipped', 'expired') AND offered_at > now() - interval '90 days') AS total,
        (SELECT count(*)::int FROM order_offers WHERE org_id = ${orgId} AND status = 'accepted' AND offered_at > now() - interval '90 days') AS accepted,
        (SELECT count(*)::int FROM partner_incidents WHERE org_id = ${orgId} AND type IN ('assignment_timeout', 'replacement_timeout', 'released_order', 'partner_cancelled', 'operator_declined') AND created_at > now() - interval '90 days') AS failures`);
    const r = res.rows[0];
    if (!r || r.total < 3) return null;
    return Math.max(0, Math.min(1, (r.accepted - r.failures) / r.total));
  }

  /** Загрузка = доля занятой техники компании в день заказа (К-6). */
  private async loadShare(tx: Tx, orgId: string, shifts: ShiftRow[]): Promise<number> {
    const first = shifts[0];
    if (!first) return 0;
    const res = await tx.execute<{ total: number; busy: number }>(sql`
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM unit_bookings b WHERE b.unit_id = u.id AND b.status = 'active'
          AND b.period && tstzrange(date_trunc('day', ${new Date(first.starts_at).toISOString()}::timestamptz), date_trunc('day', ${new Date(first.starts_at).toISOString()}::timestamptz) + interval '1 day')))::int AS busy
      FROM equipment_units u WHERE u.org_id = ${orgId} AND u.is_online`);
    const r = res.rows[0];
    return r && r.total > 0 ? r.busy / r.total : 0;
  }

  /** Между заказами одной техники учитывается переезд (Н-20). */
  async travelBufferOk(unitId: string, shifts: { starts_at: Date; ends_at: Date }[], site: { lat: number; lng: number }, orderId: string): Promise<boolean> {
    for (const s of shifts) {
      const neighbours = await this.core.db.execute<{ lat: number; lng: number; starts_at: Date; ends_at: Date; before: boolean }>(sql`
        (SELECT ST_Y(o.site_point::geometry) AS lat, ST_X(o.site_point::geometry) AS lng, lower(b.period) AS starts_at, upper(b.period) AS ends_at, true AS before
           FROM unit_bookings b JOIN orders o ON o.id = b.order_id
          WHERE b.unit_id = ${unitId} AND b.status = 'active' AND b.order_id <> ${orderId} AND upper(b.period) <= ${new Date(s.starts_at).toISOString()}
          ORDER BY upper(b.period) DESC LIMIT 1)
        UNION ALL
        (SELECT ST_Y(o.site_point::geometry), ST_X(o.site_point::geometry), lower(b.period), upper(b.period), false
           FROM unit_bookings b JOIN orders o ON o.id = b.order_id
          WHERE b.unit_id = ${unitId} AND b.status = 'active' AND b.order_id <> ${orderId} AND lower(b.period) >= ${new Date(s.ends_at).toISOString()}
          ORDER BY lower(b.period) ASC LIMIT 1)`);
      for (const n of neighbours.rows) {
        const gapMs = n.before ? new Date(s.starts_at).getTime() - new Date(n.ends_at).getTime() : new Date(n.starts_at).getTime() - new Date(s.ends_at).getTime();
        const r = n.before
          ? await this.routing.route({ lat: Number(n.lat), lng: Number(n.lng) }, site)
          : await this.routing.route(site, { lat: Number(n.lat), lng: Number(n.lng) });
        if (r.durationSeconds * 1000 > gapMs) return false;
      }
    }
    return true;
  }

  /** Бронь техники на все незавершённые смены. Пересечение отклоняет EXCLUDE-ограничение БД. */
  async tryBook(tx: Tx, unitId: string, orderId: string, shifts: ShiftRow[]): Promise<boolean> {
    try {
      await tx.execute(sql`SAVEPOINT book`);
      for (const s of shifts.filter((x) => x.status !== 'finished' && x.status !== 'cancelled')) {
        await tx.execute(sql`INSERT INTO unit_bookings (unit_id, period, order_id)
          VALUES (${unitId}, tstzrange(${new Date(s.starts_at).toISOString()}, ${new Date(s.ends_at).toISOString()}), ${orderId})`);
      }
      await tx.execute(sql`RELEASE SAVEPOINT book`);
      return true;
    } catch (e) {
      const code = ((e as { cause?: { code?: string } }).cause ?? (e as { code?: string })).code;
      if (code !== '23P01') throw e;
      await tx.execute(sql`ROLLBACK TO SAVEPOINT book`);
      return false;
    }
  }

  private async offerOrderId(offerId: string): Promise<string> {
    const res = await this.core.db.execute<{ order_id: string }>(sql`SELECT order_id FROM order_offers WHERE id = ${offerId}`);
    const id = res.rows[0]?.order_id;
    if (!id) throw new AppException(ERROR_CODES.NOT_FOUND, 'Предложение не найдено', HttpStatus.NOT_FOUND);
    return id;
  }

  private async loadOffer(db: Pick<Tx, 'execute'>, offerId: string) {
    const res = await db.execute<{ id: string; order_id: string; unit_id: string; org_id: string; status: string; expires_at: Date }>(sql`
      SELECT id, order_id, unit_id, org_id, status, expires_at FROM order_offers WHERE id = ${offerId}`);
    const o = res.rows[0];
    if (!o) throw new AppException(ERROR_CODES.NOT_FOUND, 'Предложение не найдено', HttpStatus.NOT_FOUND);
    return { ...o, expires_at: new Date(o.expires_at) };
  }

  async unitPoint(unitId: string): Promise<{ lat: number; lng: number }> {
    const res = await this.core.db.execute<{ lat: number; lng: number }>(sql`
      SELECT ST_Y(base_point::geometry) AS lat, ST_X(base_point::geometry) AS lng FROM equipment_units WHERE id = ${unitId}`);
    const r = res.rows[0];
    if (!r) throw new AppException(ERROR_CODES.NOT_FOUND, 'Техника не найдена', HttpStatus.NOT_FOUND);
    return { lat: Number(r.lat), lng: Number(r.lng) };
  }
}
