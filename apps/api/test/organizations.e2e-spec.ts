import type { INestApplication } from '@nestjs/common';
import type Redis from 'ioredis';
import { authenticator } from 'otplib';
import type { Pool } from 'pg';
import { AdminAuthService } from '../src/admin/admin-auth.service';
import { createApp } from '../src/app.factory';
import { REDIS } from '../src/redis/redis.module';
import { resetTestDatabase } from './db';
import { innIp, innLegal, ogrnIp, ogrnLegal, TestClient } from './helpers';

const OWNER = '+79160000001';
const MANAGER = '+79160000002';
const DISPATCHER = '+79160000003';
const OPERATOR = '+79160000004';
const STRANGER = '+79160000005';
const OWNER_B = '+79160000006';

describe('Этап 3: организации, сотрудники, документы, модерация', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;
  let t: TestClient;
  let seed = 1;
  let phoneSeq = 100;
  /** Уникальный номер машиниста для теста: машинист может работать только в одной компании. */
  const freshPhone = () => `+7916100${String(phoneSeq++).padStart(4, '0')}`;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const inOrg = (token: string, orgId: string) => ({ ...bearer(token), 'X-Org-Id': orgId });

  async function createLlc(token: string, name = 'ООО Ковш') {
    const n = seed++;
    const res = await t.http().post('/api/v1/partner/organizations').set(bearer(token)).send({
      kind: 'partner', legalForm: 'llc', name, representativeName: 'Иванов Иван Иванович',
      inn: innLegal(n), ogrn: ogrnLegal(n), kpp: '770701001', legalAddress: 'Москва, ул. Строителей, 1',
      email: 'info@kovsh.test', contactPhone: '+79160000099',
    });
    expect(res.status).toBe(201);
    return res.body as { id: string; status: string; myRole: string };
  }

  async function completeOrg(token: string, orgId: string) {
    for (const code of ['org_registration_record', 'org_inn_certificate', 'org_director_authority']) {
      const fileId = await t.upload(token);
      await t.http().post('/api/v1/partner/organizations/current/documents').set(inOrg(token, orgId))
        .send({ documentTypeCode: code, fileId }).expect(201);
    }
    await redis.flushdb();
    await t.http().post('/api/v1/partner/organizations/current/bank-account/code').set(inOrg(token, orgId)).expect(200);
    const phone = (await pool.query('SELECT u.phone FROM users u JOIN organization_members m ON m.user_id = u.id WHERE m.org_id = $1 AND m.role = $2', [orgId, 'owner'])).rows[0].phone;
    await t.http().put('/api/v1/partner/organizations/current/bank-account').set(inOrg(token, orgId)).send({
      bik: '044525225', accountNumber: '40702810900000000001', correspondentAccount: '30101810400000000225',
      bankName: 'ПАО Сбербанк', code: t.lastCode(phone),
    }).expect(200);
  }

  function invite(token: string, orgId: string, phone: string, role: string) {
    return t.http().post('/api/v1/partner/members').set(inOrg(token, orgId)).send({ phone, role });
  }

  async function acceptAll(phone: string) {
    const { token } = await t.login(phone);
    const inv = await t.http().get('/api/v1/partner/invitations').set(bearer(token)).expect(200);
    for (const i of inv.body) await t.http().post(`/api/v1/partner/invitations/${i.memberId}/accept`).set(bearer(token)).expect(204);
    return token;
  }

  beforeAll(async () => {
    pool = await resetTestDatabase();
    app = await createApp();
    await app.init();
    redis = app.get(REDIS);
    t = new TestClient(app);
  });
  beforeEach(async () => {
    await redis.flushdb();
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('Регистрация организации', () => {
    it('доступна только в приложении партнёра', async () => {
      const { token } = await t.login(STRANGER, 'client');
      await t.http().get('/api/v1/partner/memberships').set(bearer(token)).expect(403);
    });

    it('создатель становится главным владельцем, организация — черновик', async () => {
      const { token } = await t.login(OWNER);
      const org = await createLlc(token);
      expect(org).toMatchObject({ status: 'draft', myRole: 'owner' });
      const m = await t.http().get('/api/v1/partner/memberships').set(bearer(token)).expect(200);
      expect(m.body.find((x: { orgId: string }) => x.orgId === org.id)).toMatchObject({ role: 'owner' });
    });

    it('проверяет контрольные числа и соответствие формы: ИП — 12/15, ООО — 10/13', async () => {
      const { token } = await t.login(OWNER);
      const base = { kind: 'partner', name: 'XX', representativeName: 'Иванов И.И.', legalAddress: 'Москва, 1', email: 'a@b.ru', contactPhone: '+79160000099' };
      const badInn = await t.http().post('/api/v1/partner/organizations').set(bearer(token))
        .send({ ...base, legalForm: 'llc', inn: '7707083894', ogrn: '1027700132195' }).expect(400);
      expect(badInn.body.code).toBe('INVALID_INN');
      const wrongForm = await t.http().post('/api/v1/partner/organizations').set(bearer(token))
        .send({ ...base, legalForm: 'ip', inn: innLegal(900), ogrn: ogrnLegal(900) }).expect(400);
      expect(wrongForm.body.code).toBe('INVALID_INN');
      await t.http().post('/api/v1/partner/organizations').set(bearer(token))
        .send({ ...base, legalForm: 'ip', inn: innIp(901), ogrn: ogrnIp(901) }).expect(201);
    });

    it('один ИНН нельзя зарегистрировать дважды', async () => {
      const { token } = await t.login(OWNER);
      const body = { kind: 'partner', legalForm: 'llc', name: 'Дубль', representativeName: 'Иванов И.И.', inn: innLegal(500), ogrn: ogrnLegal(500), legalAddress: 'Москва, 1', email: 'a@b.ru', contactPhone: '+79160000099' };
      await t.http().post('/api/v1/partner/organizations').set(bearer(token)).send(body).expect(201);
      const dup = await t.http().post('/api/v1/partner/organizations').set(bearer(token)).send(body).expect(409);
      expect(dup.body.code).toBe('ORG_ALREADY_EXISTS');
    });

    it('чужая организация не видна (Р-13)', async () => {
      const a = await t.login(OWNER);
      const b = await t.login(OWNER_B);
      const orgA = await createLlc(a.token);
      const res = await t.http().get('/api/v1/partner/organizations/current').set(inOrg(b.token, orgA.id)).expect(404);
      expect(res.body.code).toBe('NOT_A_MEMBER');
    });

    it('на проверку нельзя отправить без документов и реквизитов', async () => {
      const { token } = await t.login(OWNER);
      const org = await createLlc(token);
      const res = await t.http().post('/api/v1/partner/organizations/current/submit').set(inOrg(token, org.id)).expect(422);
      expect(res.body.code).toBe('ORG_INCOMPLETE');
      expect(res.body.details.missingDocuments).toEqual(['org_registration_record', 'org_inn_certificate', 'org_director_authority']);
      expect(res.body.details.missingBankAccount).toBe(true);
    });

    it('файлы: принимаются только разрешённые типы с правильной сигнатурой', async () => {
      const { token } = await t.login(OWNER);
      await t.http().post('/api/v1/files').set(bearer(token))
        .attach('file', Buffer.from('hello'), { filename: 'x.pdf', contentType: 'application/pdf' }).expect(415);
      await t.http().post('/api/v1/files').set(bearer(token))
        .attach('file', Buffer.from('hello'), { filename: 'x.txt', contentType: 'text/plain' }).expect(415);
    });

    it('реквизиты меняет только главный владелец и только с SMS-кодом (П-17)', async () => {
      const owner = await t.login(OWNER);
      const org = await createLlc(owner.token);
      await invite(owner.token, org.id, MANAGER, 'manager').expect(201);
      const manager = await acceptAll(MANAGER);
      await t.http().post('/api/v1/partner/organizations/current/bank-account/code').set(inOrg(manager, org.id)).expect(403);

      await t.http().post('/api/v1/partner/organizations/current/bank-account/code').set(inOrg(owner.token, org.id)).expect(200);
      const bad = await t.http().put('/api/v1/partner/organizations/current/bank-account').set(inOrg(owner.token, org.id)).send({
        bik: '044525225', accountNumber: '40702810900000000001', correspondentAccount: '30101810400000000225', bankName: 'Банк', code: '000000' === t.lastCode(OWNER) ? '111111' : '000000',
      });
      expect(bad.status).toBe(401);
      await t.http().put('/api/v1/partner/organizations/current/bank-account').set(inOrg(owner.token, org.id)).send({
        bik: '044525225', accountNumber: '40702810900000000001', correspondentAccount: '30101810400000000225', bankName: 'Банк', code: t.lastCode(OWNER),
      }).expect(200);

      const view = await t.http().get('/api/v1/partner/organizations/current').set(inOrg(owner.token, org.id)).expect(200);
      expect(view.body.bankAccount).toEqual({ bik: '044525225', bankName: 'Банк', accountLast4: '0001' });
      const stored = await pool.query('SELECT account_number_enc FROM organization_bank_accounts WHERE org_id = $1', [org.id]);
      expect(stored.rows[0].account_number_enc).not.toContain('40702810900000000001');
      const log = await pool.query("SELECT action FROM user_action_log WHERE org_id = $1 AND action = 'bank_account.changed'", [org.id]);
      expect(log.rowCount).toBe(1);
    });
  });

  describe('Модерация', () => {
    it('полный цикл: отправка → отклонение с причиной → исправление → подтверждение', async () => {
      const owner = await t.login(OWNER);
      const org = await createLlc(owner.token);
      await completeOrg(owner.token, org.id);
      await t.http().post('/api/v1/partner/organizations/current/submit').set(inOrg(owner.token, org.id)).expect(200);
      const locked = await t.http().patch('/api/v1/partner/organizations/current').set(inOrg(owner.token, org.id)).send({ name: 'Новое' }).expect(409);
      expect(locked.body.code).toBe('ORG_NOT_EDITABLE');

      const moderator = await t.adminLogin('mod@kovsh.test', 'moderator');
      const queue = await t.http().get('/api/v1/admin/organizations?status=pending_review').set(bearer(moderator)).expect(200);
      expect(queue.body.map((o: { id: string }) => o.id)).toContain(org.id);

      await t.http().post(`/api/v1/admin/organizations/${org.id}/reject`).set(bearer(moderator)).send({ reason: 'Нечитаемый скан' }).expect(200);
      const rejected = await t.http().get('/api/v1/partner/organizations/current').set(inOrg(owner.token, org.id)).expect(200);
      expect(rejected.body).toMatchObject({ status: 'rejected', rejectionReason: 'Нечитаемый скан' });

      await t.http().patch('/api/v1/partner/organizations/current').set(inOrg(owner.token, org.id)).send({ name: 'ООО Ковш Плюс' }).expect(200);
      await t.http().post('/api/v1/partner/organizations/current/submit').set(inOrg(owner.token, org.id)).expect(200);

      const early = await t.http().post(`/api/v1/admin/organizations/${org.id}/approve`).set(bearer(moderator)).expect(422);
      expect(early.body.code).toBe('ORG_INCOMPLETE');

      const card = await t.http().get(`/api/v1/admin/organizations/${org.id}`).set(bearer(moderator)).expect(200);
      for (const d of card.body.documentFiles) {
        await t.http().post(`/api/v1/admin/documents/${d.id}/approve`).set(bearer(moderator)).send({}).expect(200);
      }
      await t.http().post(`/api/v1/admin/organizations/${org.id}/approve`).set(bearer(moderator)).expect(200);
      const done = await t.http().get('/api/v1/partner/organizations/current').set(inOrg(owner.token, org.id)).expect(200);
      expect(done.body.status).toBe('verified');

      const history = await pool.query('SELECT to_status FROM organization_status_history WHERE org_id = $1 ORDER BY id', [org.id]);
      expect(history.rows.map((r) => r.to_status)).toEqual(['draft', 'pending_review', 'rejected', 'pending_review', 'verified']);
      const audit = await pool.query("SELECT action FROM admin_audit_log WHERE entity_id = $1 ORDER BY id", [org.id]);
      expect(audit.rows.map((r) => r.action)).toEqual(['organization.reject', 'organization.approve']);
    });

    it('права ролей админки (В-40)', async () => {
      const owner = await t.login(OWNER);
      const org = await createLlc(owner.token);
      const finance = await t.adminLogin('fin@kovsh.test', 'finance');
      const support = await t.adminLogin('sup@kovsh.test', 'support');
      const superadmin = await t.adminLogin('root@kovsh.test', 'superadmin');

      await t.http().post(`/api/v1/admin/organizations/${org.id}/approve`).set(bearer(finance)).expect(403);
      await t.http().post(`/api/v1/admin/organizations/${org.id}/approve`).set(bearer(support)).expect(403);
      await t.http().patch('/api/v1/admin/settings/offer_timeout_sec').set(bearer(support)).send({ value: 45 }).expect(403);
      await t.http().patch('/api/v1/admin/settings/offer_timeout_sec').set(bearer(superadmin)).send({ value: 45, reason: 'тест' }).expect(200);
      await t.http().patch('/api/v1/admin/settings/offer_timeout_sec').set(bearer(superadmin)).send({ value: 40 }).expect(200);
      await t.http().get('/api/v1/admin/admins').set(bearer(support)).expect(403);
      await t.http().get('/api/v1/admin/audit-log?entity=setting').set(bearer(superadmin)).expect(200);
    });

    it('заблокированная организация видит только свой статус', async () => {
      const owner = await t.login(OWNER);
      const org = await createLlc(owner.token);
      const support = await t.adminLogin('sup@kovsh.test', 'support');
      await t.http().post(`/api/v1/admin/organizations/${org.id}/block`).set(bearer(support)).send({ reason: 'Жалобы' }).expect(200);
      await t.http().get('/api/v1/partner/members').set(inOrg(owner.token, org.id)).expect(403);
      const view = await t.http().get('/api/v1/partner/organizations/current').set(inOrg(owner.token, org.id)).expect(200);
      expect(view.body).toMatchObject({ status: 'blocked', blockedReason: 'Жалобы' });
      await t.http().post(`/api/v1/admin/organizations/${org.id}/unblock`).set(bearer(support)).expect(200);
      await t.http().get('/api/v1/partner/members').set(inOrg(owner.token, org.id)).expect(200);
    });

    it('доступ к файлам документов', async () => {
      const owner = await t.login(OWNER);
      const org = await createLlc(owner.token);
      const fileId = await t.upload(owner.token);
      await t.http().post('/api/v1/partner/organizations/current/documents').set(inOrg(owner.token, org.id))
        .send({ documentTypeCode: 'org_inn_certificate', fileId }).expect(201);
      await invite(owner.token, org.id, DISPATCHER, 'dispatcher').expect(201);
      const dispatcher = await acceptAll(DISPATCHER);
      const stranger = await t.login(STRANGER);

      await t.http().get(`/api/v1/files/${fileId}/content`).set(bearer(owner.token)).expect(200);
      await t.http().get(`/api/v1/files/${fileId}/content`).set(bearer(dispatcher)).expect(404);
      await t.http().get(`/api/v1/files/${fileId}/content`).set(bearer(stranger.token)).expect(404);
      const moderator = await t.adminLogin('mod@kovsh.test', 'moderator');
      const finance = await t.adminLogin('fin@kovsh.test', 'finance');
      await t.http().get(`/api/v1/admin/files/${fileId}/content`).set(bearer(moderator)).expect(200);
      await t.http().get(`/api/v1/admin/files/${fileId}/content`).set(bearer(finance)).expect(403);
    });
  });

  describe('Сотрудники и роли', () => {
    it('приглашают только руководители; руководителя назначает только главный владелец (Р-2, Р-11)', async () => {
      const owner = await t.login(OWNER);
      const org = await createLlc(owner.token);
      await invite(owner.token, org.id, MANAGER, 'manager').expect(201);
      const manager = await acceptAll(MANAGER);
      await invite(manager, org.id, DISPATCHER, 'dispatcher').expect(201);
      const dispatcher = await acceptAll(DISPATCHER);

      const mgrByMgr = await invite(manager, org.id, STRANGER, 'manager').expect(403);
      expect(mgrByMgr.body.code).toBe('FORBIDDEN');
      await invite(dispatcher, org.id, STRANGER, 'operator').expect(403);

      const list = await t.http().get('/api/v1/partner/members').set(inOrg(dispatcher, org.id)).expect(200);
      expect(list.body.map((m: { role: string }) => m.role).sort()).toEqual(['dispatcher', 'manager', 'owner']);
    });

    it('главного владельца нельзя отвязать; руководителями управляет только главный владелец', async () => {
      const owner = await t.login(OWNER);
      const org = await createLlc(owner.token);
      await invite(owner.token, org.id, MANAGER, 'manager').expect(201);
      const manager = await acceptAll(MANAGER);
      await invite(owner.token, org.id, DISPATCHER, 'manager').expect(201);
      await acceptAll(DISPATCHER);
      const members = (await t.http().get('/api/v1/partner/members').set(inOrg(owner.token, org.id))).body as { id: string; role: string; phone: string }[];
      const ownerRow = members.find((m) => m.role === 'owner');
      const otherManager = members.find((m) => m.phone === DISPATCHER);

      await t.http().post(`/api/v1/partner/members/${ownerRow?.id}/detach`).set(inOrg(manager, org.id)).expect(403);
      await t.http().post(`/api/v1/partner/members/${otherManager?.id}/block`).set(inOrg(manager, org.id)).expect(403);
      await t.http().post(`/api/v1/partner/members/${otherManager?.id}/block`).set(inOrg(owner.token, org.id)).expect(201);
      const leave = await t.http().post(`/api/v1/partner/memberships/${org.id}/leave`).set(bearer(owner.token)).expect(403);
      expect(leave.body.message).toMatch(/поддержку/);
    });

    it('машинист — только в одной компании (П-10), в том числе при одновременных приглашениях', async () => {
      const a = await t.login(OWNER);
      const b = await t.login(OWNER_B);
      const orgA = await createLlc(a.token, 'ООО А');
      const orgB = await createLlc(b.token, 'ООО Б');
      await invite(a.token, orgA.id, OPERATOR, 'operator').expect(201);
      await invite(b.token, orgB.id, OPERATOR, 'operator').expect(201);
      const { token } = await t.login(OPERATOR);
      const inv = (await t.http().get('/api/v1/partner/invitations').set(bearer(token))).body as { memberId: string; orgId: string }[];
      const invA = inv.find((i) => i.orgId === orgA.id);
      const invB = inv.find((i) => i.orgId === orgB.id);
      await t.http().post(`/api/v1/partner/invitations/${invA?.memberId}/accept`).set(bearer(token)).expect(204);
      const second = await t.http().post(`/api/v1/partner/invitations/${invB?.memberId}/accept`).set(bearer(token)).expect(409);
      expect(second.body.code).toBe('OPERATOR_IN_OTHER_COMPANY');

      const again = await invite(b.token, orgB.id, OPERATOR, 'operator');
      expect(again.status).toBe(409);
    });

    it('диспетчер может работать в нескольких компаниях, данные разделены (Р-13)', async () => {
      const OPERATOR = freshPhone();
      const a = await t.login(OWNER);
      const b = await t.login(OWNER_B);
      const orgA = await createLlc(a.token, 'ООО А');
      const orgB = await createLlc(b.token, 'ООО Б');
      await invite(a.token, orgA.id, DISPATCHER, 'dispatcher').expect(201);
      await invite(b.token, orgB.id, DISPATCHER, 'dispatcher').expect(201);
      await invite(b.token, orgB.id, OPERATOR, 'operator').expect(201);
      const dispatcher = await acceptAll(DISPATCHER);

      const memberships = await t.http().get('/api/v1/partner/memberships').set(bearer(dispatcher)).expect(200);
      expect(memberships.body.map((m: { orgId: string }) => m.orgId)).toEqual(expect.arrayContaining([orgA.id, orgB.id]));
      const listA = await t.http().get('/api/v1/partner/members').set(inOrg(dispatcher, orgA.id)).expect(200);
      expect(listA.body.some((m: { phone: string }) => m.phone === OPERATOR)).toBe(false);
      const listB = await t.http().get('/api/v1/partner/members').set(inOrg(dispatcher, orgB.id)).expect(200);
      expect(listB.body.some((m: { phone: string }) => m.phone === OPERATOR)).toBe(true);
    });

    it('ИП-одиночка может работать машинистом сам (П-13)', async () => {
      const { token } = await t.login(OWNER);
      const n = seed++;
      const org = (await t.http().post('/api/v1/partner/organizations').set(bearer(token)).send({
        kind: 'partner', legalForm: 'ip', name: 'ИП Иванов', representativeName: 'Иванов Иван', inn: innIp(n), ogrn: ogrnIp(n),
        legalAddress: 'МО, Химки', email: 'ip@test.ru', contactPhone: '+79160000099',
      }).expect(201)).body;
      const me = (await t.http().get('/api/v1/partner/members').set(inOrg(token, org.id))).body[0];
      const res = await t.http().patch(`/api/v1/partner/members/${me.id}/can-operate`).set(inOrg(token, org.id)).send({ canOperate: true }).expect(200);
      expect(res.body).toMatchObject({ role: 'owner', canOperate: true });
      const view = await t.http().get('/api/v1/partner/organizations/current').set(inOrg(token, org.id)).expect(200);
      // У ИП нет документа о полномочиях руководителя.
      expect(view.body.documents.map((d: { code: string }) => d.code)).toEqual(['org_registration_record', 'org_inn_certificate']);
    });

    it('машинист сам прекращает сотрудничество; аккаунт сохраняется (Р-15)', async () => {
      const OPERATOR = freshPhone();
      const owner = await t.login(OWNER);
      const org = await createLlc(owner.token);
      await invite(owner.token, org.id, OPERATOR, 'operator').expect(201);
      const op = await acceptAll(OPERATOR);
      await t.http().post(`/api/v1/partner/memberships/${org.id}/leave`).set(bearer(op)).expect(204);
      await t.http().get('/api/v1/partner/organizations/current').set(inOrg(op, org.id)).expect(404);
      await t.http().get('/api/v1/me').set(bearer(op)).expect(200);
    });

    it('документы машиниста и его проверка (В-32)', async () => {
      const OPERATOR = freshPhone();
      const owner = await t.login(OWNER);
      const org = await createLlc(owner.token);
      await invite(owner.token, org.id, OPERATOR, 'operator').expect(201);
      const op = await acceptAll(OPERATOR);
      const me = (await t.http().get('/api/v1/partner/members').set(inOrg(owner.token, org.id))).body.find((m: { phone: string }) => m.phone === OPERATOR);
      // Машинист узнаёт свою запись сотрудника из списка компаний — без доступа к списку сотрудников (С-5, С-6).
      const own = (await t.http().get('/api/v1/partner/memberships').set(bearer(op)).expect(200)).body.find((x: { orgId: string }) => x.orgId === org.id);
      expect(own.memberId).toBe(me.id);
      const fileId = await t.upload(op);
      await t.http().post(`/api/v1/partner/members/${me.id}/documents`).set(inOrg(op, org.id)).send({ documentTypeCode: 'operator_passport', fileId }).expect(201);
      let row = await pool.query('SELECT operator_verification FROM organization_members WHERE id = $1', [me.id]);
      expect(row.rows[0].operator_verification).toBe('pending');

      const moderator = await t.adminLogin('mod@kovsh.test', 'moderator');
      const queue = await t.http().get('/api/v1/admin/documents').set(bearer(moderator)).expect(200);
      const doc = queue.body.find((d: { ownerId: string }) => d.ownerId === me.id);
      await t.http().post(`/api/v1/admin/documents/${doc.id}/reject`).set(bearer(moderator)).send({ reason: 'Нечитаемо' }).expect(200);
      row = await pool.query('SELECT operator_verification FROM organization_members WHERE id = $1', [me.id]);
      expect(row.rows[0].operator_verification).toBe('rejected');
    });
  });

  describe('Администрирование', () => {
    it('передача главного владения только через поддержку (Р-12)', async () => {
      const owner = await t.login(OWNER);
      const org = await createLlc(owner.token);
      const support = await t.adminLogin('sup@kovsh.test', 'support');
      const basis = (await t.http().post('/api/v1/files').set(bearer(owner.token)).attach('file', Buffer.from('%PDF-1.4 x'), { filename: 'a.pdf', contentType: 'application/pdf' })).body.id;
      await t.http().post(`/api/v1/admin/organizations/${org.id}/transfer-ownership`).set(bearer(support))
        .send({ newOwnerPhone: OWNER_B, reason: 'Смена директора', basisFileIds: [basis] }).expect(200);
      const members = await pool.query('SELECT u.phone, m.role FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 ORDER BY u.phone', [org.id]);
      expect(members.rows).toEqual([{ phone: OWNER, role: 'manager' }, { phone: OWNER_B, role: 'owner' }]);
      const hist = await pool.query('SELECT reason FROM organization_ownership_history WHERE org_id = $1', [org.id]);
      expect(hist.rows).toEqual([{ reason: 'Смена директора' }]);
    });

    it('блокировка пользователя сразу отзывает его сессии', async () => {
      const victim = await t.login(STRANGER);
      const support = await t.adminLogin('sup@kovsh.test', 'support');
      await t.http().post(`/api/v1/admin/users/${victim.userId}/block`).set(bearer(support)).send({ reason: 'Мошенничество' }).expect(200);
      await t.http().get('/api/v1/me').set(bearer(victim.token)).expect(403);
      await t.http().post(`/api/v1/admin/users/${victim.userId}/unblock`).set(bearer(support)).expect(200);
    });

    it('вход администратора: неверный пароль; 2FA обязательна и без неё работать нельзя (С-9)', async () => {
      await app.get(AdminAuthService).createAdmin({ email: 'new@kovsh.test', fullName: 'Новый', role: 'moderator', password: 'very-strong-password-123' }, null);
      await t.http().post('/api/v1/admin/auth/login').send({ email: 'new@kovsh.test', password: 'wrong-password' }).expect(401);
      const first = await t.http().post('/api/v1/admin/auth/login').send({ email: 'new@kovsh.test', password: 'very-strong-password-123' }).expect(200);
      expect(first.body.mustEnrollTotp).toBe(true);
      const blocked = await t.http().get('/api/v1/admin/organizations').set(bearer(first.body.accessToken)).expect(403);
      expect(blocked.body.code).toBe('TOTP_ENROLLMENT_REQUIRED');
      await t.http().get('/api/v1/admin/auth/me').set(bearer(first.body.accessToken)).expect(200);

      const setup = await t.http().post('/api/v1/admin/auth/2fa/setup').set(bearer(first.body.accessToken)).expect(201);
      await t.http().post('/api/v1/admin/auth/2fa/confirm').set(bearer(first.body.accessToken)).send({ code: authenticator.generate(setup.body.secret) }).expect(204);
      await t.http().get('/api/v1/admin/organizations').set(bearer(first.body.accessToken)).expect(200);
      await t.http().post('/api/v1/admin/auth/2fa/setup').set(bearer(first.body.accessToken)).expect(409);

      const noCode = await t.http().post('/api/v1/admin/auth/login').send({ email: 'new@kovsh.test', password: 'very-strong-password-123' }).expect(401);
      expect(noCode.body.code).toBe('TOTP_REQUIRED');
      const ok = await t.http().post('/api/v1/admin/auth/login')
        .send({ email: 'new@kovsh.test', password: 'very-strong-password-123', totpCode: authenticator.generate(setup.body.secret) }).expect(200);
      expect(ok.body.mustEnrollTotp).toBe(false);
    });

    it('токен приложения не подходит для админки и наоборот', async () => {
      const user = await t.login(STRANGER);
      await t.http().get('/api/v1/admin/organizations').set(bearer(user.token)).expect(401);
      const admin = await t.adminLogin('root@kovsh.test', 'superadmin');
      await t.http().get('/api/v1/me').set(bearer(admin)).expect(401);
    });
  });
});
