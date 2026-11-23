import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { writeFileSync } from 'node:fs';
import { createApp } from '../../src/app.factory';
import type Redis from 'ioredis';
import { JobsService } from '../../src/jobs/jobs.service';
import { REDIS } from '../../src/redis/redis.module';
import { resetTestDatabase } from '../db';
import { TestClient } from '../helpers';

/**
 * Нагрузочный тест подбора исполнителя (этап 13). Запуск: pnpm --filter @kovsh/api test:load
 * Параметры: LOAD_COMPANIES, LOAD_UNITS, LOAD_ORDERS, LOAD_WORKERS. Результат — в LOAD_REPORT (JSON).
 * Маршрутизация — тестовая (прямая × 1,3): время ответа Яндекс Маршрутизации сюда не входит.
 */
process.env.SETTINGS_CACHE_MS = '5000';
const N_COMPANIES = Number(process.env.LOAD_COMPANIES ?? 100);
const UNITS_PER = Number(process.env.LOAD_UNITS ?? 3);
const N_ORDERS = Number(process.env.LOAD_ORDERS ?? 200);
const WORKERS = Number(process.env.LOAD_WORKERS ?? 4);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 20);
const ZONE = { type: 'Polygon', coordinates: [[[36.8, 55.1], [38.5, 55.1], [38.5, 56.4], [36.8, 56.4], [36.8, 55.1]]] };
const C = { lat: 55.7558, lng: 37.6173 };
const mskDate = (days: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date(Date.now() + days * 86_400_000));
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!) : 0; };
// Детерминированный «случайный» разброс точек, чтобы прогоны были сравнимы.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const around = (km: number) => { const a = rnd() * 2 * Math.PI, r = Math.sqrt(rnd()) * km; return { lat: C.lat + (r * Math.cos(a)) / 111.2, lng: C.lng + (r * Math.sin(a)) / (111.2 * Math.cos((C.lat * Math.PI) / 180)) }; };
const inn10 = (n: number) => { const b = String(770000000 + n); const w = [2, 4, 10, 3, 5, 9, 4, 6, 8]; const c = (w.reduce((s, k, i) => s + k * Number(b[i]), 0) % 11) % 10; return b + c; };

async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k]!, k); } }));
}

