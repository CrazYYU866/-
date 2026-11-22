import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES, type LocationBatch } from '@kovsh/contracts';
import { sql } from 'drizzle-orm';
import { AppException } from '../common/app-exception';
import { ROUTING, type RoutingProvider } from '../geo/routing.provider';
import { OrderCore } from '../orders/order-core';
import type { OrgContext } from '../organizations/org-context.guard';
import { SettingsService } from '../settings/settings.service';
import { RealtimeGateway } from './realtime.gateway';

/**
 * GPS-отслеживание (ТЗ §9; Р-19–21; П-1; П-2).
 * — До «Выехал» заказчик видит место стоянки по данным компании и маршрут от неё; GPS телефона не передаётся и не показывается.
 * — После «Выехал» — живые координаты, пройденное и оставшееся расстояние, ETA; при потере связи — последняя точка и время, без ETA.
 * — После «Прибыл» движение не показывается, координаты собираются для разбора споров; после завершения — сбор прекращается.
 */
@Injectable()
export class TrackingService {
  constructor(
    private readonly core: OrderCore,
    private readonly settings: SettingsService,
    private readonly realtime: RealtimeGateway,
    @Inject(ROUTING) private readonly routing: RoutingProvider,
  ) {}

  async ingest(org: OrgContext, userId: string, batch: LocationBatch): Promise<{ accepted: number; phase: string }> {
    const order = await this.core.get(batch.orderId);
    const shift = order.partner_org_id === org.orgId
      ? (await this.core.shifts(order.id)).find((s) => s.operator_user_id === userId && ['en_route', 'arrived', 'in_progress'].includes(s.status))
      : undefined;
    if (!shift) {
      // Приложение должно остановить передачу: нет активной поездки или работы по этому заказу.
      throw new AppException(ERROR_CODES.TRACKING_NOT_ACTIVE, 'Передача координат по этому заказу не требуется', HttpStatus.CONFLICT);
    }
    const phase = shift.status === 'en_route' ? 'en_route' : 'on_site';
    for (const p of batch.points) {
      await this.core.db.execute(sql`
        INSERT INTO location_pings (order_id, shift_id, user_id, point, accuracy_m, speed_mps, heading, battery, phase, recorded_at)
        VALUES (${order.id}, ${shift.id}, ${userId}, ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326)::geography,
          ${p.accuracy ?? null}, ${p.speed ?? null}, ${p.heading ?? null}, ${p.battery ?? null}, ${phase}, ${p.recordedAt})`);
    }
    if (phase === 'en_route') {
      const last = [...batch.points].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)).pop();
      if (last) this.realtime.toOrder(order.id, 'tracking.update', { orderId: order.id, lat: last.lat, lng: last.lng, recordedAt: last.recordedAt });
    }
    return { accepted: batch.points.length, phase };
  }

  async view(orderId: string, userId: string) {
    const p = await this.core.participant(orderId, userId);
    if (!p.customer && !p.staffRole && !p.operator) throw new AppException(ERROR_CODES.NOT_FOUND, 'Заказ не найден', HttpStatus.NOT_FOUND);
    return this.build(orderId);
  }

  async build(orderId: string) {
    const order = await this.core.get(orderId);
    const site = { lat: Number(order.site_lat), lng: Number(order.site_lng) };
    if (!order.equipment_unit_id) return { mode: 'none' as const, site };
    const shift = (await this.core.shifts(orderId)).find((s) => s.status !== 'finished' && s.status !== 'cancelled');
    if (!shift || ['completed', 'awaiting_final_payment', 'cancelled', 'cancelled_unpaid', 'refund_pending', 'search_failed'].includes(order.status)) {
      return { mode: 'finished' as const, site };
    }
    if (shift.status === 'pending') {
      const base = (await this.core.db.execute<{ lat: number; lng: number; address: string }>(sql`
        SELECT ST_Y(base_point::geometry) AS lat, ST_X(base_point::geometry) AS lng, base_address AS address FROM equipment_units WHERE id = ${order.equipment_unit_id}`)).rows[0];
      if (!base) return { mode: 'none' as const, site };
      const from = { lat: Number(base.lat), lng: Number(base.lng) };
      const r = await this.routing.route(from, site);
      return {
        mode: 'base' as const,
        site,
        base: { ...from, address: base.address, label: 'Место стоянки (по данным компании)' },
        route: { polyline: [from, site], distanceKm: Math.round(r.distanceMeters / 100) / 10, durationMin: Math.ceil(r.durationSeconds / 60), provider: r.provider },
      };
    }
    if (shift.status === 'en_route') {
      const staleSec = await this.settings.get('tracking_stale_sec');
      const last = (await this.core.db.execute<{ lat: number; lng: number; recorded_at: Date; age_sec: number }>(sql`
        SELECT ST_Y(point::geometry) AS lat, ST_X(point::geometry) AS lng, recorded_at, EXTRACT(EPOCH FROM now() - recorded_at)::int AS age_sec
        FROM location_pings WHERE shift_id = ${shift.id} AND phase = 'en_route' ORDER BY recorded_at DESC LIMIT 1`)).rows[0];
      if (!last) return { mode: 'live' as const, site, position: null, message: 'Ожидаем координаты машиниста', etaMin: null };
      const traveled = (await this.core.db.execute<{ m: number | null }>(sql`
        SELECT sum(ST_Distance(point, prev)) AS m FROM (
          SELECT point, lag(point) OVER (ORDER BY recorded_at) AS prev FROM location_pings
          WHERE shift_id = ${shift.id} AND phase = 'en_route' AND (accuracy_m IS NULL OR accuracy_m <= 100)) t WHERE prev IS NOT NULL`)).rows[0]?.m ?? 0;
      const position = { lat: Number(last.lat), lng: Number(last.lng), updatedAt: new Date(last.recorded_at).toISOString() };
      const stale = last.age_sec > staleSec;
      const base = { mode: 'live' as const, site, position, stale, traveledKm: Math.round(Number(traveled) / 100) / 10 };
      // Нет свежих координат — показываем последнюю точку и время; ETA и маршрут не выдумываем (Р-19–21).
      if (stale) return { ...base, message: `Нет связи с техникой, последнее обновление в ${position.updatedAt}`, etaMin: null, remainingKm: null };
      const r = await this.routing.route(position, site);
      return {
        ...base, etaMin: Math.ceil(r.durationSeconds / 60), remainingKm: Math.round(r.distanceMeters / 100) / 10,
        route: { polyline: [position, site], provider: r.provider },
      };
    }
    // После прибытия движение заказчику не показывается (П-2).
    return { mode: 'on_site' as const, site };
  }
}
