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

describe('Этап 7: оплата, отмены, журнал, выплаты', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;
  let t: TestClient;
  let jobs: JobsService;
  let catId: string;
  let seq = 0;
  let innSeq = 9000;
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const inOrg = (token: string, orgId: string) => ({ ...bearer(token), 'X-Org-Id': orgId });
  const phone = () => `+7916600${String(++seq).padStart(4, '0')}`;

  interface Co { orgId: string; owner: string; ownerPhone: string; opToken: string; opMember: string; dispatcher?: string }

  async function company(km: number, opts: { bank?: boolean; dispatcher?: boolean } = {}): Promise<Co> {
    const ownerPhone = phone();
    const owner = await t.login(ownerPhone);
    const org = (await t.http().post('/api/v1/partner/organizations').set(bearer(owner.token)).send({
      kind: 'partner', legalForm: 'llc', name: `ООО Финтех ${innSeq}`, representativeName: 'Иванов И.И.', inn: innLegal(innSeq), ogrn: ogrnLegal(innSeq++),
      legalAddress: 'Москва, 1', email: 'a@b.ru', contactPhone: '+79160000099',
    }).expect(201)).body;
    await pool.query("UPDATE organizations SET status = 'verified' WHERE id = $1", [org.id]);
    const base = north(km);
    await pool.query(
      `INSERT INTO equipment_units (org_id, category_id, brand, model, year, attributes, base_point, base_address, work_radius_km, allow_beyond_radius, is_online, verification_status, created_by)
       VALUES ($1, $2, 'JCB', '8030', 2021, '{"operating_weight": 3}', ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, 'База', 150, true, true, 'approved', $5)`,
      [org.id, catId, base.lng, base.lat, owner.userId]);
    const opPhone = phone();
    await t.http().post('/api/v1/partner/members').set(inOrg(owner.token, org.id)).send({ phone: opPhone, role: 'operator' }).expect(201);
    const op = await t.login(opPhone);
    const inv = (await t.http().get('/api/v1/partner/invitations').set(bearer(op.token))).body;
    await t.http().post(`/api/v1/partner/invitations/${inv[0].memberId}/accept`).set(bearer(op.token)).expect(204);
    await pool.query("UPDATE organization_members SET operator_verification = 'approved' WHERE id = $1", [inv[0].memberId]);
    const co: Co = { orgId: org.id, owner: owner.token, ownerPhone, opToken: op.token, opMember: inv[0].memberId };
    if (opts.dispatcher) {
      const dPhone = phone();
      await t.http().post('/api/v1/partner/members').set(inOrg(owner.token, org.id)).send({ phone: dPhone, role: 'dispatcher' }).expect(201);
      const d = await t.login(dPhone);
      const dinv = (await t.http().get('/api/v1/partner/invitations').set(bearer(d.token))).body;
      await t.http().post(`/api/v1/partner/invitations/${dinv[0].memberId}/accept`).set(bearer(d.token)).expect(204);
      co.dispatcher = d.token;
    }
    if (opts.bank !== false) {
      await redis.flushdb();
      await t.http().post('/api/v1/partner/organizations/current/bank-account/code').set(inOrg(owner.token, org.id)).expect(200);
      await t.http().put('/api/v1/partner/organizations/current/bank-account').set(inOrg(owner.token, org.id)).send({
        bik: '044525225', accountNumber: '40702810900000000001', correspondentAccount: '30101810400000000225', bankName: 'Банк', code: t.lastCode(ownerPhone),
      }).expect(200);
    }
    await redis.flushdb();
    return co;
  }

  async function customerWith(kind: 'individual' | 'legal') {
    const c = await t.login(phone(), 'client');
    let payer: Record<string, unknown> = { kind: 'individual' };
    if (kind === 'legal') {
      const lp = await t.http().post('/api/v1/client/organizations').set(bearer(c.token))
        .send({ inn: innLegal(innSeq++), name: 'ООО Заказчик', legalAddress: 'Москва, 2', email: 'buh@client.ru' }).expect(201);
      payer = { kind: 'legal', legalProfileId: lp.body.id };
    }
    return { ...c, payer };
  }

  async function placeAndAccept(cust: { token: string; payer: Record<string, unknown> }, co: Co) {
    const q = await t.http().post('/api/v1/client/quotes').set(bearer(cust.token)).send({ categoryId: catId, site: SITE, days: [{ date: mskDate(2), startTime: '08:00', hours: 8 }] }).expect(201);
    const o = await t.http().post('/api/v1/client/orders').set(bearer(cust.token)).send({ quoteId: q.body.id, payer: cust.payer }).expect(201);
    await jobs.runDue();
    const offer = (await pool.query("SELECT id, org_id FROM order_offers WHERE order_id = $1 AND status = 'pending'", [o.body.id])).rows[0];
    expect(offer.org_id).toBe(co.orgId);
    await t.http().post(`/api/v1/partner/offers/${offer.id}/accept`).set(inOrg(co.owner, co.orgId)).expect(204);
    return { orderId: o.body.id as string, total: Number(q.body.totalKopecks) };
  }

  async function pay(token: string, orderId: string) {
    const p = await t.http().post(`/api/v1/client/orders/${orderId}/payments`).set(bearer(token)).expect(201);
    const providerId = String(p.body.confirmationUrl).split('/').pop() as string;
    await t.http().post(`/api/v1/dev/payments/${providerId}/succeed`).expect(200);
    return { payment: p.body, providerId };
  }

  async function runWork(co: Co, orderId: string) {
    await t.http().post(`/api/v1/partner/orders/${orderId}/assign-operator`).set(inOrg(co.owner, co.orgId)).send({ memberId: co.opMember }).expect(204);
    const ev = (status: string) => ({ clientEventId: randomUUID(), status, recordedAt: new Date().toISOString() });
    await t.http().post(`/api/v1/partner/operator/orders/${orderId}/status-events`).set(inOrg(co.opToken, co.orgId))
      .send({ events: [ev('en_route'), ev('arrived'), ev('in_progress'), ev('finished')] }).expect(200);
  }

  const order = async (id: string) => (await pool.query('SELECT * FROM orders WHERE id = $1', [id])).rows[0];
  const balance = async (account: string) => Number((await pool.query('SELECT COALESCE(sum(amount_kopecks), 0) AS s FROM ledger_entries WHERE account = $1', [account])).rows[0].s);

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

  it('физлицо: 100% после принятия; повторное «Оплатить» и повторное уведомление не списывают дважды; завершение — начисления 88/12', async () => {
    const co = await company(10, { dispatcher: true });
    const cust = await customerWith('individual');
    const { orderId, total } = await placeAndAccept(cust, co);

    const a = await t.http().post(`/api/v1/client/orders/${orderId}/payments`).set(bearer(cust.token)).expect(201);
    const b = await t.http().post(`/api/v1/client/orders/${orderId}/payments`).set(bearer(cust.token)).expect(201);
    expect(b.body.id).toBe(a.body.id);
    expect(a.body.amountKopecks).toBe(total);
    const providerId = String(a.body.confirmationUrl).split('/').pop();
    await t.http().post(`/api/v1/dev/payments/${providerId}/succeed`).expect(200);
    await t.http().post(`/api/v1/dev/payments/${providerId}/succeed`).expect(200);
    await t.http().post('/api/v1/webhooks/payments/dev').send({ eventId: 'other-event', type: 'payment.succeeded', providerPaymentId: providerId, amountKopecks: total }).expect(200);
    expect(Number((await order(orderId)).paid_kopecks)).toBe(total);
    expect((await pool.query("SELECT count(*)::int AS n FROM ledger_transactions WHERE order_id = $1 AND kind = 'payment_received'", [orderId])).rows[0].n).toBe(1);
    expect((await order(orderId)).status).toBe('awaiting_assignment');
    await t.http().post(`/api/v1/client/orders/${orderId}/payments`).set(bearer(cust.token)).expect(409);

    // Диспетчер компании видит сумму к получению после комиссии и статус оплаты (Н-22, П-9).
    const pv = await t.http().get(`/api/v1/partner/orders/${orderId}`).set(inOrg(co.dispatcher as string, co.orgId)).expect(200);
    const o0 = await order(orderId);
    const expectedPartner = total - Math.round(total * 0.12) + (Number(o0.partner_delivery_kopecks) - Number(o0.customer_delivery_kopecks));
    expect(pv.body.partnerPrice.amountKopecks).toBe(expectedPartner);
    expect(pv.body.customerPaymentStatus).toBe('paid');
    await t.http().get('/api/v1/partner/finance/summary').set(inOrg(co.dispatcher as string, co.orgId)).expect(403);

    await runWork(co, orderId);
    await t.http().post(`/api/v1/client/orders/${orderId}/confirm-completion`).set(bearer(cust.token)).expect(204);
    const o = await order(orderId);
    expect(o.status).toBe('completed');
    expect(Number(o.commission_kopecks)).toBe(Math.round(total * 0.12));
    expect(Number(o.agent_kopecks)).toBe(0);
    expect(Number(o.partner_amount_kopecks)).toBe(expectedPartner);
    expect(await balance(`customer:${orderId}`)).toBe(0);
    expect(await balance(`partner:${co.orgId}`)).toBe(-expectedPartner);

    const fin = await t.http().get('/api/v1/partner/finance/summary').set(inOrg(co.owner, co.orgId)).expect(200);
    expect(fin.body).toEqual({ accruedKopecks: expectedPartner, paidOutKopecks: 0, balanceKopecks: expectedPartner });
  });

  it('заказ независимого диспетчера: 12% = 7% диспетчеру + 5% платформе (Ф-1)', async () => {
    const co = await company(10);
    const agentOwner = await t.login(phone());
    const agent = (await t.http().post('/api/v1/partner/organizations').set(bearer(agentOwner.token)).send({
      kind: 'agent', legalForm: 'llc', name: 'ООО Диспетчер', representativeName: 'Сидоров С.С.', inn: innLegal(innSeq), ogrn: ogrnLegal(innSeq++),
      legalAddress: 'Москва, 3', email: 'd@d.ru', contactPhone: '+79160000099',
    }).expect(201)).body;
    const cust = await customerWith('individual');
    const { orderId, total } = await placeAndAccept(cust, co);
    await pool.query("UPDATE orders SET agent_org_id = $1, source = 'agent' WHERE id = $2", [agent.id, orderId]);
    await pay(cust.token, orderId);
    await runWork(co, orderId);
    await t.http().post(`/api/v1/client/orders/${orderId}/confirm-completion`).set(bearer(cust.token)).expect(204);
    const o = await order(orderId);
    expect(Number(o.commission_kopecks)).toBe(Math.round(total * 0.12));
    expect(Number(o.agent_kopecks)).toBe(Math.round(total * 0.07));
    expect(Number(o.platform_kopecks)).toBe(Math.round(total * 0.12) - Math.round(total * 0.07));
    expect(await balance(`agent:${agent.id}`)).toBe(-Math.round(total * 0.07));
  });

  it('юрлицо: 50% после принятия, остальные 50% после завершения; не оплатил за 24 часа — долг и запрет новых заказов (Н-9, К-9)', async () => {
    const co = await company(10);
    const cust = await customerWith('legal');
    const { orderId, total } = await placeAndAccept(cust, co);
    const first = await pay(cust.token, orderId);
    expect(first.payment.amountKopecks).toBe(Math.round(total / 2 / 100) * 100);
    await runWork(co, orderId);
    await t.http().post(`/api/v1/client/orders/${orderId}/confirm-completion`).set(bearer(cust.token)).expect(204);
    expect((await order(orderId)).status).toBe('awaiting_final_payment');

    await pool.query("UPDATE scheduled_jobs SET run_at = now() - interval '1 second' WHERE status = 'pending' AND type = 'final_payment_deadline'");
    await jobs.runDue();
    const debt = await pool.query('SELECT amount_kopecks, status FROM customer_debts WHERE order_id = $1', [orderId]);
    expect(debt.rows[0]).toEqual({ amount_kopecks: String(total - first.payment.amountKopecks), status: 'open' });
    const blocked = await t.http().post('/api/v1/client/quotes').set(bearer(cust.token)).send({ categoryId: catId, site: SITE, days: [{ date: mskDate(3), startTime: '08:00', hours: 8 }] }).expect(409);
    expect(blocked.body.code).toBe('DEBT_EXISTS');

    const second = await pay(cust.token, orderId);
    expect(second.payment).toMatchObject({ part: 'final', amountKopecks: total - first.payment.amountKopecks });
    expect((await order(orderId)).status).toBe('completed');
    expect((await pool.query('SELECT status FROM customer_debts WHERE order_id = $1', [orderId])).rows[0].status).toBe('paid');
    expect(await balance(`customer:${orderId}`)).toBe(0);
    await t.http().post('/api/v1/client/quotes').set(bearer(cust.token)).send({ categoryId: catId, site: SITE, days: [{ date: mskDate(3), startTime: '08:00', hours: 8 }] }).expect(201);
  });

  it('отмена после оплаты: поддержка удерживает часть, остальное возвращается; удержанное делится 88/12 (07, Ф-3)', async () => {
    const co = await company(10);
    const cust = await customerWith('individual');
    const { orderId, total } = await placeAndAccept(cust, co);
    await pay(cust.token, orderId);
    await t.http().post(`/api/v1/client/orders/${orderId}/cancel`).set(bearer(cust.token)).send({ reason: 'Не нужно' }).expect(204);
    const support = await t.adminLogin('sup@fin.test', 'support');
    const queue = await t.http().get('/api/v1/admin/cancellation-reviews?status=pending').set(bearer(support)).expect(200);
    expect(queue.body.map((r: { order_id: string }) => r.order_id)).toContain(orderId);
    // Заказчик видит, что отмену рассматривает поддержка; сумма возврата до решения не показывается.
    const before = await t.http().get(`/api/v1/client/orders/${orderId}`).set(bearer(cust.token)).expect(200);
    expect(before.body.refundReview).toEqual({ status: 'in_review', decision: null, refundKopecks: null, reason: null, decidedAt: null });

    // Возврат total − 5 000 ₽ больше лимита поддержки 10 000 ₽ — нужно подтверждение финансиста (К-14).
    const retained = 500_000;
    const res = await t.http().post(`/api/v1/admin/cancellation-reviews/${orderId}/decide`).set(bearer(support)).send({ retainedKopecks: retained, reason: 'Техника выехала' }).expect(200);
    expect(res.body.status).toBe('awaiting_approval');
    expect((await pool.query('SELECT count(*)::int AS n FROM refunds WHERE order_id = $1', [orderId])).rows[0].n).toBe(0);
    const finance = await t.adminLogin('fin@fin.test', 'finance');
    await t.http().post(`/api/v1/admin/cancellation-reviews/${orderId}/decide`).set(bearer(finance)).send({ retainedKopecks: 0, reason: 'x' }).expect(403);
    const pendingApproval = await t.http().get(`/api/v1/client/orders/${orderId}`).set(bearer(cust.token)).expect(200);
    expect(pendingApproval.body.refundReview.status).toBe('in_review');
    await t.http().post(`/api/v1/admin/cancellation-reviews/${orderId}/approve`).set(bearer(finance)).expect(200);
    const after = await t.http().get(`/api/v1/client/orders/${orderId}`).set(bearer(cust.token)).expect(200);
    expect(after.body.refundReview).toMatchObject({ status: 'decided', decision: 'partial_refund', refundKopecks: total - retained, reason: 'Техника выехала' });

    const r = await pool.query('SELECT status, partner_kopecks, agent_kopecks, platform_kopecks, refund_kopecks FROM cancellation_reviews WHERE order_id = $1', [orderId]);
    expect(r.rows[0]).toEqual({ status: 'decided', partner_kopecks: '440000', agent_kopecks: '0', platform_kopecks: '60000', refund_kopecks: String(total - retained) });
    const refunds = await pool.query("SELECT sum(amount_kopecks)::bigint AS s FROM refunds WHERE order_id = $1 AND status = 'succeeded'", [orderId]);
    expect(Number(refunds.rows[0].s)).toBe(total - retained);
    expect(await balance(`customer:${orderId}`)).toBe(0);
    await t.http().post(`/api/v1/admin/cancellation-reviews/${orderId}/decide`).set(bearer(support)).send({ retainedKopecks: 0, reason: 'повтор' }).expect(409);
    const hist = await pool.query("SELECT reason FROM order_status_history WHERE order_id = $1 AND actor_type = 'admin' ORDER BY id", [orderId]);
    expect(hist.rows.map((h) => h.reason)).toEqual(['Решение поддержки: частичный возврат (ждёт подтверждения финансиста)', 'Возврат подтверждён']);
  });

  it('полный возврат в пределах лимита поддержка проводит сама; отказ финансиста возвращает решение на пересмотр', async () => {
    const co = await company(10);
    const cust = await customerWith('individual');
    const { orderId, total } = await placeAndAccept(cust, co);
    await pay(cust.token, orderId);
    await t.http().post(`/api/v1/client/orders/${orderId}/cancel`).set(bearer(cust.token)).send({}).expect(204);
    const support = await t.adminLogin('sup@fin.test', 'support');
    const finance = await t.adminLogin('fin@fin.test', 'finance');
    // Возврат 9 000 ₽ — в пределах лимита, остальное удерживается.
    const keep = total - 900_000;
    const ok = await t.http().post(`/api/v1/admin/cancellation-reviews/${orderId}/decide`).set(bearer(support)).send({ retainedKopecks: keep, reason: 'Частично' }).expect(200);
    expect(ok.body.status).toBe('decided');

    const co2 = await company(11);
    await pool.query('UPDATE equipment_units SET is_online = (org_id = $1)', [co2.orgId]);
    const cust2 = await customerWith('individual');
    const o2 = await placeAndAccept(cust2, co2);
    await pay(cust2.token, o2.orderId);
    await t.http().post(`/api/v1/client/orders/${o2.orderId}/cancel`).set(bearer(cust2.token)).send({}).expect(204);
    await t.http().post(`/api/v1/admin/cancellation-reviews/${o2.orderId}/decide`).set(bearer(support)).send({ retainedKopecks: 0, reason: 'Полный возврат' }).expect(200);
    const rej = await t.http().post(`/api/v1/admin/cancellation-reviews/${o2.orderId}/reject`).set(bearer(finance)).send({ reason: 'Нужно удержать за выезд' }).expect(200);
    expect(rej.body.status).toBe('pending');
    expect(Number((await order(o2.orderId)).refunded_kopecks)).toBe(0);
  });

  it('оплата, пришедшая после отмены по тайм-ауту, возвращается автоматически (Н-31)', async () => {
    const co = await company(10);
    const cust = await customerWith('individual');
    const { orderId } = await placeAndAccept(cust, co);
    const p = await t.http().post(`/api/v1/client/orders/${orderId}/payments`).set(bearer(cust.token)).expect(201);
    await pool.query("UPDATE scheduled_jobs SET run_at = now() - interval '1 second' WHERE status = 'pending' AND type = 'prepayment_timeout'");
    await jobs.runDue();
    expect((await order(orderId)).status).toBe('cancelled_unpaid');
    await t.http().post(`/api/v1/dev/payments/${String(p.body.confirmationUrl).split('/').pop()}/succeed`).expect(200);
    await jobs.runDue();
    const o = await order(orderId);
    expect(o.status).toBe('cancelled_unpaid');
    expect(Number(o.refunded_kopecks)).toBe(Number(o.paid_kopecks));
    expect(Number(o.paid_kopecks)).toBeGreaterThan(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM cancellation_reviews WHERE order_id = $1', [orderId])).rows[0].n).toBe(0);
    expect(await balance(`customer:${orderId}`)).toBe(0);
  });

  it('выплата на следующий день: один раз; без реквизитов — не создаётся (Н-10)', async () => {
    const co = await company(10);
    const noBank = await company(20, { bank: false });
    const done = async (c: Co) => {
      const cust = await customerWith('individual');
      await pool.query('UPDATE equipment_units SET is_online = (org_id = $1)', [c.orgId]);
      const { orderId } = await placeAndAccept(cust, c);
      await pay(cust.token, orderId);
      await runWork(c, orderId);
      await t.http().post(`/api/v1/client/orders/${orderId}/confirm-completion`).set(bearer(cust.token)).expect(204);
      return orderId;
    };
    const o1 = await done(co);
    const o2 = await done(noBank);
    const finance = await t.adminLogin('fin@fin.test', 'finance');
    // Сегодня завершённое ещё не выплачивается.
    await t.http().post('/api/v1/admin/payouts/run').set(bearer(finance)).expect(200);
    expect((await pool.query('SELECT count(*)::int AS n FROM payout_items WHERE order_id = $1', [o1])).rows[0].n).toBe(0);

    await pool.query("UPDATE orders SET completed_at = now() - interval '2 days' WHERE id IN ($1, $2)", [o1, o2]);
    const run = await t.http().post('/api/v1/admin/payouts/run').set(bearer(finance)).expect(200);
    expect(run.body.payouts).toBeGreaterThanOrEqual(1);
    const payout = await pool.query('SELECT p.status, p.amount_kopecks FROM payouts p JOIN payout_items i ON i.payout_id = p.id WHERE i.order_id = $1', [o1]);
    expect(payout.rows[0].status).toBe('paid');
    expect(Number(payout.rows[0].amount_kopecks)).toBe(Number((await order(o1)).partner_amount_kopecks));
    expect(await balance(`partner:${co.orgId}`)).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM payout_items WHERE order_id = $1', [o2])).rows[0].n).toBe(0);

    await t.http().post('/api/v1/admin/payouts/run').set(bearer(finance)).expect(200);
    expect((await pool.query('SELECT count(*)::int AS n FROM payout_items WHERE order_id = $1', [o1])).rows[0].n).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM ledger_transactions WHERE kind = 'payout'")).rows[0].n).toBe(1);
  });

  it('журнал: несбалансированную транзакцию БД не принимает; журнал не редактируется', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tx = await client.query("INSERT INTO ledger_transactions (kind, idempotency_key) VALUES ('test', 'bad-1') RETURNING id");
      await client.query("INSERT INTO ledger_entries (transaction_id, account, amount_kopecks) VALUES ($1, 'cash:dev', 100)", [tx.rows[0].id]);
      await expect(client.query('COMMIT')).rejects.toThrow(/не сбалансированы/);
    } finally {
      client.release();
    }
    await expect(pool.query('DELETE FROM ledger_entries')).rejects.toThrow(/только добавление/);
    const total = await pool.query('SELECT COALESCE(sum(amount_kopecks), 0)::bigint AS s FROM ledger_entries');
    expect(Number(total.rows[0].s)).toBe(0);
  });
});