describe(`Нагрузка подбора: ${N_COMPANIES} компаний × ${UNITS_PER} ед. техники, ${N_ORDERS} заказов, ${WORKERS} обработчика`, () => {
  let app: INestApplication;
  let db: Pool;
  let t: TestClient;
  let jobs: JobsService;
  let catId: string;
  const report: Record<string, unknown> = { companies: N_COMPANIES, units: N_COMPANIES * UNITS_PER, orders: N_ORDERS, workers: WORKERS, routing: 'dev (прямая × 1,3)' };

  beforeAll(async () => {
    db = await resetTestDatabase();
    app = await createApp();
    await app.init();
    t = new TestClient(app);
    jobs = app.get(JobsService);
    const moscow = (await db.query("SELECT id FROM regions WHERE code = 'moscow'")).rows[0].id;
    catId = (await db.query("SELECT id FROM equipment_categories WHERE slug = 'mini_excavator'")).rows[0].id;
    await db.query("INSERT INTO service_zones (region_id, name, area) VALUES ($1, 'нагрузка', ST_Multi(ST_GeomFromGeoJSON($2))::geography)", [moscow, JSON.stringify(ZONE)]);
    await db.query("INSERT INTO tariffs (category_id, region_id, kind, price_kopecks, valid_from) VALUES ($1, $2, 'delivery_km', 10000, now() - interval '1 day')", [catId, moscow]);

    const t0 = Date.now();
    for (let c = 0; c < N_COMPANIES; c++) {
      const owner = (await db.query("INSERT INTO users (phone, full_name) VALUES ($1, $2) RETURNING id", [`+7917${String(c).padStart(7, '0')}`, `Владелец ${c}`])).rows[0].id;
      const org = (await db.query(
        `INSERT INTO organizations (kind, legal_form, name, representative_name, inn, ogrn, legal_address, email, contact_phone, created_by, status, verified_at)
         VALUES ('partner', 'llc', $1, 'Иванов И.И.', $2, $3, 'Москва', 'a@b.ru', '+79160000000', $4, 'verified', now()) RETURNING id`,
        [`ООО Нагрузка ${c}`, inn10(c), String(1027700000000 + c), owner])).rows[0].id;
      await db.query("INSERT INTO organization_members (org_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')", [org, owner]);
      for (let u = 0; u < UNITS_PER; u++) {
        const p = around(40);
        await db.query(
          `INSERT INTO equipment_units (org_id, category_id, brand, model, year, attributes, base_point, base_address, work_radius_km, allow_beyond_radius, is_online, verification_status, created_by)
           VALUES ($1, $2, 'JCB', '8030', 2021, '{"operating_weight": 3}', ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, 'База', 60, true, true, 'approved', $5)`,
          [org, catId, p.lng, p.lat, owner]);
        const op = (await db.query("INSERT INTO users (phone, full_name) VALUES ($1, $2) RETURNING id", [`+7918${String(c * 10 + u).padStart(7, '0')}`, `Машинист ${c}-${u}`])).rows[0].id;
        await db.query("INSERT INTO organization_members (org_id, user_id, role, status, can_operate, operator_verification) VALUES ($1, $2, 'operator', 'active', true, 'approved')", [org, op]);
      }
    }
    report.seedMs = Date.now() - t0;
  }, 600_000);
  afterAll(async () => {
    if (process.env.LOAD_REPORT) writeFileSync(process.env.LOAD_REPORT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    await app.close();
    await db.end();
  });

  it('создание заказов, подбор, гонка принятий и инварианты', async () => {
    // 1. Заказчики и параллельное создание заказов (расчёт + заказ).
    const redis = app.get<Redis>(REDIS);
    // Лимит SMS-кодов на IP (защита от перебора) в нагрузочном тесте снимаем: все «пользователи» идут с одного адреса.
    const login = async (phone: string, appKind: 'client' | 'partner') => { const k = await redis.keys('otp:ip:*'); if (k.length) await redis.del(...k); return t.login(phone, appKind); };
    const log = (m: string) => process.stderr.write(`[load] ${m}\n`);
    log('seed done');
    const customers: string[] = [];
    for (let i = 0; i < 20; i++) customers.push((await login(`+7919${String(i).padStart(7, '0')}`, 'client')).token);
    log('customers logged in');
    const quoteMs: number[] = [], orderMs: number[] = [];
    const orderIds: string[] = [];
    const t1 = Date.now();
    await pool(Array.from({ length: N_ORDERS }, (_, i) => i), CONCURRENCY, async (i) => {
      const token = customers[i % customers.length]!;
      const site = around(30);
      // Заказы разнесены по 10 дням, чтобы техника могла получить несколько заказов.
      const days = [{ date: mskDate(2 + (i % 10)), startTime: '08:00', hours: 8 }];
      let s = Date.now();
      const q = await t.http().post('/api/v1/client/quotes').set('Authorization', `Bearer ${token}`).send({ categoryId: catId, site: { ...site, address: `Точка ${i}` }, days });
      quoteMs.push(Date.now() - s);
      if (q.status !== 201) log(`quote ${q.status} ${JSON.stringify(q.body).slice(0, 200)}`);
      if (q.status !== 201) return;
      s = Date.now();
      const o = await t.http().post('/api/v1/client/orders').set('Authorization', `Bearer ${token}`).send({ quoteId: q.body.id });
      orderMs.push(Date.now() - s);
      if (o.status === 201) orderIds.push(o.body.id);
    });
    report.createPhaseMs = Date.now() - t1;
    log(`orders created ${orderIds.length}`);
    report.ordersCreated = orderIds.length;
    report.quoteLatencyMs = { p50: pct(quoteMs, 50), p95: pct(quoteMs, 95), max: pct(quoteMs, 100) };
    report.orderLatencyMs = { p50: pct(orderMs, 50), p95: pct(orderMs, 95), max: pct(orderMs, 100) };
    expect(orderIds.length).toBe(N_ORDERS);

    // 2. Подбор: несколько параллельных обработчиков задач (как несколько экземпляров сервера).
    const t2 = Date.now();
    for (let round = 0; round < 20; round++) {
      await Promise.all(Array.from({ length: WORKERS }, () => jobs.runDue()));
      const left = (await db.query("SELECT count(*)::int AS n FROM orders WHERE status = 'searching'")).rows[0].n;
      log(`round ${round}: searching ${left}`);
      if (left === 0) break;
    }
    report.matchPhaseMs = Date.now() - t2;
    const firstOffer = await db.query(`
      SELECT EXTRACT(EPOCH FROM (min(f.offered_at) - o.created_at)) * 1000 AS ms FROM orders o JOIN order_offers f ON f.order_id = o.id GROUP BY o.id`);
    const ttfo = firstOffer.rows.map((r) => Number(r.ms));
    report.timeToFirstOfferMs = { p50: pct(ttfo, 50), p95: pct(ttfo, 95), max: pct(ttfo, 100) };
    const offered = (await db.query("SELECT count(*)::int AS n FROM orders WHERE status = 'offered'")).rows[0].n;
    report.ordersWithOffer = offered;
    expect(offered).toBe(N_ORDERS);

    // Инвариант: не больше одного активного предложения на заказ (П-последовательная выдача).
    const multi = (await db.query("SELECT count(*)::int AS n FROM (SELECT order_id FROM order_offers WHERE status = 'pending' GROUP BY order_id HAVING count(*) > 1) x")).rows[0].n;
    expect(multi).toBe(0);

    log('matching done');
    // 3. Гонка: 5 параллельных «Принять» на каждое предложение (несколько диспетчеров одной компании).
    const offers = (await db.query("SELECT f.id, f.org_id, f.order_id, m.user_id FROM order_offers f JOIN organization_members m ON m.org_id = f.org_id AND m.role = 'owner' WHERE f.status = 'pending'")).rows;
    const tokens = new Map<string, string>();
    const owners = [...new Set(offers.map((o) => o.user_id as string))];
    for (const uid of owners) {
      const phone = (await db.query('SELECT phone FROM users WHERE id = $1', [uid])).rows[0].phone;
      tokens.set(uid, (await login(phone, 'partner')).token);
    }
    const acceptMs: number[] = [];
    let wins = 0, conflicts = 0, other = 0;
    const t3 = Date.now();
    await pool(offers, CONCURRENCY / 2, async (f) => {
      const tok = tokens.get(f.user_id)!;
      const res = await Promise.all(Array.from({ length: 5 }, async () => {
        const s = Date.now();
        const r = await t.http().post(`/api/v1/partner/offers/${f.id}/accept`).set('Authorization', `Bearer ${tok}`).set('X-Org-Id', f.org_id);
        acceptMs.push(Date.now() - s);
        return r.status;
      }));
      const ok = res.filter((s) => s === 204).length;
      wins += ok;
      conflicts += res.filter((s) => s === 409 || s === 410).length;
      other += res.filter((s) => s !== 204 && s !== 409 && s !== 410).length;
      expect(ok).toBeLessThanOrEqual(1);
    });
    report.acceptPhaseMs = Date.now() - t3;
    report.acceptLatencyMs = { p50: pct(acceptMs, 50), p95: pct(acceptMs, 95), max: pct(acceptMs, 100) };
    report.acceptRace = { offers: offers.length, attempts: offers.length * 5, accepted: wins, rejectedAsDuplicate: conflicts, otherStatuses: other };

    // Инварианты после гонки.
    const doubleAccepted = (await db.query("SELECT count(*)::int AS n FROM (SELECT order_id FROM order_offers WHERE status = 'accepted' GROUP BY order_id HAVING count(*) > 1) x")).rows[0].n;
    expect(doubleAccepted).toBe(0);
    const overlap = (await db.query(`
      SELECT count(*)::int AS n FROM unit_bookings a JOIN unit_bookings b ON a.unit_id = b.unit_id AND a.id < b.id AND a.period && b.period
      WHERE a.status = 'active' AND b.status = 'active'`)).rows[0].n;
    expect(overlap).toBe(0);
    const acceptedOrders = (await db.query("SELECT count(*)::int AS n FROM orders WHERE status = 'awaiting_prepayment'")).rows[0].n;
    report.ordersAccepted = acceptedOrders;
    expect(acceptedOrders).toBe(wins);
  }, 900_000);
});
