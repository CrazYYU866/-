import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES, type QuoteRequest, type QuoteResponse, type QuoteShift, type RequirementValue } from '@kovsh/contracts';
import { inArray, sql, type SQL } from 'drizzle-orm';
import { CatalogService } from '../catalog/catalog.service';
import { AppException } from '../common/app-exception';
import { DB, type Database } from '../database/database.module';
import { equipmentSchedules } from '../database/schema';
import { ROUTING, type RoutingProvider } from '../geo/routing.provider';
import { SettlementService } from '../finance/settlement.service';
import { SettingsService } from '../settings/settings.service';
import { firstPaymentKopecks } from '../finance/split';
import { fitsSchedule } from './time';

export interface Interval {
  start: Date;
  end: Date;
}

interface Candidate {
  id: string;
  lat: number;
  lng: number;
}

/** Сколько ближайших по прямой кандидатов проверять маршрутизатором (экономия запросов, §9.3 плана). */
const ROUTE_CANDIDATES = 5;

const err = (code: string, message: string, status = HttpStatus.UNPROCESSABLE_ENTITY, details?: unknown) =>
  new AppException(code, message, status, details);

/**
 * Расчёт стоимости до запуска поиска (ТЗ §7, §12, §13).
 * Аренда = часы × почасовой тариф (Н-3); доставка = маршрут от базы ближайшей свободной техники × 2 × тариф за км (Н-1, ТЗ §13);
 * км — до 0,1 (Н-6); итог — до целого рубля (Н-6); тарифы — по региону объекта (Н-7, К-15).
 */
