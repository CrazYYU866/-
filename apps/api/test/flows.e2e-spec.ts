import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { createApp } from '../src/app.factory';
import { DevSmsProvider } from '../src/auth/sms/dev-sms.provider';
import { SMS_PROVIDER } from '../src/auth/sms/sms.provider';
import { JobsService } from '../src/jobs/jobs.service';
import { REDIS } from '../src/redis/redis.module';
import { resetTestDatabase } from './db';
import { innLegal, ogrnLegal, TestClient } from './helpers';

const ZONE = { type: 'Polygon', coordinates: [[[36.8, 55.1], [38.5, 55.1], [38.5, 56.4], [36.8, 56.4], [36.8, 55.1]]] };
const SITE = { lat: 55.7558, lng: 37.6173, address: 'Москва, Красная площадь' };
const north = (km: number) => ({ lat: SITE.lat + km / 111.2, lng: SITE.lng });
const mskDate = (days: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date(Date.now() + days * 86_400_000));
const DAY = () => [{ date: mskDate(2), startTime: '08:00', hours: 8 }];

describe('Н-27…Н-30: организации заказчиков, автовозврат, продление, заказ диспетчера по ссылке', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;
  let t: TestClient;
  let jobs: JobsService;
  let catId: string;
  let seq = 0;
  let innSeq = 12000;
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const inOrg = (token: string, orgId: string) => ({ ...bearer(token), 'X-Org-Id': orgId });
  const phone = () => `+7916700${String(++seq).padStart(4, '0')}`;

  async function org(kind: 'partner' | 'agent') {
    const owner = await t.login(phone());
    const o = (await t.http().post('/api/v1/partner/organizations').set(bearer(owner.token)).send({
      kind, legalForm: 'llc', name: `ООО ${kind} ${innSeq}`, representativeName: 'Иванов И.И.', inn: innLegal(innSeq), ogrn: ogrnLegal(innSeq++),
      legalAddress: 'Москва, 1', email: 'a@b.ru', contactPhone: '+79160000099',
    }).expect(201)).body;
    await pool.query("UPDATE organizations SET status = 'verified' WHERE id = $1", [o.id]);
    return { orgId: o.id as string, owner: owner.token, ownerId: owner.userId };
  }

  async function partner(km = 10) {
    const p = await org('partner');
    const base = north(km);
    await pool.query(
      `INSERT INTO equipment_units (org_id, category_id, brand, model, year, attributes, base_point, base_address, work_radius_km, allow_beyond_radius, is_online, verification_status, created_by)
       VALUES ($1, $2, 'JCB', '8030', 2021, '{"operating_weight": 3}', ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, 'База', 150, true, true, 'approved', $5)`,
      [p.orgId, catId, base.lng, base.lat, p.ownerId]);
    const opPhone = phone();
    await t.http().post('/api/v1/partner/members').set(inOrg(p.owner, p.orgId)).send({ phone: opPhone, role: 'operator' }).expect(201);
    const op = await t.login(opPhone);
    const inv = (await t.http().get('/api/v1/partner/invitations').set(bearer(op.token))).body;
    await t.http().post(`/api/v1/partner/invitations/${inv[0].memberId}/accept`).set(bearer(op.token)).expect(204);
    await pool.query("UPDATE organization_members SET operator_verification = 'approved' WHERE id = $1", [inv[0].memberId]);
    await redis.flushdb();
    return { ...p, opToken: op.token, opMember: inv[0].memberId as string };
  }

  const offerOf = async (orderId: string) => (await pool.query("SELECT id, org_id FROM order_offers WHERE order_id = $1 AND status = 'pending'", [orderId])).rows[0];
  const order = async (id: string) => (await pool.query('SELECT * FROM orders WHERE id = $1', [id])).rows[0];
  const ev = (status: string) => ({ clientEventId: randomUUID(), status, recordedAt: new Date().toISOString() });
  const devPay = async (confirmationUrl: string) => t.http().post(`/api/v1/dev/payments/${confirmationUrl.split('/').pop()}/succeed`).expect(200);

  async function clientOrder(token: string, payer: Record<string, unknown> = { kind: 'individual' }) {
    const q = await t.http().post('/api/v1/client/quotes').set(bearer(token)).send({ categoryId: catId, site: SITE, days: DAY() }).expect(201);
    const o = await t.http().post('/api/v1/client/orders').set(bearer(token)).send({ quoteId: q.body.id, payer }).expect(201);
    await jobs.runDue();
    return o.body.id as string;
  }

  beforeAll(async () => {
    pool = await resetTestDatabase();
    app = await createApp();
    await app.init();
    redis = app.get(REDIS);
    jobs = app.get(JobsService);
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

  it('организация заказчика: руководитель приглашает сотрудника; чужую организацию по ИНН не привязать (Н-30)', async () => {
    await partner();
    const boss = await t.login(phone(), 'client');
    const inn = innLegal(innSeq++);
    const created = await t.http().post('/api/v1/client/organizations').set(bearer(boss.token)).send({ inn, name: 'ООО Стройка', legalAddress: 'Москва, 5', email: 'buh@stroy.ru' }).expect(201);
    const stranger = await t.login(phone(), 'client');
    const dup = await t.http().post('/api/v1/client/organizations').set(bearer(stranger.token)).send({ inn, name: 'Подмена', legalAddress: 'Москва, 6', email: 'x@x.ru' }).expect(409);
    expect(dup.body.code).toBe('CUSTOMER_ORG_EXISTS');
    const q = await t.http().post('/api/v1/client/quotes').set(bearer(stranger.token)).send({ categoryId: catId, site: SITE, days: DAY() }).expect(201);
    await t.http().post('/api/v1/client/orders').set(bearer(stranger.token)).send({ quoteId: q.body.id, payer: { kind: 'legal', legalProfileId: created.body.id } }).expect(404);

    const empPhone = phone();
    await t.http().post(`/api/v1/client/organizations/${created.body.id}/members`).set(bearer(boss.token)).send({ phone: empPhone }).expect(201);
    const emp = await t.login(empPhone, 'client');
    await t.http().post(`/api/v1/client/organizations/${created.body.id}/members`).set(bearer(emp.token)).send({ phone: phone() }).expect(404);
    const inv = (await t.http().get('/api/v1/client/organization-invitations').set(bearer(emp.token))).body;
    await t.http().post(`/api/v1/client/organization-invitations/${inv[0].id}/accept`).set(bearer(emp.token)).expect(204);
    const orgs = (await t.http().get('/api/v1/client/organizations').set(bearer(emp.token))).body;
    expect(orgs).toEqual([expect.objectContaining({ id: created.body.id, role: 'employee' })]);
    const id = await clientOrder(emp.token, { kind: 'legal', legalProfileId: created.body.id });
    const o = await order(id);
    expect(o.payer_kind).toBe('legal');
    expect(Number(o.prepayment_kopecks)).toBe(Math.round(Number(o.total_kopecks) / 2 / 100) * 100);
  });

  it('исполнитель не найден после оплаты — автоматический возврат 100% без поддержки (Н-29)', async () => {
    const p = await partner();
    const c = await t.login(phone(), 'client');
    const id = await clientOrder(c.token);
    await t.http().post(`/api/v1/partner/offers/${(await offerOf(id)).id}/accept`).set(inOrg(p.owner, p.orgId)).expect(204);
    const pay = await t.http().post(`/api/v1/client/orders/${id}/payments`).set(bearer(c.token)).expect(201);
    await devPay(pay.body.confirmationUrl);
    await t.http().post(`/api/v1/partner/orders/${id}/release`).set(inOrg(p.owner, p.orgId)).send({ reason: 'Поломка' }).expect(204);
    await jobs.runDue();
    await pool.query("UPDATE scheduled_jobs SET run_at = now() - interval '1 second' WHERE status = 'pending' AND type = 'search_deadline' AND payload->>'orderId' = $1", [id]);
    await jobs.runDue();
    await jobs.runDue();
    const o = await order(id);
    expect(o.status).toBe('cancelled');
    expect(Number(o.refunded_kopecks)).toBe(Number(o.paid_kopecks));
    expect((await pool.query('SELECT count(*)::int AS n FROM cancellation_reviews WHERE order_id = $1', [id])).rows[0].n).toBe(0);
    expect(Number((await pool.query('SELECT COALESCE(sum(amount_kopecks), 0) AS s FROM ledger_entries WHERE account = $1', [`customer:${id}`])).rows[0].s)).toBe(0);
  });

  it('продление физлица: работа продолжается сразу, доплата выставляется; оплатил — заказ завершён, комиссия от полной суммы (Н-28)', async () => {
    const p = await partner();
    const c = await t.login(phone(), 'client');
    const id = await clientOrder(c.token);
    await t.http().post(`/api/v1/partner/offers/${(await offerOf(id)).id}/accept`).set(inOrg(p.owner, p.orgId)).expect(204);
    await devPay((await t.http().post(`/api/v1/client/orders/${id}/payments`).set(bearer(c.token)).expect(201)).body.confirmationUrl);
    await t.http().post(`/api/v1/partner/orders/${id}/assign-operator`).set(inOrg(p.owner, p.orgId)).send({ memberId: p.opMember }).expect(204);
    await t.http().post(`/api/v1/partner/operator/orders/${id}/extensions`).set(inOrg(p.opToken, p.orgId)).send({ hours: 2 }).expect(409);
    await t.http().post(`/api/v1/partner/operator/orders/${id}/status-events`).set(inOrg(p.opToken, p.orgId)).send({ events: [ev('en_route'), ev('arrived'), ev('in_progress')] }).expect(200);
    const ext = await t.http().post(`/api/v1/partner/operator/orders/${id}/extensions`).set(inOrg(p.opToken, p.orgId)).send({ hours: 2 }).expect(201);
    expect(ext.body.amountKopecks).toBe(2 * 250000);
    await t.http().post(`/api/v1/client/orders/${id}/extensions/${ext.body.id}/approve`).set(bearer(c.token)).expect(204);

    const booking = await pool.query("SELECT upper(period) AS e FROM unit_bookings WHERE order_id = $1 AND status = 'active'", [id]);
    const shift = await pool.query('SELECT ends_at, hours FROM order_shifts WHERE order_id = $1', [id]);
    expect(new Date(booking.rows[0].e).toISOString()).toBe(new Date(shift.rows[0].ends_at).toISOString());
    expect(shift.rows[0].hours).toBe(10);
    expect((await order(id)).status).toBe('in_progress');

    const extraPay = await t.http().post(`/api/v1/client/orders/${id}/payments`).set(bearer(c.token)).expect(201);
    expect(extraPay.body).toMatchObject({ part: 'extra', amountKopecks: 500000 });
    await devPay(extraPay.body.confirmationUrl);
    await t.http().post(`/api/v1/partner/operator/orders/${id}/status-events`).set(inOrg(p.opToken, p.orgId)).send({ events: [ev('finished')] }).expect(200);
    await t.http().post(`/api/v1/client/orders/${id}/confirm-completion`).set(bearer(c.token)).expect(204);
    const o = await order(id);
    expect(o.status).toBe('completed');
    const full = Number(o.total_kopecks) + 500000;
    expect(Number(o.commission_kopecks)).toBe(Math.round(full * 0.12));
  });

  it('продление не оплачено — после завершения долг (Н-28, К-9)', async () => {
    const p = await partner();
    const c = await t.login(phone(), 'client');
    const id = await clientOrder(c.token);
    await t.http().post(`/api/v1/partner/offers/${(await offerOf(id)).id}/accept`).set(inOrg(p.owner, p.orgId)).expect(204);
    await devPay((await t.http().post(`/api/v1/client/orders/${id}/payments`).set(bearer(c.token)).expect(201)).body.confirmationUrl);
    await t.http().post(`/api/v1/partner/orders/${id}/assign-operator`).set(inOrg(p.owner, p.orgId)).send({ memberId: p.opMember }).expect(204);
    await t.http().post(`/api/v1/partner/operator/orders/${id}/status-events`).set(inOrg(p.opToken, p.orgId)).send({ events: [ev('en_route'), ev('arrived'), ev('in_progress')] }).expect(200);
    const ext = await t.http().post(`/api/v1/partner/operator/orders/${id}/extensions`).set(inOrg(p.opToken, p.orgId)).send({ hours: 1 }).expect(201);
    await t.http().post(`/api/v1/client/orders/${id}/extensions/${ext.body.id}/approve`).set(bearer(c.token)).expect(204);
    await t.http().post(`/api/v1/partner/operator/orders/${id}/status-events`).set(inOrg(p.opToken, p.orgId)).send({ events: [ev('finished')] }).expect(200);
    await t.http().post(`/api/v1/client/orders/${id}/confirm-completion`).set(bearer(c.token)).expect(204);
    expect((await order(id)).status).toBe('awaiting_final_payment');
    await pool.query("UPDATE scheduled_jobs SET run_at = now() - interval '1 second' WHERE status = 'pending' AND type = 'final_payment_deadline'");
    await jobs.runDue();
    expect((await pool.query('SELECT amount_kopecks FROM customer_debts WHERE order_id = $1', [id])).rows[0].amount_kopecks).toBe('250000');
  });

  it('заказ независимого диспетчера: SMS-ссылка → подтверждение заказчиком → поиск; платит заказчик; диспетчеру 7% (Н-27)', async () => {
    const p = await partner();
    const agent = await org('agent');
    const custPhone = phone();
    const q = await t.http().post('/api/v1/partner/agent/quotes').set(inOrg(agent.owner, agent.orgId))
      .send({ customerPhone: custPhone, categoryId: catId, site: SITE, days: DAY() }).expect(201);
    // Обычная компания-исполнитель не может оформлять заявки как диспетчер.
    await t.http().post('/api/v1/partner/agent/quotes').set(inOrg(p.owner, p.orgId)).send({ customerPhone: custPhone, categoryId: catId, site: SITE, days: DAY() }).expect(403);
    const created = await t.http().post('/api/v1/partner/agent/orders').set(inOrg(agent.owner, agent.orgId)).send({ quoteId: q.body.id }).expect(201);
    const id = created.body.id;
    await jobs.runDue();
    expect((await order(id)).status).toBe('awaiting_customer_confirmation');
    expect(await offerOf(id)).toBeUndefined();

    const sms = (app.get(SMS_PROVIDER) as DevSmsProvider).lastMessage(custPhone) as string;
    const token = sms.match(/\/o\/([A-Za-z0-9_-]+)/)?.[1] as string;
    expect(token).toBeTruthy();
    await t.http().get('/api/v1/public/orders/wrong-token').expect(404);
    const page = await t.http().get(`/api/v1/public/orders/${token}`).expect(200);
    expect(page.body.order.status).toBe('awaiting_customer_confirmation');
    expect(page.body.payerOptions[0]).toEqual({ kind: 'individual' });

    await t.http().post(`/api/v1/public/orders/${token}/confirm`).send({ payer: { kind: 'individual' } }).expect(204);
    await jobs.runDue();
    expect((await offerOf(id)).org_id).toBe(p.orgId);
    await t.http().post(`/api/v1/public/orders/${token}/confirm`).send({ payer: { kind: 'individual' } }).expect(409);

    await t.http().post(`/api/v1/partner/offers/${(await offerOf(id)).id}/accept`).set(inOrg(p.owner, p.orgId)).expect(204);
    const pay = await t.http().post(`/api/v1/public/orders/${token}/payments`).expect(201);
    expect(pay.body.amountKopecks).toBe(Number((await order(id)).total_kopecks));
    await devPay(pay.body.confirmationUrl);
    await t.http().post(`/api/v1/partner/orders/${id}/assign-operator`).set(inOrg(p.owner, p.orgId)).send({ memberId: p.opMember }).expect(204);
    await t.http().post(`/api/v1/partner/operator/orders/${id}/status-events`).set(inOrg(p.opToken, p.orgId)).send({ events: [ev('en_route'), ev('arrived'), ev('in_progress'), ev('finished')] }).expect(200);
    await t.http().post(`/api/v1/public/orders/${token}/confirm-completion`).expect(204);

    const o = await order(id);
    expect(o.status).toBe('completed');
    expect(Number(o.agent_kopecks)).toBe(Math.round(Number(o.total_kopecks) * 0.07));
    expect(Number(o.platform_kopecks)).toBe(Math.round(Number(o.total_kopecks) * 0.12) - Number(o.agent_kopecks));
    const list = await t.http().get('/api/v1/partner/agent/orders').set(inOrg(agent.owner, agent.orgId)).expect(200);
    expect(list.body[0]).toMatchObject({ id, customerPhone: custPhone, rewardKopecks: Number(o.agent_kopecks), rewardFinal: true });
    // Диспетчер видит заказ, но не его оплату.
    const view = await t.http().get(`/api/v1/partner/agent/orders/${id}`).set(inOrg(agent.owner, agent.orgId)).expect(200);
    expect(view.body.price).toBeUndefined();
  });
});
