import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { createApp } from '../src/app.factory';
import { JobsService } from '../src/jobs/jobs.service';
import { REDIS } from '../src/redis/redis.module';
import { resetTestDatabase } from './db';
import { innLegal, ogrnLegal, TestClient } from './helpers';

const ZONE = { type: 'Polygon', coordinates: [[[36.8, 55.1], [38.5, 55.1], [38.5, 56.4], [36.8, 56.4], [36.8, 55.1]]] };
const SITE = { lat: 55.7558, lng: 37.6173, address: 'Москва, Красная площадь' };
const north = (km: number) => ({ lat: SITE.lat + km / 111.2, lng: SITE.lng });
const mskDate = (days: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date(Date.now() + days * 86_400_000));

interface Company { orgId: string; owner: string; ownerUserId: string; unitId: string; operators: { token: string; userId: string; memberId: string }[] }

describe('Этап 6: заказы и распределение', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;
  let t: TestClient;
  let jobs: JobsService;
  let catId: string;
  let moscowId: string;
  let customer: { token: string; userId: string };
  let phoneSeq = 0;
  let innSeq = 8000;
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const inOrg = (token: string, orgId: string) => ({ ...bearer(token), 'X-Org-Id': orgId });
  const phone = () => `+7916500${String(++phoneSeq).padStart(4, '0')}`;

  async function company(km: number, opts: { operators?: number; approvedOperators?: boolean } = {}): Promise<Company> {
    const owner = await t.login(phone());
    const org = (await t.http().post('/api/v1/partner/organizations').set(bearer(owner.token)).send({
      kind: 'partner', legalForm: 'llc', name: `ООО Техника ${innSeq}`, representativeName: 'Иванов И.И.', inn: innLegal(innSeq), ogrn: ogrnLegal(innSeq++),
      legalAddress: 'Москва, 1', email: 'a@b.ru', contactPhone: '+79160000099',
    }).expect(201)).body;
    await pool.query("UPDATE organizations SET status = 'verified', verified_at = now() WHERE id = $1", [org.id]);
    const base = north(km);
    const unit = await pool.query(
      `INSERT INTO equipment_units (org_id, category_id, brand, model, year, attributes, base_point, base_address, work_radius_km, allow_beyond_radius,
         is_online, verification_status, created_by)
       VALUES ($1, $2, 'JCB', '8030', 2021, '{"operating_weight": 3}', ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, 'База', 150, true, true, 'approved', $5)
       RETURNING id`, [org.id, catId, base.lng, base.lat, owner.userId]);
    const operators: Company['operators'] = [];
    for (let i = 0; i < (opts.operators ?? 1); i++) {
      const p = phone();
      await t.http().post('/api/v1/partner/members').set(inOrg(owner.token, org.id)).send({ phone: p, role: 'operator', fullName: `Машинист ${p.slice(-4)}` }).expect(201);
      const op = await t.login(p);
      const inv = (await t.http().get('/api/v1/partner/invitations').set(bearer(op.token))).body;
      await t.http().post(`/api/v1/partner/invitations/${inv[0].memberId}/accept`).set(bearer(op.token)).expect(204);
      if (opts.approvedOperators !== false) await pool.query("UPDATE organization_members SET operator_verification = 'approved' WHERE id = $1", [inv[0].memberId]);
      operators.push({ token: op.token, userId: op.userId, memberId: inv[0].memberId });
    }
    await redis.flushdb();
    return { orgId: org.id, owner: owner.token, ownerUserId: owner.userId, unitId: unit.rows[0].id, operators };
  }

  async function order(days = [{ date: mskDate(2), startTime: '08:00', hours: 8 }]): Promise<string> {
    const q = await t.http().post('/api/v1/client/quotes').set(bearer(customer.token)).send({ categoryId: catId, site: SITE, days }).expect(201);
    const o = await t.http().post('/api/v1/client/orders').set(bearer(customer.token)).send({ quoteId: q.body.id }).expect(201);
    await jobs.runDue();
    return o.body.id;
  }

  const status = async (orderId: string) => (await pool.query('SELECT status FROM orders WHERE id = $1', [orderId])).rows[0].status as string;
  const pendingOffer = async (orderId: string) =>
    (await pool.query("SELECT id, org_id FROM order_offers WHERE order_id = $1 AND status = 'pending'", [orderId])).rows[0] as { id: string; org_id: string } | undefined;
  /** «Перемотать время»: созреть заданиям нужного типа и выполнить их. */
  async function fire(type: string, orderId: string) {
    await pool.query("UPDATE scheduled_jobs SET run_at = now() - interval '1 second' WHERE status = 'pending' AND type = $1 AND payload->>'orderId' = $2", [type, orderId]);
    await jobs.runDue();
  }
  async function expireOffer(orderId: string) {
    await pool.query("UPDATE order_offers SET expires_at = now() - interval '1 second' WHERE order_id = $1 AND status = 'pending'", [orderId]);
    await fire('offer_timeout', orderId);
  }
  async function pay(orderId: string) {
    const p = await t.http().post(`/api/v1/client/orders/${orderId}/payments`).set(bearer(customer.token)).expect(201);
    const providerId = String(p.body.confirmationUrl).split('/').pop();
    await t.http().post(`/api/v1/dev/payments/${providerId}/succeed`).expect(200);
  }
  async function acceptAndPay(c: Company, orderId: string) {
    const offer = await pendingOffer(orderId);
    expect(offer?.org_id).toBe(c.orgId);
    await t.http().post(`/api/v1/partner/offers/${offer?.id}/accept`).set(inOrg(c.owner, c.orgId)).expect(204);
    await pay(orderId);
  }
  async function assign(c: Company, orderId: string, idx = 0) {
    await t.http().post(`/api/v1/partner/orders/${orderId}/assign-operator`).set(inOrg(c.owner, c.orgId)).send({ memberId: c.operators[idx]?.memberId }).expect(204);
  }
  const ev = (status: string, extra: Record<string, unknown> = {}) => ({ clientEventId: randomUUID(), status, recordedAt: new Date().toISOString(), ...extra });

  beforeAll(async () => {
    pool = await resetTestDatabase();
    app = await createApp();
    await app.init();
    redis = app.get(REDIS);
    jobs = app.get(JobsService);
    t = new TestClient(app);
    moscowId = (await pool.query("SELECT id FROM regions WHERE code = 'moscow'")).rows[0].id;
    catId = (await pool.query("SELECT id FROM equipment_categories WHERE slug = 'mini_excavator'")).rows[0].id;
    await pool.query("INSERT INTO service_zones (region_id, name, area) VALUES ($1, 'тест', ST_Multi(ST_GeomFromGeoJSON($2))::geography)", [moscowId, JSON.stringify(ZONE)]);
    await pool.query("INSERT INTO tariffs (category_id, region_id, kind, price_kopecks, valid_from) VALUES ($1, $2, 'delivery_km', 10000, now() - interval '1 day')", [catId, moscowId]);
    customer = await t.login(phone(), 'client');
  });
  beforeEach(async () => {
    await redis.flushdb();
    await pool.query(`UPDATE scheduled_jobs SET status = 'cancelled' WHERE status = 'pending';
      UPDATE equipment_units SET is_online = false;`);
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('полный путь: поиск → предложение → принятие → предоплата → машинист → работа → завершение', async () => {
    const c = await company(10);
    const id = await order();
    expect(await status(id)).toBe('offered');
    const offers = await t.http().get('/api/v1/partner/offers').set(inOrg(c.owner, c.orgId)).expect(200);
    expect(offers.body).toHaveLength(1);
    expect(new Date(offers.body[0].expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(40_000);

    await t.http().post(`/api/v1/partner/offers/${offers.body[0].offerId}/accept`).set(inOrg(c.owner, c.orgId)).expect(204);
    expect(await status(id)).toBe('awaiting_prepayment');
    await pay(id);
    expect(await status(id)).toBe('awaiting_assignment');

    const ops = await t.http().get(`/api/v1/partner/orders/${id}/available-operators`).set(inOrg(c.owner, c.orgId)).expect(200);
    expect(ops.body.operators).toEqual([expect.objectContaining({ memberId: c.operators[0]?.memberId, free: true })]);
    await assign(c, id);
    expect(await status(id)).toBe('assigned');

    const view = await t.http().get(`/api/v1/client/orders/${id}`).set(bearer(customer.token)).expect(200);
    expect(view.body.partner.name).toMatch(/ООО Техника/);
    expect(view.body.equipment).toMatchObject({ brand: 'JCB', model: '8030' });
    expect(view.body.shifts[0].operator.fullName).toMatch(/Машинист/);
    expect(view.body.visibleStatus).toBe('in_progress');

    const op = c.operators[0]!;
    const res = await t.http().post(`/api/v1/partner/operator/orders/${id}/status-events`).set(inOrg(op.token, c.orgId))
      .send({ events: [ev('en_route', { point: north(10) }), ev('arrived', { locationUnavailableReason: 'gps_off' }), ev('in_progress'), ev('finished')] }).expect(200);
    expect(res.body.results.map((r: { result: string }) => r.result)).toEqual(['applied', 'applied', 'applied', 'applied']);
    expect(await status(id)).toBe('awaiting_completion_confirmation');

    await t.http().post(`/api/v1/client/orders/${id}/confirm-completion`).set(bearer(customer.token)).expect(204);
    // Физлицо оплатило 100% заранее — заказ сразу завершён (решения 07).
    expect(await status(id)).toBe('completed');
    const hist = await pool.query("SELECT to_status FROM order_status_history WHERE order_id = $1 AND to_status NOT LIKE 'shift:%' ORDER BY id", [id]);
    expect(hist.rows.map((r) => r.to_status)).toEqual([
      'searching', 'offered', 'awaiting_prepayment', 'awaiting_assignment', 'assigned', 'en_route', 'arrived', 'in_progress',
      'awaiting_completion_confirmation', 'completed',
    ]);
    const gps = await pool.query("SELECT location_unavailable_reason, point IS NOT NULL AS has_point FROM order_status_history WHERE order_id = $1 AND to_status LIKE 'shift:%' ORDER BY id", [id]);
    expect(gps.rows[0]).toEqual({ location_unavailable_reason: null, has_point: true });
    expect(gps.rows[1]).toEqual({ location_unavailable_reason: 'gps_off', has_point: false });
  });

  it('предложение одному исполнителю за раз; «Пропустить» и тайм-аут — сразу следующему', async () => {
    const a = await company(5);
    const b = await company(12);
    const c = await company(20);
    const id = await order();
    expect((await pendingOffer(id))?.org_id).toBe(a.orgId);
    const all = await pool.query("SELECT count(*)::int AS n FROM order_offers WHERE order_id = $1 AND status = 'pending'", [id]);
    expect(all.rows[0].n).toBe(1);

    await t.http().post(`/api/v1/partner/offers/${(await pendingOffer(id))?.id}/skip`).set(inOrg(a.owner, a.orgId)).expect(204);
    await jobs.runDue();
    expect((await pendingOffer(id))?.org_id).toBe(b.orgId);

    await expireOffer(id);
    expect((await pendingOffer(id))?.org_id).toBe(c.orgId);
    // Компания, которой уже предлагали, не получает повторно в этом раунде.
    await expireOffer(id);
    expect(await pendingOffer(id)).toBeUndefined();
    expect(await status(id)).toBe('searching');
  });

  it('защита от двойного принятия: из параллельных принятий успешно ровно одно; после срока — нельзя', async () => {
    const c = await company(8);
    const dPhone = phone();
    await t.http().post('/api/v1/partner/members').set(inOrg(c.owner, c.orgId)).send({ phone: dPhone, role: 'dispatcher' }).expect(201);
    const d = await t.login(dPhone);
    const inv = (await t.http().get('/api/v1/partner/invitations').set(bearer(d.token))).body;
    await t.http().post(`/api/v1/partner/invitations/${inv[0].memberId}/accept`).set(bearer(d.token)).expect(204);

    const id = await order();
    const offer = await pendingOffer(id);
    const results = await Promise.all([
      t.http().post(`/api/v1/partner/offers/${offer?.id}/accept`).set(inOrg(c.owner, c.orgId)),
      t.http().post(`/api/v1/partner/offers/${offer?.id}/accept`).set(inOrg(d.token, c.orgId)),
      t.http().post(`/api/v1/partner/offers/${offer?.id}/accept`).set(inOrg(c.owner, c.orgId)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 409, 409]);
    const bookings = await pool.query("SELECT count(*)::int AS n FROM unit_bookings WHERE order_id = $1 AND status = 'active'", [id]);
    expect(bookings.rows[0].n).toBe(1);

    const c2 = await company(9);
    const id2 = await order();
    const late = await pendingOffer(id2);
    expect(late?.org_id).toBe(c2.orgId);
    await pool.query('UPDATE order_offers SET expires_at = now() - interval \'1 second\' WHERE id = $1', [late?.id]);
    const r = await t.http().post(`/api/v1/partner/offers/${late?.id}/accept`).set(inOrg(c2.owner, c2.orgId)).expect(409);
    expect(r.body.code).toBe('OFFER_EXPIRED');
  });

  it('расширение радиуса: 30 км, затем +20 км каждые 2 минуты (Н-17)', async () => {
    const far = await company(45);
    const id = await order();
    expect(await status(id)).toBe('searching');
    await pool.query("UPDATE orders SET search_started_at = now() - interval '121 seconds' WHERE id = $1", [id]);
    await fire('search_tick', id);
    const offer = await pool.query('SELECT org_id, radius_km FROM order_offers WHERE order_id = $1', [id]);
    expect(offer.rows[0]).toEqual({ org_id: far.orgId, radius_km: 50 });
  });

  it('компания без свободного проверенного машиниста заказ не получает', async () => {
    await company(3, { approvedOperators: false });
    const ok = await company(15);
    const id = await order();
    expect((await pendingOffer(id))?.org_id).toBe(ok.orgId);
  });

  it('предоплата не поступила за 10 минут — отмена, техника свободна, новый поиск не запускается (Н-8)', async () => {
    const c = await company(6);
    const id = await order();
    await t.http().post(`/api/v1/partner/offers/${(await pendingOffer(id))?.id}/accept`).set(inOrg(c.owner, c.orgId)).expect(204);
    await fire('prepayment_timeout', id);
    expect(await status(id)).toBe('cancelled_unpaid');
    const active = await pool.query("SELECT count(*)::int AS n FROM unit_bookings WHERE order_id = $1 AND status = 'active'", [id]);
    expect(active.rows[0].n).toBe(0);
    expect(await pendingOffer(id)).toBeUndefined();
  });

  it('машинист не назначен за 10 минут — напоминания, затем возврат в поиск без этой компании (Р-7, П-6, П-12)', async () => {
    const a = await company(4);
    const b = await company(14);
    const id = await order();
    await acceptAndPay(a, id);
    await fire('assignment_reminder', id);
    const reminders = await pool.query("SELECT count(*)::int AS n FROM domain_events WHERE order_id = $1 AND type = 'order.assign_reminder'", [id]);
    expect(reminders.rows[0].n).toBe(2);
    await fire('assignment_deadline', id);
    await jobs.runDue();
    expect(await status(id)).toBe('offered');
    expect((await pendingOffer(id))?.org_id).toBe(b.orgId);
    const incident = await pool.query("SELECT type FROM partner_incidents WHERE org_id = $1 AND order_id = $2", [a.orgId, id]);
    expect(incident.rows.map((r) => r.type)).toContain('assignment_timeout');
    // Повторный поиск после предоплаты: принятие сразу ведёт к назначению машиниста.
    await t.http().post(`/api/v1/partner/offers/${(await pendingOffer(id))?.id}/accept`).set(inOrg(b.owner, b.orgId)).expect(204);
    expect(await status(id)).toBe('awaiting_assignment');
    const price = await pool.query('SELECT total_kopecks, customer_delivery_kopecks, partner_delivery_kopecks FROM orders WHERE id = $1', [id]);
    expect(Number(price.rows[0].partner_delivery_kopecks)).toBeGreaterThan(Number(price.rows[0].customer_delivery_kopecks));
  });

  it('отказ машиниста до выезда: 10 минут на замену; после выезда отказ недоступен (П-7, Л-6)', async () => {
    const c = await company(7, { operators: 2 });
    const id = await order();
    await acceptAndPay(c, id);
    await assign(c, id, 0);
    const op0 = c.operators[0]!;
    await t.http().post(`/api/v1/partner/operator/orders/${id}/decline`).set(inOrg(op0.token, c.orgId)).send({ reason: 'Заболел' }).expect(204);
    expect(await status(id)).toBe('awaiting_assignment');
    await assign(c, id, 1);
    expect(await status(id)).toBe('assigned');
    const op1 = c.operators[1]!;
    await t.http().post(`/api/v1/partner/operator/orders/${id}/status-events`).set(inOrg(op1.token, c.orgId)).send({ events: [ev('en_route')] }).expect(200);
    await t.http().post(`/api/v1/partner/operator/orders/${id}/decline`).set(inOrg(op1.token, c.orgId)).send({ reason: 'Передумал' }).expect(409);
    const log = await pool.query('SELECT kind FROM order_assignments WHERE order_id = $1 ORDER BY created_at', [id]);
    expect(log.rows.map((r) => r.kind)).toEqual(['accepted', 'operator_assigned', 'operator_declined', 'operator_assigned']);
  });

  it('замена не найдена за 10 минут — общий поиск (Л-6, К-8)', async () => {
    const c = await company(7);
    const other = await company(16);
    const id = await order();
    await acceptAndPay(c, id);
    await assign(c, id);
    await t.http().post(`/api/v1/partner/operator/orders/${id}/decline`).set(inOrg(c.operators[0]!.token, c.orgId)).send({ reason: 'Не могу' }).expect(204);
    await fire('replacement_deadline', id);
    await jobs.runDue();
    expect((await pendingOffer(id))?.org_id).toBe(other.orgId);
  });

  it('машинист — не больше одного заказа в календарный день (Р-5)', async () => {
    const c = await company(5);
    const id1 = await order();
    await acceptAndPay(c, id1);
    await assign(c, id1);
    await pool.query("UPDATE equipment_units SET is_online = true WHERE id = $1", [c.unitId]);
    const second = await pool.query(
      `INSERT INTO equipment_units (org_id, category_id, brand, model, year, attributes, base_point, base_address, work_radius_km, is_online, verification_status, created_by)
       SELECT org_id, category_id, brand, '2', year, attributes, base_point, base_address, 150, true, 'approved', created_by FROM equipment_units WHERE id = $1 RETURNING id`, [c.unitId]);
    expect(second.rows[0].id).toBeTruthy();
    // Единственный машинист занят в этот день — компания не может взять второй заказ на ту же дату.
    const id2 = await order([{ date: mskDate(2), startTime: '08:00', hours: 4 }]);
    expect(await pendingOffer(id2)).toBeUndefined();
  });

  it('статусы без интернета: повторы игнорируются, порядок восстанавливается по времени телефона, после отмены — не применяются (Р-18, П-15)', async () => {
    const c = await company(5);
    const id = await order();
    await acceptAndPay(c, id);
    await assign(c, id);
    const op = c.operators[0]!;
    const e1 = ev('en_route', { recordedAt: new Date(Date.now() - 60_000).toISOString() });
    const e2 = ev('arrived');
    const res = await t.http().post(`/api/v1/partner/operator/orders/${id}/status-events`).set(inOrg(op.token, c.orgId)).send({ events: [e2, e1] }).expect(200);
    expect(res.body.results.map((r: { result: string }) => r.result)).toEqual(['applied', 'applied']);
    const dup = await t.http().post(`/api/v1/partner/operator/orders/${id}/status-events`).set(inOrg(op.token, c.orgId)).send({ events: [e1, e2] }).expect(200);
    expect(dup.body.results.map((r: { result: string }) => r.result)).toEqual(['duplicate', 'duplicate']);
    expect(await status(id)).toBe('arrived');

    await t.http().post(`/api/v1/client/orders/${id}/cancel`).set(bearer(customer.token)).send({}).expect(204);
    const late = await t.http().post(`/api/v1/partner/operator/orders/${id}/status-events`).set(inOrg(op.token, c.orgId)).send({ events: [ev('in_progress')] }).expect(200);
    expect(late.body.results[0].result).toBe('ignored');
  });

  it('замена техники: цена заказчика не меняется, доставка исполнителя пересчитывается (Р-3, Н-21)', async () => {
    const c = await company(5);
    const id = await order();
    await acceptAndPay(c, id);
    const before = await pool.query('SELECT total_kopecks, partner_delivery_kopecks FROM orders WHERE id = $1', [id]);
    const far = north(25);
    const spare = await pool.query(
      `INSERT INTO equipment_units (org_id, category_id, brand, model, year, attributes, base_point, base_address, work_radius_km, verification_status, created_by)
       VALUES ($1, $2, 'CAT', '301', 2022, '{"operating_weight": 3}', ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, 'Вторая база', 100, 'approved', $5) RETURNING id`,
      [c.orgId, catId, far.lng, far.lat, c.ownerUserId]);
    await t.http().post(`/api/v1/partner/orders/${id}/replace-unit`).set(inOrg(c.owner, c.orgId)).send({ unitId: spare.rows[0].id }).expect(204);
    const after = await pool.query('SELECT total_kopecks, partner_delivery_kopecks, equipment_unit_id FROM orders WHERE id = $1', [id]);
    expect(after.rows[0].total_kopecks).toBe(before.rows[0].total_kopecks);
    expect(Number(after.rows[0].partner_delivery_kopecks)).toBeGreaterThan(Number(before.rows[0].partner_delivery_kopecks));
    expect(after.rows[0].equipment_unit_id).toBe(spare.rows[0].id);
    const notice = await pool.query("SELECT count(*)::int AS n FROM domain_events WHERE order_id = $1 AND type = 'order.unit_changed'", [id]);
    expect(notice.rows[0].n).toBe(1);
  });

  it('отмена заказчиком: до оплаты бесплатно; после оплаты — на решение поддержки, деньги автоматически не возвращаются (07)', async () => {
    const c = await company(5);
    const free = await order();
    expect((await t.http().post(`/api/v1/client/orders/${free}/cancel/preview`).set(bearer(customer.token)).expect(200)).body).toEqual({ allowed: true, paidKopecks: 0, policy: 'free' });
    await t.http().post(`/api/v1/client/orders/${free}/cancel`).set(bearer(customer.token)).send({}).expect(204);
    expect(await status(free)).toBe('cancelled');
    expect(await pendingOffer(free)).toBeUndefined();
    expect((await pool.query('SELECT count(*)::int AS n FROM cancellation_reviews WHERE order_id = $1', [free])).rows[0].n).toBe(0);

    const paid = await order();
    await acceptAndPay(c, paid);
    const total = Number((await pool.query('SELECT total_kopecks FROM orders WHERE id = $1', [paid])).rows[0].total_kopecks);
    expect((await t.http().post(`/api/v1/client/orders/${paid}/cancel/preview`).set(bearer(customer.token)).expect(200)).body).toEqual({ allowed: true, paidKopecks: total, policy: 'support_review' });
    await t.http().post(`/api/v1/client/orders/${paid}/cancel`).set(bearer(customer.token)).send({ reason: 'Передумал' }).expect(204);
    const review = await pool.query('SELECT status, initiated_by, paid_kopecks FROM cancellation_reviews WHERE order_id = $1', [paid]);
    expect(review.rows[0]).toEqual({ status: 'pending', initiated_by: 'customer', paid_kopecks: String(total) });
    expect((await pool.query('SELECT count(*)::int AS n FROM refunds WHERE order_id = $1', [paid])).rows[0].n).toBe(0);
  });

  it('срок поиска истёк: без оплаты — «не найден», после оплаты — автоматический полный возврат (К-2, Н-29)', async () => {
    const a = await company(5);
    const id = await order();
    await fire('search_deadline', id);
    expect(await status(id)).toBe('search_failed');
    expect(await pendingOffer(id)).toBeUndefined();

    const id2 = await order();
    await acceptAndPay(a, id2);
    await t.http().post(`/api/v1/partner/orders/${id2}/release`).set(inOrg(a.owner, a.orgId)).send({ reason: 'Сломалась техника' }).expect(204);
    await jobs.runDue();
    await fire('search_deadline', id2);
    // Исполнитель не найден после оплаты — автоматический полный возврат (Н-29).
    await jobs.runDue();
    expect(await status(id2)).toBe('cancelled');
    const o2 = (await pool.query('SELECT paid_kopecks, refunded_kopecks FROM orders WHERE id = $1', [id2])).rows[0];
    expect(o2.refunded_kopecks).toBe(o2.paid_kopecks);
  });

  it('автозавершение через 24 часа; открытый спор его останавливает (Н-19)', async () => {
    const c = await company(5, { operators: 2 });
    const run = async (operatorIdx: number) => {
      const id = await order();
      await acceptAndPay(c, id);
      await assign(c, id, operatorIdx);
      await pool.query("UPDATE equipment_units SET is_online = true WHERE id = $1", [c.unitId]);
      await t.http().post(`/api/v1/partner/operator/orders/${id}/status-events`).set(inOrg(c.operators[operatorIdx]!.token, c.orgId))
        .send({ events: [ev('en_route'), ev('arrived'), ev('in_progress'), ev('finished')] }).expect(200);
      return id;
    };
    const auto = await run(0);
    await fire('auto_complete', auto);
    expect(await status(auto)).toBe('completed');
    expect((await pool.query('SELECT auto_completed FROM orders WHERE id = $1', [auto])).rows[0].auto_completed).toBe(true);

    await pool.query("UPDATE operator_day_assignments SET status = 'done'");
    const disputed = await run(1);
    await t.http().post(`/api/v1/client/orders/${disputed}/dispute`).set(bearer(customer.token)).send({ reason: 'Работы не выполнены' }).expect(204);
    await fire('auto_complete', disputed);
    expect(await status(disputed)).toBe('disputed');
  });

  it('машиниста с незавершённым заказом нельзя отвязать (Р-15, П-11)', async () => {
    const c = await company(5);
    const id = await order();
    await acceptAndPay(c, id);
    await assign(c, id);
    const res = await t.http().post(`/api/v1/partner/members/${c.operators[0]!.memberId}/detach`).set(inOrg(c.owner, c.orgId)).expect(409);
    expect(res.body.code).toBe('MEMBER_HAS_ACTIVE_ORDERS');
  });

  it('день длиннее 11 часов: две смены — нужны два машиниста (К-3)', async () => {
    await company(4, { operators: 1 });
    const two = await company(15, { operators: 2 });
    const id = await order([{ date: mskDate(3), startTime: '06:00', hours: 15 }]);
    expect((await pendingOffer(id))?.org_id).toBe(two.orgId);
    await acceptAndPay(two, id);
    await assign(two, id, 0);
    const shifts = await pool.query('SELECT id FROM order_shifts WHERE order_id = $1 ORDER BY seq', [id]);
    const sameOp = await t.http().post(`/api/v1/partner/orders/${id}/assign-operator`).set(inOrg(two.owner, two.orgId))
      .send({ memberId: two.operators[0]?.memberId, shiftId: shifts.rows[1].id }).expect(409);
    expect(sameOp.body.code).toBe('OPERATOR_BUSY');
    await t.http().post(`/api/v1/partner/orders/${id}/assign-operator`).set(inOrg(two.owner, two.orgId))
      .send({ memberId: two.operators[1]?.memberId, shiftId: shifts.rows[1].id }).expect(204);
  });

  it('после «Пропустить» заказ не предлагается другой технике той же компании в этом поиске (С-24)', async () => {
    const a = await company(5);
    const second = north(6);
    await pool.query(
      `INSERT INTO equipment_units (org_id, category_id, brand, model, year, attributes, base_point, base_address, work_radius_km, allow_beyond_radius, is_online, verification_status, created_by)
       VALUES ($1, $2, 'CAT', '2', 2021, '{"operating_weight": 3}', ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, 'База 2', 150, true, true, 'approved', $5)`,
      [a.orgId, catId, second.lng, second.lat, a.ownerUserId]);
    const b = await company(20);
    const id = await order();
    expect((await pendingOffer(id))?.org_id).toBe(a.orgId);
    await t.http().post(`/api/v1/partner/offers/${(await pendingOffer(id))?.id}/skip`).set(inOrg(a.owner, a.orgId)).expect(204);
    await jobs.runDue();
    expect((await pendingOffer(id))?.org_id).toBe(b.orgId);
  });

  it('многодневный заказ: техника занята весь период, включая ночи (М-2, С-22)', async () => {
    const c = await company(5, { operators: 2 });
    const id = await order([{ date: mskDate(3), startTime: '08:00', hours: 8 }, { date: mskDate(4), startTime: '08:00', hours: 8 }]);
    await acceptAndPay(c, id);
    const b = await pool.query("SELECT lower(period) AS s, upper(period) AS e FROM unit_bookings WHERE order_id = $1 AND status = 'active'", [id]);
    expect(b.rows).toHaveLength(1);
    const shifts = await pool.query('SELECT starts_at, ends_at FROM order_shifts WHERE order_id = $1 ORDER BY seq', [id]);
    expect(new Date(b.rows[0].s).toISOString()).toBe(new Date(shifts.rows[0].starts_at).toISOString());
    expect(new Date(b.rows[0].e).toISOString()).toBe(new Date(shifts.rows[1].ends_at).toISOString());
  });

  it('многодневный заказ: компания с одним машинистом получает заказ; не все дни назначены за 10 минут — уведомление, без возврата в поиск (С-28)', async () => {
    const c = await company(5, { operators: 1 });
    const id = await order([{ date: mskDate(3), startTime: '08:00', hours: 8 }, { date: mskDate(4), startTime: '08:00', hours: 8 }]);
    expect((await pendingOffer(id))?.org_id).toBe(c.orgId);
    await acceptAndPay(c, id);
    await assign(c, id, 0);
    expect(await status(id)).toBe('assigned');
    await fire('assignment_deadline', id);
    expect(await status(id)).toBe('assigned');
    const notice = await pool.query("SELECT payload FROM domain_events WHERE order_id = $1 AND type = 'order.shifts_unassigned'", [id]);
    expect(notice.rows).toHaveLength(1);
    expect(notice.rows[0].payload.admin).toBe(true);
    // Тот же машинист может работать и во второй день (на разные дни — свободный выбор).
    const shifts = await pool.query('SELECT id FROM order_shifts WHERE order_id = $1 ORDER BY seq', [id]);
    await t.http().post(`/api/v1/partner/orders/${id}/assign-operator`).set(inOrg(c.owner, c.orgId))
      .send({ memberId: c.operators[0]?.memberId, shiftId: shifts.rows[1].id }).expect(204);
  });

  it('чужая компания не видит заказ; заказчик видит только свои заказы', async () => {
    const a = await company(5);
    const b = await company(30);
    const id = await order();
    await acceptAndPay(a, id);
    await t.http().get(`/api/v1/partner/orders/${id}`).set(inOrg(b.owner, b.orgId)).expect(404);
    const other = await t.login(phone(), 'client');
    await t.http().get(`/api/v1/client/orders/${id}`).set(bearer(other.token)).expect(404);
  });
});