@Injectable()
export class PricingService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ROUTING) private readonly routing: RoutingProvider,
    private readonly catalog: CatalogService,
    private readonly settings: SettingsService,
    private readonly settlement: SettlementService,
  ) {}

  async quote(customerId: string, req: QuoteRequest, now: Date = new Date(), agentOrgId: string | null = null): Promise<QuoteResponse> {
    if (await this.settlement.hasOpenDebt(this.db, customerId)) {
      throw err(ERROR_CODES.DEBT_EXISTS, 'Погасите задолженность по предыдущему заказу', HttpStatus.CONFLICT);
    }
    const category = await this.assertCustomerCategory(req.categoryId);
    const region = await this.catalog.regionByPoint(req.site.lat, req.site.lng);
    if (!region) throw err(ERROR_CODES.REGION_NOT_FOUND, 'По этому адресу сервис пока не работает', HttpStatus.NOT_FOUND);

    const intervals = await this.resolveDays(req, region.timezone);
    await this.validateTiming(intervals, req.days.map((d) => d.hours), now);
    const maxShift = await this.settings.get('max_shift_hours');
    const shifts = splitIntoShifts(intervals, maxShift);
    const totalHours = req.days.reduce((s, d) => s + d.hours, 0);
    const urgentHours = await this.settings.get('urgent_threshold_hours');
    const first = intervals[0] as Interval;
    const last = intervals[intervals.length - 1] as Interval;
    const urgency = first.start.getTime() - now.getTime() < urgentHours * 3_600_000 ? 'urgent' : 'scheduled';

    const [rent, delivery] = await Promise.all([
      this.catalog.effectiveTariff(category.id, region.id, 'rent_hour', now),
      this.catalog.effectiveTariff(category.id, region.id, 'delivery_km', now),
    ]);
    if (!rent || !delivery) {
      throw err(ERROR_CODES.TARIFF_NOT_FOUND, 'Для этой техники в вашем регионе ещё не задан тариф', HttpStatus.UNPROCESSABLE_ENTITY, {
        missing: [!rent && 'rent_hour', !delivery && 'delivery_km'].filter(Boolean),
      });
    }

    const requirementSql = await this.requirementConditions(category.id, req.requirements);
    const reference = await this.nearestAvailableUnit(category.id, req.site, intervals, requirementSql, region.timezone, now);
    if (!reference) {
      throw err(ERROR_CODES.NO_EQUIPMENT_AVAILABLE, 'Сейчас нет свободной техники с такими параметрами на это время', HttpStatus.UNPROCESSABLE_ENTITY);
    }

    // Расчёт (Н-6): км до 0,1; внутренние суммы — копейки; итог — целые рубли.
    const routeKmTenths = Math.round(reference.distanceMeters / 100);
    const deliveryKopecks = Math.round((routeKmTenths * 2 * delivery.priceKopecks) / 10);
    const rentKopecks = totalHours * rent.priceKopecks;
    const subtotal = rentKopecks + deliveryKopecks;
    const total = Math.round(subtotal / 100) * 100;
    // Первый платёж: физлицо — 100%, юрлицо — 50%; плательщик выбирается при оформлении (решения 07).
    const prepayment = firstPaymentKopecks(total, 'individual', 50);
    const legalFirst = firstPaymentKopecks(total, 'legal', await this.settings.get('prepayment_percent'));
    const ttl = await this.settings.get('quote_ttl_min');
    const expiresAt = new Date(now.getTime() + ttl * 60_000);

    const res = await this.db.execute<{ id: string }>(sql`
      INSERT INTO quotes (
        customer_id, category_id, region_id, site_point, site_address, requirements, days, shifts, total_hours, urgency,
        first_start_at, last_end_at, reference_unit_id, reference_route_km, reference_route_minutes, routing_provider,
        rent_tariff_id, delivery_tariff_id, hour_price_kopecks, km_price_kopecks,
        rent_kopecks, delivery_kopecks, subtotal_kopecks, total_kopecks, expires_at, agent_org_id
      ) VALUES (
        ${customerId}, ${category.id}, ${region.id}, ST_SetSRID(ST_MakePoint(${req.site.lng}, ${req.site.lat}), 4326)::geography,
        ${req.site.address}, ${JSON.stringify(req.requirements)}::jsonb, ${JSON.stringify(req.days)}::jsonb, ${JSON.stringify(shifts)}::jsonb,
        ${totalHours}, ${urgency}, ${first.start.toISOString()}, ${last.end.toISOString()},
        ${reference.unitId}, ${routeKmTenths / 10}, ${Math.ceil(reference.durationSeconds / 60)}, ${reference.provider},
        ${rent.tariffId}, ${delivery.tariffId}, ${rent.priceKopecks}, ${delivery.priceKopecks},
        ${rentKopecks}, ${deliveryKopecks}, ${subtotal}, ${total}, ${expiresAt.toISOString()}, ${agentOrgId}
      ) RETURNING id`);
    const id = res.rows[0]?.id;
    if (!id) throw new Error('Расчёт не сохранён');

    return {
      id, expiresAt: expiresAt.toISOString(), urgency, region: { id: region.id, name: region.name }, totalHours, shifts,
      hourPriceKopecks: rent.priceKopecks, kmPriceKopecks: delivery.priceKopecks, deliveryKm: routeKmTenths / 10,
      rentKopecks, deliveryKopecks, totalKopecks: total, prepaymentKopecks: prepayment, legalFirstPaymentKopecks: legalFirst,
    };
  }

  // ── Внутреннее ────────────────────────────────────────────────────────────

  private async assertCustomerCategory(id: string) {
    const chain = await this.catalog.ancestors(id);
    const cat = chain[0];
    if (!cat || chain.some((c) => c.archivedAt !== null || !c.visibleToCustomers)) {
      throw err(ERROR_CODES.NOT_FOUND, 'Категория недоступна', HttpStatus.NOT_FOUND);
    }
    if (!(await this.catalog.isLeaf(id))) throw err(ERROR_CODES.CATEGORY_NOT_LEAF, 'Выберите конкретный вид техники', HttpStatus.BAD_REQUEST);
    return cat;
  }

  /** Местные дата и время дней заказа → моменты UTC (часовой пояс региона объекта). */
  private async resolveDays(req: QuoteRequest, timeZone: string): Promise<Interval[]> {
    const dates = req.days.map((d) => d.date);
    if (new Set(dates).size !== dates.length) throw err(ERROR_CODES.INVALID_SCHEDULE, 'Каждый день можно выбрать один раз', HttpStatus.BAD_REQUEST);
    const res = await this.db.execute<{ i: number; start_at: Date }>(sql`
      SELECT i, ((d->>'date')::date + (d->>'startTime')::time) AT TIME ZONE ${timeZone} AS start_at
      FROM jsonb_array_elements(${JSON.stringify(req.days)}::jsonb) WITH ORDINALITY AS t(d, i)`);
    const intervals = res.rows
      .map((r) => {
        const day = req.days[Number(r.i) - 1] as { hours: number };
        const start = new Date(r.start_at);
        return { start, end: new Date(start.getTime() + day.hours * 3_600_000) };
      })
      .sort((a, b) => a.start.getTime() - b.start.getTime());
    for (let i = 1; i < intervals.length; i++) {
      if ((intervals[i] as Interval).start < (intervals[i - 1] as Interval).end) {
        throw err(ERROR_CODES.INVALID_SCHEDULE, 'Рабочие периоды разных дней пересекаются', HttpStatus.BAD_REQUEST);
      }
    }
    return intervals;
  }

  private async validateTiming(intervals: Interval[], hours: number[], now: Date): Promise<void> {
    const [minHours, minMultiday, step, leadMin, horizonDays] = await Promise.all([
      this.settings.get('min_order_hours'),
      this.settings.get('min_multiday_day_hours'),
      this.settings.get('order_hour_step'),
      this.settings.get('min_lead_time_min'),
      this.settings.get('max_booking_horizon_days'),
    ]);
    // Однодневный заказ — минимум 4 часа; многодневный — минимум 8 часов каждый день (М-1, С-19).
    const multiDay = hours.length > 1;
    const min = multiDay ? minMultiday : minHours;
    if (hours.some((h) => h < min)) {
      throw err(ERROR_CODES.INVALID_SCHEDULE, multiDay ? `В многодневном заказе каждый день — не меньше ${min} ч` : `Минимальная смена — ${min} ч`, HttpStatus.BAD_REQUEST);
    }
    if (hours.some((h) => h % step !== 0)) throw err(ERROR_CODES.INVALID_SCHEDULE, `Длительность кратна ${step} ч`, HttpStatus.BAD_REQUEST);
    const first = intervals[0] as Interval;
    if (first.start.getTime() < now.getTime() + leadMin * 60_000) {
      throw err(ERROR_CODES.INVALID_SCHEDULE, `Начало работ — не раньше чем через ${leadMin} мин`, HttpStatus.BAD_REQUEST);
    }
    const lastStart = (intervals[intervals.length - 1] as Interval).start;
    if (lastStart.getTime() > now.getTime() + horizonDays * 86_400_000) {
      throw err(ERROR_CODES.INVALID_SCHEDULE, `Заказ можно оформить не более чем за ${horizonDays} дней`, HttpStatus.BAD_REQUEST);
    }
  }

  /** Требования заказчика к характеристикам → условия SQL. Допускаются только характеристики с флагом «фильтр». */
  private async requirementConditions(categoryId: string, reqs: Record<string, RequirementValue>): Promise<SQL[]> {
    const defs = await this.catalog.effectiveAttributes(categoryId);
    const conds: SQL[] = [];
    const errors: { key: string; message: string }[] = [];
    for (const [key, value] of Object.entries(reqs)) {
      const d = defs.find((x) => x.key === key && x.filterable);
      if (!d) {
        errors.push({ key, message: 'по этой характеристике нельзя выбирать' });
        continue;
      }
      if ((d.type === 'number' || d.type === 'integer') && typeof value === 'object') {
        conds.push(sql`(u.attributes->>${key})::numeric >= ${value.min}`);
      } else if (d.type === 'boolean' && typeof value === 'boolean') {
        conds.push(sql`(u.attributes->${key}) = ${JSON.stringify(value)}::jsonb`);
      } else if (d.type === 'enum' && typeof value === 'string' && d.options?.includes(value)) {
        conds.push(sql`(u.attributes->>${key}) = ${value}`);
      } else if (d.type === 'multi_enum' && typeof value === 'string' && d.options?.includes(value)) {
        conds.push(sql`(u.attributes->${key}) ? ${value}`);
      } else {
        errors.push({ key, message: 'неподходящее значение' });
      }
    }
    if (errors.length) throw err(ERROR_CODES.INVALID_ATTRIBUTES, 'Проверьте выбранные характеристики', HttpStatus.BAD_REQUEST, errors);
    return conds;
  }

  /**
   * Ближайшая подходящая свободная техника на линии (Н-1): категория, характеристики, радиус (Н-17),
   * проверенная техника подтверждённой компании, нет пересечений с бронями, укладывается в расписание (В-12),
   * успевает доехать к началу с учётом дороги (Л-4). Из ближайших по прямой выбирается минимальный маршрут.
   */
  private async nearestAvailableUnit(
    categoryId: string,
    site: { lat: number; lng: number },
    intervals: Interval[],
    requirements: SQL[],
    timeZone: string,
    now: Date,
  ): Promise<{ unitId: string; distanceMeters: number; durationSeconds: number; provider: string } | null> {
    const maxKm = await this.settings.get('search_radius_max_km');
    const sitePoint = sql`ST_SetSRID(ST_MakePoint(${site.lng}, ${site.lat}), 4326)::geography`;
    const noOverlap = reservationPeriods(intervals).map(
      (i) => sql`NOT EXISTS (SELECT 1 FROM unit_bookings b WHERE b.unit_id = u.id AND b.status = 'active'
        AND b.period && tstzrange(${i.start.toISOString()}, ${i.end.toISOString()}))`,
    );
    const res = await this.db.execute<{ id: string; lat: number; lng: number }>(sql`
      SELECT u.id, ST_Y(u.base_point::geometry) AS lat, ST_X(u.base_point::geometry) AS lng
      FROM equipment_units u JOIN organizations o ON o.id = u.org_id AND o.status = 'verified'
      WHERE u.category_id = ${categoryId} AND u.is_online AND u.verification_status = 'approved' AND u.archived_at IS NULL
        AND ST_DWithin(u.base_point, ${sitePoint},
              (CASE WHEN u.allow_beyond_radius THEN ${maxKm} ELSE LEAST(u.work_radius_km, ${maxKm}) END) * 1000)
        ${sql.join([...requirements, ...noOverlap].map((c) => sql` AND ${c}`), sql``)}
      ORDER BY ST_Distance(u.base_point, ${sitePoint})
      LIMIT 30`);
    const candidates: Candidate[] = res.rows.map((r) => ({ id: r.id, lat: Number(r.lat), lng: Number(r.lng) }));
    if (candidates.length === 0) return null;

    const schedules = await this.db
      .select()
      .from(equipmentSchedules)
      .where(inArray(equipmentSchedules.unitId, candidates.map((c) => c.id)));
    const available = candidates.filter((c) => {
      const sch = schedules
        .filter((s) => s.unitId === c.id)
        .map((s) => ({ weekday: s.weekday, start: s.startTime.slice(0, 5), end: s.endTime.slice(0, 5) }));
      return intervals.every((i) => fitsSchedule(i.start, i.end, sch, timeZone));
    });

    const first = intervals[0] as Interval;
    let best: { unitId: string; distanceMeters: number; durationSeconds: number; provider: string } | null = null;
    for (const c of available.slice(0, ROUTE_CANDIDATES)) {
      const r = await this.routing.route({ lat: c.lat, lng: c.lng }, site, now);
      if (now.getTime() + r.durationSeconds * 1000 > first.start.getTime()) continue; // не успевает к началу (Л-4)
      if (!best || r.distanceMeters < best.distanceMeters) best = { unitId: c.id, ...r };
    }
    return best;
  }

  async getQuote(customerId: string, id: string) {
    const res = await this.db.execute(sql`SELECT * FROM quotes WHERE id = ${id} AND customer_id = ${customerId}`);
    const row = res.rows[0];
    if (!row) throw err(ERROR_CODES.NOT_FOUND, 'Расчёт не найден', HttpStatus.NOT_FOUND);
    return row;
  }
}

/** Делит рабочие периоды на смены не длиннее maxShift часов (К-3). */
export function splitIntoShifts(intervals: Interval[], maxShiftHours: number): QuoteShift[] {
  const shifts: QuoteShift[] = [];
  for (const i of intervals) {
    let start = i.start.getTime();
    const end = i.end.getTime();
    while (start < end) {
      const stop = Math.min(start + maxShiftHours * 3_600_000, end);
      shifts.push({ start: new Date(start).toISOString(), end: new Date(stop).toISOString(), hours: (stop - start) / 3_600_000 });
      start = stop;
    }
  }
  return shifts;
}

/**
 * Период резервирования техники: весь заказ от начала первой смены до конца последней,
 * включая ночи и перерывы между сменами (М-2, С-22).
 */
export function reservationPeriods(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const start = Math.min(...intervals.map((i) => i.start.getTime()));
  const end = Math.max(...intervals.map((i) => i.end.getTime()));
  return [{ start: new Date(start), end: new Date(end) }];
}
