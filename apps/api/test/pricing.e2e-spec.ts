import type { INestApplication } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { createApp } from '../src/app.factory';
import { haversineMeters } from '../src/geo/routing.provider';
import { REDIS } from '../src/redis/redis.module';
import { resetTestDatabase } from './db';
import { innLegal, ogrnLegal, TestClient } from './helpers';

const ZONE = { type: 'Polygon', coordinates: [[[36.8, 55.1], [38.5, 55.1], [38.5, 56.4], [36.8, 56.4], [36.8, 55.1]]] };
const SITE = { lat: 55.7558, lng: 37.6173, address: 'Москва, Красная площадь' };
/** Точка в `km` километрах к северу от объекта. */
const north = (km: number) => ({ lat: SITE.lat + km / 111.2, lng: SITE.lng });
const expectedKmTenths = (p: { lat: number; lng: number }) => Math.round((haversineMeters(p, SITE) * 1.3) / 100);

/** Дата в Москве через `days` дней (YYYY-MM-DD). */
const mskDate = (days: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date(Date.now() + days * 86_400_000));

describe('Этап 5: расчёт стоимости', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;
  let t: TestClient;
  let client: string;
  let orgId: string;
  let catId: string;
  let moscowId: string;
  let seq = 0;
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function unit(at: { lat: number; lng: number }, extra: { attrs?: Record<string, unknown>; radius?: number; beyond?: boolean } = {}) {
    seq++;
    const res = await pool.query(
      `INSERT INTO equipment_units (org_id, category_id, brand, model, year, attributes, base_point, base_address, work_radius_km,
         allow_beyond_radius, is_online, verification_status, created_by)
       VALUES ($1, $2, 'JCB', 'X', 2020, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, 'База', $6, $7, true, 'approved',
         (SELECT created_by FROM organizations WHERE id = $1)) RETURNING id`,
      [orgId, catId, JSON.stringify(extra.attrs ?? { operating_weight: 3, undercarriage: 'Гусеничная' }), at.lng, at.lat, extra.radius ?? 100, extra.beyond ?? false],
    );
    return res.rows[0].id as string;
  }

  const quote = (body: Record<string, unknown>, token = client) =>
    t.http().post('/api/v1/client/quotes').set(bearer(token)).send({ categoryId: catId, site: SITE, days: [{ date: mskDate(2), startTime: '08:00', hours: 8 }], ...body });

  beforeAll(async () => {
    pool = await resetTestDatabase();
    app = await createApp();
    await app.init();
    redis = app.get(REDIS);
    t = new TestClient(app);
    moscowId = (await pool.query("SELECT id FROM regions WHERE code = 'moscow'")).rows[0].id;
    catId = (await pool.query("SELECT id FROM equipment_categories WHERE slug = 'mini_excavator'")).rows[0].id;
    await pool.query("INSERT INTO service_zones (region_id, name, area) VALUES ($1, 'тест', ST_Multi(ST_GeomFromGeoJSON($2))::geography)", [moscowId, JSON.stringify(ZONE)]);
    await pool.query("INSERT INTO tariffs (category_id, region_id, kind, price_kopecks, valid_from) VALUES ($1, $2, 'delivery_km', 10000, now() - interval '1 day')", [catId, moscowId]);
    const partner = await t.login('+79164000001');
    const org = await t.http().post('/api/v1/partner/organizations').set(bearer(partner.token)).send({
      kind: 'partner', legalForm: 'llc', name: 'ООО Ковш', representativeName: 'Иванов И.И.', inn: innLegal(7001), ogrn: ogrnLegal(7001),
      legalAddress: 'Москва, 1', email: 'a@b.ru', contactPhone: '+79160000099',
    }).expect(201);
    orgId = org.body.id;
    await pool.query("UPDATE organizations SET status = 'verified' WHERE id = $1", [orgId]);
    client = (await t.login('+79164000002', 'client')).token;
  });
  beforeEach(async () => {
    await redis.flushdb();
    await pool.query('DELETE FROM quotes; DELETE FROM unit_bookings; DELETE FROM equipment_schedules; DELETE FROM equipment_units');
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('аренда = часы × тариф, доставка = км (до 0,1) × 2 × тариф за км, итог — целые рубли; первый платёж: физлицо 100%, юрлицо 50%', async () => {
    const base = north(10);
    await unit(base);
    const res = await quote({}).expect(201);
    const km10 = expectedKmTenths(base);
    const delivery = Math.round((km10 * 2 * 10000) / 10);
    const total = Math.round((8 * 250000 + delivery) / 100) * 100;
    expect(res.body).toMatchObject({
      urgency: 'scheduled', totalHours: 8, hourPriceKopecks: 250000, kmPriceKopecks: 10000, deliveryKm: km10 / 10,
      rentKopecks: 2_000_000, deliveryKopecks: delivery, totalKopecks: total, prepaymentKopecks: total, legalFirstPaymentKopecks: Math.round(total / 2 / 100) * 100,
      region: { name: 'Москва' },
    });
    expect(res.body.totalKopecks % 100).toBe(0);
    expect(res.body.shifts).toHaveLength(1);
  });

  it('доставка считается от ближайшей свободной техники (Н-1)', async () => {
    await unit(north(30));
    const near = await unit(north(8));
    const res = await quote({}).expect(201);
    expect(res.body.deliveryKm).toBe(expectedKmTenths(north(8)) / 10);
    const row = await pool.query('SELECT reference_unit_id FROM quotes WHERE id = $1', [res.body.id]);
    expect(row.rows[0].reference_unit_id).toBe(near);
  });

  it('занятая или нерабочая по расписанию техника пропускается', async () => {
    const near = await unit(north(5));
    const mid = await unit(north(15));
    await unit(north(25));
    const date = mskDate(2);
    await pool.query(`INSERT INTO unit_bookings (unit_id, period) VALUES ($1, tstzrange(($2::date + time '10:00') AT TIME ZONE 'Europe/Moscow', ($2::date + time '12:00') AT TIME ZONE 'Europe/Moscow'))`, [near, date]);
    const weekday = ((new Date(`${date}T12:00:00+03:00`).getUTCDay() + 6) % 7) + 1;
    await pool.query("INSERT INTO equipment_schedules (unit_id, weekday, start_time, end_time) VALUES ($1, $2, '12:00', '20:00')", [mid, weekday]);
    const res = await quote({}).expect(201);
    expect(res.body.deliveryKm).toBe(expectedKmTenths(north(25)) / 10);
  });

  it('требования к характеристикам', async () => {
    await unit(north(5), { attrs: { operating_weight: 2, undercarriage: 'Гусеничная' } });
    await unit(north(20), { attrs: { operating_weight: 5, undercarriage: 'Колёсная' } });
    const res = await quote({ requirements: { operating_weight: { min: 4 } } }).expect(201);
    expect(res.body.deliveryKm).toBe(expectedKmTenths(north(20)) / 10);
    const wheeled = await quote({ requirements: { undercarriage: 'Колёсная' } }).expect(201);
    expect(wheeled.body.deliveryKm).toBe(expectedKmTenths(north(20)) / 10);
    const bad = await quote({ requirements: { bucket_width: { min: 1 } } }).expect(400);
    expect(bad.body.code).toBe('INVALID_ATTRIBUTES');
    const none = await quote({ requirements: { operating_weight: { min: 50 } } }).expect(422);
    expect(none.body.code).toBe('NO_EQUIPMENT_AVAILABLE');
  });

  it('рабочий радиус и флаг «выезжать дальше радиуса» (Н-17)', async () => {
    await unit(north(40), { radius: 30 });
    await quote({}).expect(422);
    await unit(north(60), { radius: 30, beyond: true });
    const res = await quote({}).expect(201);
    expect(res.body.deliveryKm).toBe(expectedKmTenths(north(60)) / 10);
  });

  it('многодневный заказ: дни и часы выбирает заказчик (Л-1), день длиннее 11 ч делится на смены (К-3)', async () => {
    await unit(north(10));
    const res = await quote({ days: [{ date: mskDate(3), startTime: '06:00', hours: 15 }, { date: mskDate(4), startTime: '08:00', hours: 8 }] }).expect(201);
    expect(res.body.totalHours).toBe(23);
    expect(res.body.shifts.map((s: { hours: number }) => s.hours)).toEqual([11, 4, 8]);
    expect(res.body.rentKopecks).toBe(23 * 250000);
  });

  it('многодневный заказ: минимум 8 часов в каждый день, однодневный — 4 часа (М-1, С-19)', async () => {
    await unit(north(10));
    const short = await quote({ days: [{ date: mskDate(3), startTime: '08:00', hours: 8 }, { date: mskDate(4), startTime: '08:00', hours: 6 }] }).expect(400);
    expect(short.body.message).toMatch(/каждый день — не меньше 8/);
    await quote({ days: [{ date: mskDate(3), startTime: '08:00', hours: 8 }, { date: mskDate(4), startTime: '08:00', hours: 8 }] }).expect(201);
    await quote({ days: [{ date: mskDate(3), startTime: '08:00', hours: 4 }] }).expect(201);
  });

  it('многодневный заказ: техника должна быть свободна весь период, включая ночь (М-2)', async () => {
    const u = await unit(north(5));
    await unit(north(30));
    const night = mskDate(3);
    await pool.query(`INSERT INTO unit_bookings (unit_id, period) VALUES ($1, tstzrange(($2::date + time '22:00') AT TIME ZONE 'Europe/Moscow', ($2::date + time '23:00') AT TIME ZONE 'Europe/Moscow'))`, [u, night]);
    const res = await quote({ days: [{ date: mskDate(3), startTime: '08:00', hours: 8 }, { date: mskDate(4), startTime: '08:00', hours: 8 }] }).expect(201);
    expect(res.body.deliveryKm).toBe(expectedKmTenths(north(30)) / 10);
  });

  it('сроки: не раньше чем через час, не дальше 30 дней, минимум 4 часа', async () => {
    await unit(north(10));
    const soon = new Date(Date.now() + 30 * 60_000);
    const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(soon);
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(soon);
    expect((await quote({ days: [{ date, startTime: hhmm, hours: 4 }] }).expect(400)).body.code).toBe('INVALID_SCHEDULE');
    expect((await quote({ days: [{ date: mskDate(32), startTime: '08:00', hours: 8 }] }).expect(400)).body.code).toBe('INVALID_SCHEDULE');
    expect((await quote({ days: [{ date: mskDate(2), startTime: '08:00', hours: 3 }] }).expect(400)).body.code).toBe('INVALID_SCHEDULE');
    expect((await quote({ days: [{ date: mskDate(2), startTime: '08:00', hours: 4 }, { date: mskDate(2), startTime: '14:00', hours: 4 }] }).expect(400)).body.code).toBe('INVALID_SCHEDULE');
  });

  it('срочный заказ: техника должна успеть доехать к началу (Л-4, К-2)', async () => {
    await unit(north(120), { beyond: true });
    const start = new Date(Date.now() + 2 * 3_600_000);
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(start);
    const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(start);
    const res = await quote({ days: [{ date, startTime: hhmm, hours: 4 }] });
    // 120 км × 1,3 при 40 км/ч ≈ 3,9 ч — не успевает за 2 часа.
    expect(res.body.code).toBe('NO_EQUIPMENT_AVAILABLE');
    await unit(north(20));
    const ok = await quote({ days: [{ date, startTime: hhmm, hours: 4 }] }).expect(201);
    expect(ok.body.urgency).toBe('urgent');
  });

  it('нет тарифа доставки или адрес вне региона — расчёт не выдумывается', async () => {
    const crane = (await pool.query("SELECT id FROM equipment_categories WHERE slug = 'crane_upto_25'")).rows[0].id;
    const noTariff = await quote({ categoryId: crane }).expect(422);
    expect(noTariff.body).toMatchObject({ code: 'TARIFF_NOT_FOUND', details: { missing: ['delivery_km'] } });
    const outside = await quote({ site: { lat: 59.93, lng: 30.31, address: 'Санкт-Петербург' } }).expect(404);
    expect(outside.body.code).toBe('REGION_NOT_FOUND');
  });

  it('цена в расчёте фиксируется: новый тариф её не меняет', async () => {
    await unit(north(10));
    const res = await quote({}).expect(201);
    await pool.query("INSERT INTO tariffs (category_id, region_id, kind, price_kopecks, valid_from) VALUES ($1, $2, 'rent_hour', 999900, now())", [catId, moscowId]);
    const saved = await pool.query('SELECT total_kopecks, hour_price_kopecks FROM quotes WHERE id = $1', [res.body.id]);
    expect(Number(saved.rows[0].total_kopecks)).toBe(res.body.totalKopecks);
    expect(Number(saved.rows[0].hour_price_kopecks)).toBe(250000);
    const fresh = await quote({}).expect(201);
    expect(fresh.body.hourPriceKopecks).toBe(999900);
  });

  it('расчёт — только в приложении заказчика', async () => {
    const partner = await t.login('+79164000001');
    await quote({}, partner.token).expect(403);
  });
});
