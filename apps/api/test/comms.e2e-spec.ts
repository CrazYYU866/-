import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { io, type Socket } from 'socket.io-client';
import { createApp } from '../src/app.factory';
import { NotificationsService } from '../src/comms/notifications.service';
import { DevPushProvider, PUSH_PROVIDER } from '../src/comms/push.provider';
import { RetentionService } from '../src/comms/retention.service';
import { JobsService } from '../src/jobs/jobs.service';
import { REDIS } from '../src/redis/redis.module';
import { resetTestDatabase } from './db';
import { innLegal, ogrnLegal, TestClient } from './helpers';

const ZONE = { type: 'Polygon', coordinates: [[[36.8, 55.1], [38.5, 55.1], [38.5, 56.4], [36.8, 56.4], [36.8, 55.1]]] };
const SITE = { lat: 55.7558, lng: 37.6173, address: 'Москва, Красная площадь' };
const north = (km: number) => ({ lat: SITE.lat + km / 111.2, lng: SITE.lng });
const south = (km: number) => ({ lat: SITE.lat - km / 111.2, lng: SITE.lng });
const mskDate = (days: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date(Date.now() + days * 86_400_000));

describe('Этап 8: уведомления, чат, звонки, GPS, оценки', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;
  let t: TestClient;
  let jobs: JobsService;
  let notifications: NotificationsService;
  let port: number;
  let catId: string;
  let seq = 0;
  let innSeq = 18000;
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const inOrg = (token: string, orgId: string) => ({ ...bearer(token), 'X-Org-Id': orgId });
  const phone = () => `+7916900${String(++seq).padStart(4, '0')}`;
  const ev = (status: string) => ({ clientEventId: randomUUID(), status, recordedAt: new Date().toISOString() });

  interface World { orgId: string; owner: string; ownerId: string; dispatcher: string; opToken: string; opUserId: string; opMember: string }

  async function partner(at = north(10)): Promise<World> {
    const owner = await t.login(phone());
    const o = (await t.http().post('/api/v1/partner/organizations').set(bearer(owner.token)).send({
      kind: 'partner', legalForm: 'llc', name: `ООО Связь ${innSeq}`, representativeName: 'Иванов И.И.', inn: innLegal(innSeq), ogrn: ogrnLegal(innSeq++),
      legalAddress: 'Москва, 1', email: 'a@b.ru', contactPhone: '+79160000099',
    }).expect(201)).body;
    await pool.query("UPDATE organizations SET status = 'verified' WHERE id = $1", [o.id]);
    await pool.query(
      `INSERT INTO equipment_units (org_id, category_id, brand, model, year, attributes, base_point, base_address, work_radius_km, allow_beyond_radius, is_online, verification_status, created_by)
       VALUES ($1, $2, 'JCB', '8030', 2021, '{"operating_weight": 3}', ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, 'Москва, база', 150, true, true, 'approved', $5)`,
      [o.id, catId, at.lng, at.lat, owner.userId]);
    const join = async (role: string) => {
      const p = phone();
      await t.http().post('/api/v1/partner/members').set(inOrg(owner.token, o.id)).send({ phone: p, role, fullName: `Сотрудник ${p.slice(-4)}` }).expect(201);
      const u = await t.login(p);
      const inv = (await t.http().get('/api/v1/partner/invitations').set(bearer(u.token))).body;
      await t.http().post(`/api/v1/partner/invitations/${inv[0].memberId}/accept`).set(bearer(u.token)).expect(204);
      return { ...u, memberId: inv[0].memberId as string };
    };
    const d = await join('dispatcher');
    const op = await join('operator');
    await pool.query("UPDATE organization_members SET operator_verification = 'approved' WHERE id = $1", [op.memberId]);
    await redis.flushdb();
    return { orgId: o.id, owner: owner.token, ownerId: owner.userId, dispatcher: d.token, opToken: op.token, opUserId: op.userId, opMember: op.memberId };
  }

  async function assignedOrder(w: World, customerToken: string): Promise<string> {
    const q = await t.http().post('/api/v1/client/quotes').set(bearer(customerToken)).send({ categoryId: catId, site: SITE, days: [{ date: mskDate(2), startTime: '08:00', hours: 8 }] }).expect(201);
    const id = (await t.http().post('/api/v1/client/orders').set(bearer(customerToken)).send({ quoteId: q.body.id }).expect(201)).body.id as string;
    await jobs.runDue();
    const offer = (await pool.query("SELECT id FROM order_offers WHERE order_id = $1 AND status = 'pending'", [id])).rows[0];
    await t.http().post(`/api/v1/partner/offers/${offer.id}/accept`).set(inOrg(w.owner, w.orgId)).expect(204);
    const pay = await t.http().post(`/api/v1/client/orders/${id}/payments`).set(bearer(customerToken)).expect(201);
    await t.http().post(`/api/v1/dev/payments/${String(pay.body.confirmationUrl).split('/').pop()}/succeed`).expect(200);
    await t.http().post(`/api/v1/partner/orders/${id}/assign-operator`).set(inOrg(w.owner, w.orgId)).send({ memberId: w.opMember }).expect(204);
    return id;
  }

  const status = (w: World, id: string, statuses: string[]) =>
    t.http().post(`/api/v1/partner/operator/orders/${id}/status-events`).set(inOrg(w.opToken, w.orgId)).send({ events: statuses.map(ev) }).expect(200);

  beforeAll(async () => {
    pool = await resetTestDatabase();
    app = await createApp();
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
    redis = app.get(REDIS);
    jobs = app.get(JobsService);
    notifications = app.get(NotificationsService);
    t = new TestClient(app);
    const moscow = (await pool.query("SELECT id FROM regions WHERE code = 'moscow'")).rows[0].id;
    catId = (await pool.query("SELECT id FROM equipment_categories WHERE slug = 'mini_excavator'")).rows[0].id;
    await pool.query("INSERT INTO service_zones (region_id, name, area) VALUES ($1, 'тест', ST_Multi(ST_GeomFromGeoJSON($2))::geography)", [moscow, JSON.stringify(ZONE)]);
    await pool.query("INSERT INTO tariffs (category_id, region_id, kind, price_kopecks, valid_from) VALUES ($1, $2, 'delivery_km', 10000, now() - interval '1 day')", [catId, moscow]);
  });
  beforeEach(async () => {
    await redis.flushdb();
    await pool.query("UPDATE scheduled_jobs SET status = 'cancelled' WHERE status = 'pending'; UPDATE equipment_units SET is_online = false;");
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('уведомления: заказчику — о найденном исполнителе и оплате; исполнителю — о новом заказе, но не об оплате (ТЗ §16)', async () => {
    const w = await partner();
    const c = await t.login(phone(), 'client');
    await t.http().post('/api/v1/me/push-devices').set(bearer(c.token)).send({ platform: 'ios', token: 'expo-token-customer-0001' }).expect(204);
    await assignedOrder(w, c.token);
    await notifications.processPending();
    const mine = await t.http().get('/api/v1/notifications').set(bearer(c.token)).expect(200);
    const types = mine.body.items.map((n: { type: string }) => n.type);
    expect(types).toEqual(expect.arrayContaining(['order.created', 'order.partner_found', 'payment.succeeded', 'order.operator_assigned_customer']));
    expect(mine.body.unread).toBeGreaterThanOrEqual(4);
    const owner = await t.http().get('/api/v1/notifications').set(bearer(w.owner)).expect(200);
    const ownerTypes = owner.body.items.map((n: { type: string }) => n.type);
    expect(ownerTypes).toContain('offer.new');
    expect(ownerTypes.some((x: string) => x.startsWith('payment') || x === 'order.prepaid')).toBe(false);
    const push = app.get<DevPushProvider>(PUSH_PROVIDER);
    expect(push.sent.some((p) => p.tokens.includes('expo-token-customer-0001') && p.title === 'Исполнитель найден')).toBe(true);
    await t.http().post('/api/v1/notifications/read').set(bearer(c.token)).send({ all: true }).expect(204);
    expect((await t.http().get('/api/v1/notifications').set(bearer(c.token))).body.unread).toBe(0);
  });

  it('чат: заказчик пишет машинисту, диспетчер видит; внутренний канал заказчику недоступен; посторонним — нет (П-14)', async () => {
    const w = await partner();
    const c = await t.login(phone(), 'client');
    const id = await assignedOrder(w, c.token);
    await t.http().post(`/api/v1/client/orders/${id}/chat`).set(bearer(c.token)).send({ body: 'Подъезд со стороны склада' }).expect(201);
    await t.http().post(`/api/v1/partner/operator/orders/${id}/chat`).set(bearer(w.opToken)).send({ body: 'Понял, буду в 8:00' }).expect(201);
    await t.http().post(`/api/v1/partner/orders/${id}/chat?channel=internal`).set(bearer(w.dispatcher)).send({ body: 'Возьми ковш 600' }).expect(201);

    const dispView = await t.http().get(`/api/v1/partner/orders/${id}/chat`).set(bearer(w.dispatcher)).expect(200);
    expect(dispView.body.map((m: { sender_role: string; body: string }) => [m.sender_role, m.body])).toEqual([['customer', 'Подъезд со стороны склада'], ['operator', 'Понял, буду в 8:00']]);
    const internal = await t.http().get(`/api/v1/partner/operator/orders/${id}/chat?channel=internal`).set(bearer(w.opToken)).expect(200);
    expect(internal.body.map((m: { body: string }) => m.body)).toEqual(['Возьми ковш 600']);
    const custView = await t.http().get(`/api/v1/client/orders/${id}/chat?channel=internal`).set(bearer(c.token)).expect(200);
    expect(custView.body.some((m: { body: string }) => m.body === 'Возьми ковш 600')).toBe(false);

    const stranger = await t.login(phone(), 'client');
    await t.http().get(`/api/v1/client/orders/${id}/chat`).set(bearer(stranger.token)).expect(404);
    const support = await t.adminLogin('sup@comms.test', 'support');
    await t.http().get(`/api/v1/admin/orders/${id}/chat`).set(bearer(support)).expect(200);
    expect((await pool.query("SELECT count(*)::int AS n FROM admin_audit_log WHERE action = 'chat.view' AND entity_id = $1", [id])).rows[0].n).toBe(1);
  });

  it('WebSocket: участник заказа получает сообщение чата мгновенно; посторонний не может подписаться', async () => {
    const w = await partner();
    const c = await t.login(phone(), 'client');
    const id = await assignedOrder(w, c.token);
    const connect = (token: string) => new Promise<Socket>((resolve, reject) => {
      const s = io(`http://127.0.0.1:${port}/ws`, { auth: { token }, transports: ['websocket'], forceNew: true });
      s.on('connect', () => resolve(s));
      s.on('connect_error', reject);
    });
    const op = await connect(w.opToken);
    const sub = await op.emitWithAck('subscribe_order', { orderId: id });
    expect(sub).toEqual({ ok: true });
    const got = new Promise<{ body: string }>((resolve) => op.on('chat.message', resolve));
    await t.http().post(`/api/v1/client/orders/${id}/chat`).set(bearer(c.token)).send({ body: 'Где вы?' }).expect(201);
    expect((await got).body).toBe('Где вы?');
    const stranger = await connect((await t.login(phone(), 'client')).token);
    expect(await stranger.emitWithAck('subscribe_order', { orderId: id })).toEqual({ ok: false });
    op.disconnect();
    stranger.disconnect();
  });

  it('звонки через подменный номер: до выезда — диспетчеру, после — машинисту; реальный номер не раскрывается', async () => {
    const w = await partner();
    const c = await t.login(phone(), 'client');
    const id = await assignedOrder(w, c.token);
    const before = await t.http().post(`/api/v1/client/orders/${id}/call`).set(bearer(c.token)).expect(201);
    expect(before.body.calleeRole).toBe('dispatcher');
    expect(JSON.stringify(before.body)).not.toMatch(/\+79169/);
    await status(w, id, ['en_route']);
    const after = await t.http().post(`/api/v1/client/orders/${id}/call`).set(bearer(c.token)).expect(201);
    expect(after.body.calleeRole).toBe('operator');
    const back = await t.http().post(`/api/v1/partner/operator/orders/${id}/call`).set(bearer(w.opToken)).expect(201);
    expect(back.body.calleeRole).toBe('customer');
    const sessions = await pool.query('SELECT callee_user_id FROM call_sessions WHERE order_id = $1 ORDER BY created_at', [id]);
    expect(sessions.rows[1].callee_user_id).toBe(w.opUserId);
  });

  it('GPS: до выезда — место стоянки и маршрут, без телефона; после выезда — живые координаты и ETA; без связи — без ETA; после прибытия — движение не показывается (П-1, П-2, Р-19–21)', async () => {
    const w = await partner();
    const c = await t.login(phone(), 'client');
    const id = await assignedOrder(w, c.token);
    const pre = await t.http().get(`/api/v1/client/orders/${id}/tracking`).set(bearer(c.token)).expect(200);
    expect(pre.body).toMatchObject({ mode: 'base', base: { label: 'Место стоянки (по данным компании)', address: 'Москва, база' } });
    expect(pre.body.route.durationMin).toBeGreaterThan(0);
    const early = await t.http().post('/api/v1/partner/operator/locations').set(inOrg(w.opToken, w.orgId))
      .send({ orderId: id, points: [{ ...north(9), recordedAt: new Date().toISOString() }] }).expect(409);
    expect(early.body.code).toBe('TRACKING_NOT_ACTIVE');

    await status(w, id, ['en_route']);
    const now = Date.now();
    await t.http().post('/api/v1/partner/operator/locations').set(inOrg(w.opToken, w.orgId)).send({ orderId: id, points: [
      { ...north(9), accuracy: 10, recordedAt: new Date(now - 60_000).toISOString() },
      { ...north(6), accuracy: 10, recordedAt: new Date(now - 1000).toISOString() },
    ] }).expect(200);
    const live = await t.http().get(`/api/v1/client/orders/${id}/tracking`).set(bearer(c.token)).expect(200);
    expect(live.body).toMatchObject({ mode: 'live', stale: false });
    expect(live.body.position.lat).toBeCloseTo(north(6).lat, 5);
    expect(live.body.traveledKm).toBeCloseTo(3, 0);
    expect(live.body.etaMin).toBeGreaterThan(0);

    await pool.query("UPDATE location_pings SET recorded_at = recorded_at - interval '10 minutes' WHERE order_id = $1", [id]);
    const stale = await t.http().get(`/api/v1/client/orders/${id}/tracking`).set(bearer(c.token)).expect(200);
    expect(stale.body).toMatchObject({ stale: true, etaMin: null, remainingKm: null });
    expect(stale.body.message).toMatch(/Нет связи с техникой/);

    await status(w, id, ['arrived']);
    await t.http().post('/api/v1/partner/operator/locations').set(inOrg(w.opToken, w.orgId)).send({ orderId: id, points: [{ ...SITE, recordedAt: new Date().toISOString() }] }).expect(200);
    const onSite = await t.http().get(`/api/v1/client/orders/${id}/tracking`).set(bearer(c.token)).expect(200);
    expect(onSite.body).toEqual({ mode: 'on_site', site: { lat: SITE.lat, lng: SITE.lng } });
    expect((await pool.query("SELECT count(*)::int AS n FROM location_pings WHERE order_id = $1 AND phase = 'on_site'", [id])).rows[0].n).toBe(1);

    await status(w, id, ['in_progress', 'finished']);
    await t.http().post('/api/v1/partner/operator/locations').set(inOrg(w.opToken, w.orgId)).send({ orderId: id, points: [{ ...SITE, recordedAt: new Date().toISOString() }] }).expect(409);
  });

  it('оценки: после завершения; заказчик — машиниста, исполнитель — заказчика; жалоба и скрытие администратором (В-29, В-30)', async () => {
    const w = await partner();
    const c = await t.login(phone(), 'client');
    const id = await assignedOrder(w, c.token);
    await t.http().post(`/api/v1/client/orders/${id}/ratings`).set(bearer(c.token)).send({ stars: 5 }).expect(409);
    await status(w, id, ['en_route', 'arrived', 'in_progress', 'finished']);
    await t.http().post(`/api/v1/client/orders/${id}/confirm-completion`).set(bearer(c.token)).expect(204);

    const r = await t.http().post(`/api/v1/client/orders/${id}/ratings`).set(bearer(c.token)).send({ stars: 4, text: 'Всё хорошо' }).expect(201);
    await t.http().post(`/api/v1/client/orders/${id}/ratings`).set(bearer(c.token)).send({ stars: 5 }).expect(409);
    await t.http().post(`/api/v1/partner/operator/orders/${id}/ratings`).set(bearer(w.opToken)).send({ stars: 5, text: 'Вежливый заказчик' }).expect(201);
    const view = await t.http().get(`/api/v1/client/orders/${id}`).set(bearer(c.token)).expect(200);
    expect(view.body.shifts[0].operator.rating).toBe(4);
    const list = await t.http().get(`/api/v1/partner/orders/${id}/ratings`).set(bearer(w.dispatcher)).expect(200);
    expect(list.body).toHaveLength(2);
    const stranger = await t.login(phone(), 'client');
    await t.http().get(`/api/v1/client/orders/${id}/ratings`).set(bearer(stranger.token)).expect(404);

    await t.http().post(`/api/v1/ratings/${r.body.id}/complaint`).set(bearer(w.opToken)).send({ reason: 'Несправедливо' }).expect(201);
    const moderator = await t.adminLogin('mod@comms.test', 'moderator');
    const complaints = await t.http().get('/api/v1/admin/rating-complaints').set(bearer(moderator)).expect(200);
    expect(complaints.body.map((x: { rating_id: string }) => x.rating_id)).toContain(r.body.id);
    await t.http().post(`/api/v1/admin/ratings/${r.body.id}/hide`).set(bearer(moderator)).send({ reason: 'Оценка не по делу' }).expect(200);
    expect((await t.http().get(`/api/v1/client/orders/${id}`).set(bearer(c.token))).body.shifts[0].operator.rating).toBeNull();
  });

  it('рейтинг машинистов учитывается в подборе (В-7, К-5)', async () => {
    const low = await partner(north(10));
    const high = await partner(south(10));
    const c = await t.login(phone(), 'client');
    await pool.query('UPDATE equipment_units SET is_online = (org_id = $1)', [low.orgId]);
    const fakeOrder = await assignedOrder(low, c.token);
    await pool.query("INSERT INTO ratings (order_id, author_user_id, author_side, target_user_id, target_kind, stars) VALUES ($1, $2, 'customer', $3, 'operator', 1)", [fakeOrder, (await pool.query('SELECT customer_id FROM orders WHERE id = $1', [fakeOrder])).rows[0].customer_id, low.opUserId]);
    const highOrderCustomer = await t.login(phone(), 'client');
    await pool.query("INSERT INTO ratings (order_id, author_user_id, author_side, target_user_id, target_kind, stars) VALUES ($1, $2, 'customer', $3, 'operator', 5)", [fakeOrder, highOrderCustomer.userId, high.opUserId]);
    await pool.query('UPDATE equipment_units SET is_online = true WHERE org_id IN ($1, $2)', [low.orgId, high.orgId]);
    const q = await t.http().post('/api/v1/client/quotes').set(bearer(c.token)).send({ categoryId: catId, site: SITE, days: [{ date: mskDate(3), startTime: '08:00', hours: 8 }] }).expect(201);
    const id = (await t.http().post('/api/v1/client/orders').set(bearer(c.token)).send({ quoteId: q.body.id }).expect(201)).body.id;
    await jobs.runDue();
    const offer = (await pool.query("SELECT org_id, score_details FROM order_offers WHERE order_id = $1 AND status = 'pending'", [id])).rows[0];
    expect(offer.org_id).toBe(high.orgId);
    expect(offer.score_details.rating).toBe(1);
  });

  it('сроки хранения: GPS — 48 часов после завершения; переписка — 180 дней, кроме заказов со спором (П-16, В-27)', async () => {
    const w = await partner();
    const c = await t.login(phone(), 'client');
    const id = await assignedOrder(w, c.token);
    await status(w, id, ['en_route']);
    await t.http().post('/api/v1/partner/operator/locations').set(inOrg(w.opToken, w.orgId)).send({ orderId: id, points: [{ ...north(5), recordedAt: new Date().toISOString() }] }).expect(200);
    await t.http().post(`/api/v1/client/orders/${id}/chat`).set(bearer(c.token)).send({ body: 'старое сообщение' }).expect(201);
    await status(w, id, ['arrived', 'in_progress', 'finished']);
    await t.http().post(`/api/v1/client/orders/${id}/confirm-completion`).set(bearer(c.token)).expect(204);
    const retention = app.get(RetentionService);
    await retention.cleanup();
    expect((await pool.query('SELECT count(*)::int AS n FROM location_pings WHERE order_id = $1', [id])).rows[0].n).toBe(1);
    await pool.query("UPDATE orders SET completed_at = now() - interval '49 hours' WHERE id = $1", [id]);
    await pool.query("UPDATE chat_messages SET created_at = now() - interval '181 days' WHERE order_id = $1", [id]);
    const res = await retention.cleanup();
    expect(res.gps).toBeGreaterThanOrEqual(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM location_pings WHERE order_id = $1', [id])).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM chat_messages WHERE order_id = $1', [id])).rows[0].n).toBe(0);
  });

  it('при споре GPS-трек хранится до закрытия спора, затем удаляется по общему правилу (решение по С-31)', async () => {
    const w = await partner();
    const c = await t.login(phone(), 'client');
    const id = await assignedOrder(w, c.token);
    await status(w, id, ['en_route']);
    await t.http().post('/api/v1/partner/operator/locations').set(inOrg(w.opToken, w.orgId)).send({ orderId: id, points: [{ ...north(5), recordedAt: new Date().toISOString() }] }).expect(200);
    await status(w, id, ['arrived', 'in_progress', 'finished']);
    await t.http().post(`/api/v1/client/orders/${id}/dispute`).set(bearer(c.token)).send({ reason: 'Работа выполнена не полностью' }).expect(204);
    const retention = app.get(RetentionService);
    await pool.query("UPDATE orders SET completed_at = now() - interval '10 days' WHERE id = $1", [id]);
    await retention.cleanup();
    expect((await pool.query('SELECT count(*)::int AS n FROM location_pings WHERE order_id = $1', [id])).rows[0].n).toBe(1);
    // Спор закрыт (заказ завершён) — трек больше не нужен.
    await pool.query("UPDATE orders SET status = 'completed' WHERE id = $1", [id]);
    await retention.cleanup();
    expect((await pool.query('SELECT count(*)::int AS n FROM location_pings WHERE order_id = $1', [id])).rows[0].n).toBe(0);
  });
});
