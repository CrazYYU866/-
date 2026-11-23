import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { authenticator } from 'otplib';
import { AdminAuthService } from '../admin/admin-auth.service';
import { AppModule } from '../app.module';
import { FieldCipher } from '../common/crypto/field-cipher';
import { DB, type Database } from '../database/database.module';
import { FilesService } from '../files/files.service';
import { JobsService } from '../jobs/jobs.service';
import { NotificationsService } from '../comms/notifications.service';
import { ChatService } from '../comms/chat.service';
import { RatingsService } from '../comms/ratings.service';
import { TrackingService } from '../comms/tracking.service';
import { AssignmentService } from '../orders/assignment.service';
import { MatchingService } from '../orders/matching.service';
import { OperatorService } from '../orders/operator.service';
import { OrdersService } from '../orders/orders.service';
import type { OrgContext } from '../organizations/org-context.guard';
import { PaymentsService } from '../payments/payments.service';
import { PricingService } from '../pricing/pricing.service';
import { UsersService } from '../users/users.service';

/**
 * ДЕМО-ДАННЫЕ для показа (не для production): администраторы, компании, техника, машинисты, заказы в разных статусах.
 * Приблизительные границы регионов и тариф доставки 100 ₽/км (пример из ТЗ) — только для демонстрации, помечены «ДЕМО».
 */
const DEMO_PASSWORD = 'Demo-Kovsh-2026!';
const DEMO_TOTP = 'KOVSHDEMOKOVSHDEMO2026AB';
const PDF = Buffer.from('%PDF-1.4\n% demo document\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

const mskDate = (days: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date(Date.now() + days * 86_400_000));
const box = (w: number, s: number, e: number, n: number) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') throw new Error('Демо-данные нельзя загружать в production');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const db = app.get<Database>(DB);
  const users = app.get(UsersService);
  const cipher = app.get(FieldCipher);
  const files = app.get(FilesService);
  const jobs = app.get(JobsService);
  const pricing = app.get(PricingService);
  const orders = app.get(OrdersService);
  const matching = app.get(MatchingService);
  const assignment = app.get(AssignmentService);
  const operator = app.get(OperatorService);
  const payments = app.get(PaymentsService);
  const chat = app.get(ChatService);
  const tracking = app.get(TrackingService);
  const ratings = app.get(RatingsService);
  const q = <T extends Record<string, unknown>>(s: ReturnType<typeof sql>) => db.execute<T>(s).then((r) => r.rows);

  const exists = await q<{ id: string }>(sql`SELECT id FROM admin_users WHERE email = 'admin@demo.kovsh'`);
  if (exists[0]) {
    console.log('Демо-данные уже загружены.');
    await app.close();
    return;
  }

  // ── Администраторы (2FA обязательна — С-9; общий демо-ключ) ──────────────
  const adminAuth = app.get(AdminAuthService);
  for (const [email, fullName, role] of [
    ['admin@demo.kovsh', 'Анна Главная', 'superadmin'], ['support@demo.kovsh', 'Олег Поддержкин', 'support'],
    ['finance@demo.kovsh', 'Мария Финансова', 'finance'], ['moderator@demo.kovsh', 'Павел Проверкин', 'moderator'],
  ] as const) {
    const a = await adminAuth.createAdmin({ email, fullName, role, password: DEMO_PASSWORD }, null);
    await db.execute(sql`UPDATE admin_users SET totp_secret_enc = ${cipher.encrypt(DEMO_TOTP)}, totp_enabled = true WHERE id = ${a.id}`);
  }

  // ── ДЕМО-границы и ДЕМО-тариф доставки ──────────────────────────────────
  const regions = Object.fromEntries((await q<{ id: string; code: string }>(sql`SELECT id, code FROM regions`)).map((r) => [r.code, r.id]));
  await db.execute(sql`INSERT INTO service_zones (region_id, name, area) VALUES
    (${regions['moscow']}, 'ДЕМО — приблизительные границы Москвы', ST_Multi(ST_GeomFromGeoJSON(${JSON.stringify(box(37.30, 55.55, 37.95, 55.92))}))::geography),
    (${regions['moscow_oblast']}, 'ДЕМО — приблизительные границы МО', ST_Multi(ST_GeomFromGeoJSON(${JSON.stringify(box(35.1, 54.2, 40.2, 56.95))}))::geography)`);
  const leaves = await q<{ id: string }>(sql`SELECT c.id FROM equipment_categories c WHERE NOT EXISTS (SELECT 1 FROM equipment_categories x WHERE x.parent_id = c.id)`);
  for (const l of leaves) {
    for (const r of Object.values(regions)) {
      await db.execute(sql`INSERT INTO tariffs (category_id, region_id, kind, price_kopecks, valid_from, reason)
        VALUES (${l.id}, ${r}, 'delivery_km', 10000, now() - interval '1 day', 'ДЕМО: пример из ТЗ (100 ₽/км), не утверждён')`);
    }
  }

  const cat = async (slug: string) => (await q<{ id: string }>(sql`SELECT id FROM equipment_categories WHERE slug = ${slug}`))[0]?.id as string;

  // ── Компании ─────────────────────────────────────────────────────────────
  type Member = { userId: string; memberId: string };
  interface Company { orgId: string; owner: Member; staff: Record<string, Member>; units: Record<string, string> }
  async function person(phone: string, name: string) {
    const { user } = await users.findOrCreateByPhone(phone);
    await users.updateProfile(user.id, name);
    return user.id;
  }
  async function company(input: { name: string; kind?: 'partner' | 'agent'; legalForm: 'llc' | 'ip'; inn: string; ogrn: string; status?: string; owner: [string, string]; ownerOperates?: boolean; staff?: [string, string, string][] }): Promise<Company> {
    const ownerId = await person(input.owner[0], input.owner[1]);
    const org = (await q<{ id: string }>(sql`
      INSERT INTO organizations (kind, legal_form, name, representative_name, inn, ogrn, legal_address, email, contact_phone, status, verified_at, created_by)
      VALUES (${input.kind ?? 'partner'}, ${input.legalForm}, ${input.name}, ${input.owner[1]}, ${input.inn}, ${input.ogrn}, 'Москва, ул. Демонстрационная, 1',
        'demo@kovsh.test', ${input.owner[0]}, ${input.status ?? 'verified'}, ${input.status === 'pending_review' ? null : sql`now()`}, ${ownerId}) RETURNING id`))[0]?.id as string;
    const om = (await q<{ id: string }>(sql`INSERT INTO organization_members (org_id, user_id, role, can_operate, status, joined_at, operator_verification)
      VALUES (${org}, ${ownerId}, 'owner', ${input.ownerOperates ?? false}, 'active', now(), ${input.ownerOperates ? 'approved' : 'not_submitted'}) RETURNING id`))[0]?.id as string;
    await db.execute(sql`INSERT INTO organization_status_history (org_id, to_status, actor_user_id) VALUES (${org}, ${input.status ?? 'verified'}, ${ownerId})`);
    await db.execute(sql`INSERT INTO organization_bank_accounts (org_id, bik, account_number_enc, account_number_last4, correspondent_account, bank_name, created_by)
      VALUES (${org}, '044525225', ${cipher.encrypt('40702810900000000001')}, '0001', '30101810400000000225', 'ДЕМО-банк', ${ownerId})`);
    const staff: Record<string, Member> = {};
    for (const [phone, name, role] of input.staff ?? []) {
      const uid = await person(phone, name);
      const mid = (await q<{ id: string }>(sql`INSERT INTO organization_members (org_id, user_id, role, can_operate, status, joined_at, operator_verification)
        VALUES (${org}, ${uid}, ${role}, ${role === 'operator'}, 'active', now(), ${role === 'operator' ? 'approved' : 'not_submitted'}) RETURNING id`))[0]?.id as string;
      staff[phone] = { userId: uid, memberId: mid };
    }
    return { orgId: org, owner: { userId: ownerId, memberId: om }, staff, units: {} };
  }
  async function unit(c: Company, slug: string, brand: string, model: string, reg: string, attrs: Record<string, unknown>, lat: number, lng: number, address: string, status = 'approved') {
    const id = (await q<{ id: string }>(sql`
      INSERT INTO equipment_units (org_id, category_id, brand, model, year, reg_number, attributes, base_point, base_address, work_radius_km, allow_beyond_radius, is_online, verification_status, verified_at, created_by)
      VALUES (${c.orgId}, ${await cat(slug)}, ${brand}, ${model}, 2021, ${reg}, ${JSON.stringify(attrs)}::jsonb, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
        ${address}, 60, true, ${status === 'approved'}, ${status}, ${status === 'approved' ? sql`now()` : null}, ${c.owner.userId}) RETURNING id`))[0]?.id as string;
    await db.execute(sql`INSERT INTO equipment_unit_status_history (unit_id, to_status) VALUES (${id}, ${status})`);
    c.units[slug] = id;
    return id;
  }
  const doc = async (ownerType: string, ownerId: string, code: string, userId: string, status = 'approved') => {
    const f = await files.upload(PDF, 'application/pdf', `${code}.pdf`, { userId });
    await db.execute(sql`INSERT INTO documents (owner_type, owner_id, document_type_id, file_id, status, uploaded_by)
      SELECT ${ownerType}, ${ownerId}, id, ${f.id}, ${status}, ${userId} FROM document_types WHERE code = ${code}`);
  };

  const stp = await company({ name: 'ООО «СтройТехПарк»', legalForm: 'llc', inn: '7707083893', ogrn: '1027700132195', owner: ['+79000000101', 'Сергей Владельцев'],
    staff: [['+79000000102', 'Дарья Диспетчерова', 'dispatcher'], ['+79000000103', 'Алексей Машинистов', 'operator'], ['+79000000104', 'Виктор Ковшов', 'operator']] });
  await unit(stp, 'mini_excavator', 'JCB', '8030 ZTS', 'А123ВС777', { operating_weight: 3.2, digging_depth: 3.5, undercarriage: 'Гусеничная', has_hydraulic_hammer: false }, 55.66, 37.62, 'Москва, Варшавское ш., 120');
  await unit(stp, 'backhoe_loader', 'CAT', '428F2', 'В456ЕК777', { operating_weight: 8.4, digging_depth: 4.3, undercarriage: 'Колёсная', has_hydraulic_hammer: true }, 55.67, 37.60, 'Москва, Варшавское ш., 120');
  await unit(stp, 'dump_truck_10_20', 'КАМАЗ', '65115', 'Е789КХ799', { load_capacity: 15, body_volume: 12, axles: 3 }, 55.66, 37.63, 'Москва, Варшавское ш., 120');

  const petrov = await company({ name: 'ИП Петров Андрей Викторович', legalForm: 'ip', inn: '500100732259', ogrn: '304500116000157', owner: ['+79000000201', 'Андрей Петров'], ownerOperates: true });
  await unit(petrov, 'crane_upto_25', 'Галичанин', 'КС-55713', 'О321РТ750', { load_capacity: 25, max_lift_height: 28, boom_length: 28 }, 55.89, 37.43, 'МО, Химки, ул. Заводская, 3');

  const podem = await company({ name: 'ООО «Подъём»', legalForm: 'llc', inn: '7736050003', ogrn: '1027700070518', owner: ['+79000000301', 'Ирина Высоцкая'],
    staff: [['+79000000302', 'Николай Стрелов', 'operator']] });
  await unit(podem, 'aerial_28_32', 'Socage', 'DA328', 'М555ММ777', { working_height: 30, boom_reach: 18, basket_capacity: 250 }, 55.80, 37.72, 'Москва, Щёлковское ш., 40');
  await unit(podem, 'manipulator_7_10', 'HINO', '500 + Kanglim', 'Т777ТТ777', { vehicle_load_capacity: 10, crane_load_capacity: 7, boom_reach: 20 }, 55.79, 37.71, 'Москва, Щёлковское ш., 40');

  // На проверке — для показа очереди модерации.
  const newbie = await company({ name: 'ООО «Новые Колёса»', legalForm: 'llc', inn: '7702070139', ogrn: '1027739609391', status: 'pending_review', owner: ['+79000000701', 'Глеб Новиков'] });
  await db.execute(sql`UPDATE organizations SET submitted_at = now() WHERE id = ${newbie.orgId}`);
  for (const code of ['org_registration_record', 'org_inn_certificate', 'org_director_authority']) await doc('organization', newbie.orgId, code, newbie.owner.userId, 'uploaded');
  const pendingUnit = await unit(stp, 'front_loader', 'SDLG', 'L956F', 'Х111ХХ777', { load_capacity: 5, bucket_volume: 3 }, 55.66, 37.62, 'Москва, Варшавское ш., 120', 'pending');
  await db.execute(sql`UPDATE equipment_units SET submitted_at = now() WHERE id = ${pendingUnit}`);
  await doc('equipment', pendingUnit, 'equipment_ownership', stp.owner.userId, 'uploaded');

  const agent = await company({ name: 'ИП Сидорова Елена (диспетчер)', kind: 'agent', legalForm: 'ip', inn: '500100732259', ogrn: '304500116000157', owner: ['+79000000401', 'Елена Сидорова'] });

  // ── Заказчики ────────────────────────────────────────────────────────────
  const ivan = await person('+79000000501', 'Иван Заказчиков');
  const buhPhone = '+79000000601';
  const legalOwner = await person(buhPhone, 'Татьяна Городская');
  const legalOrg = (await q<{ id: string }>(sql`INSERT INTO customer_legal_profiles (user_id, inn, kpp, name, legal_address, email)
    VALUES (${legalOwner}, '7728168971', '772801001', 'ООО «ГородСтрой»', 'Москва, Ленинский пр-т, 50', 'buh@gorodstroy.test') RETURNING id`))[0]?.id as string;
  await db.execute(sql`INSERT INTO customer_org_members (profile_id, user_id, role, status) VALUES (${legalOrg}, ${legalOwner}, 'owner', 'active')`);

  // ── Заказы через настоящую бизнес-логику ────────────────────────────────
  const ctx = (c: Company, m: Member, role: OrgContext['role'], canOperate = false): OrgContext =>
    ({ orgId: c.orgId, memberId: m.memberId, role, canOperate, orgStatus: 'verified', orgKind: 'partner' });
  const only = async (c: Company) => db.execute(sql`UPDATE equipment_units SET is_online = (org_id = ${c.orgId} AND verification_status = 'approved')`);
  const site = { lat: 55.7520, lng: 37.6175, address: 'Москва, ул. Варварка, 14 (стройплощадка)' };
  async function place(customer: string, slug: string, days: number, payer: { kind: 'individual' } | { kind: 'legal'; legalProfileId: string } = { kind: 'individual' }, s = site) {
    const quote = await pricing.quote(customer, { categoryId: await cat(slug), site: s, requirements: {}, days: [{ date: mskDate(days), startTime: '08:00', hours: 8 }] });
    const { id } = await orders.create(customer, quote.id, 'Въезд с переулка, у шлагбаума позвонить', payer);
    await jobs.runDue();
    return id;
  }
  async function acceptAndPay(c: Company, orderId: string, customer: string) {
    const offer = (await q<{ id: string }>(sql`SELECT id FROM order_offers WHERE order_id = ${orderId} AND status = 'pending'`))[0];
    if (!offer) throw new Error('Нет предложения');
    await matching.accept(offer.id, ctx(c, c.owner, 'owner'), c.owner.userId);
    const p = await payments.create(customer, orderId);
    await payments.devComplete(String(p.confirmationUrl).split('/').pop() as string, 'succeeded');
  }
  const ev = (status: 'en_route' | 'arrived' | 'in_progress' | 'finished', minutesAgo = 0) =>
    ({ clientEventId: randomUUID(), status, recordedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString() });

  // 1. Завершённый заказ с оценкой.
  await only(stp);
  const o1 = await place(ivan, 'mini_excavator', 1);
  await acceptAndPay(stp, o1, ivan);
  const op1 = stp.staff['+79000000103'] as Member;
  await assignment.assignOperator(ctx(stp, stp.owner, 'owner'), stp.owner.userId, o1, op1.memberId);
  const opCtx = ctx(stp, op1, 'operator', true);
  await chat.send(o1, ivan, 'order', 'Здравствуйте! Подъезд со стороны Варварки, у шлагбаума позвоните.');
  await chat.send(o1, op1.userId, 'order', 'Добрый день, понял. Буду к 8:00.');
  await operator.applyEvents(opCtx, op1.userId, o1, { events: [ev('en_route', 50)] });
  await tracking.ingest(opCtx, op1.userId, { orderId: o1, points: [
    { lat: 55.700, lng: 37.620, accuracy: 8, recordedAt: new Date(Date.now() - 40 * 60_000).toISOString() },
    { lat: 55.730, lng: 37.619, accuracy: 8, recordedAt: new Date(Date.now() - 25 * 60_000).toISOString() },
  ] });
  await operator.applyEvents(opCtx, op1.userId, o1, { events: [ev('arrived', 20), ev('in_progress', 15), ev('finished', 1)] });
  await orders.confirmCompletion(ivan, o1);
  await ratings.rateByCustomer(o1, ivan, { stars: 5, text: 'Приехал вовремя, аккуратно сделал траншею.' });
  await ratings.rateByPartner(o1, stp.owner.userId, { stars: 5 });

  // 2. Заказ в пути — живые координаты.
  await only(podem);
  const o2 = await place(legalOwner, 'aerial_28_32', 2, { kind: 'legal', legalProfileId: legalOrg });
  await acceptAndPay(podem, o2, legalOwner);
  const op2 = podem.staff['+79000000302'] as Member;
  await assignment.assignOperator(ctx(podem, podem.owner, 'owner'), podem.owner.userId, o2, op2.memberId);
  const op2Ctx = ctx(podem, op2, 'operator', true);
  await operator.applyEvents(op2Ctx, op2.userId, o2, { events: [ev('en_route', 10)] });
  await tracking.ingest(op2Ctx, op2.userId, { orderId: o2, points: [
    { lat: 55.790, lng: 37.700, accuracy: 10, recordedAt: new Date(Date.now() - 8 * 60_000).toISOString() },
    { lat: 55.775, lng: 37.670, accuracy: 10, recordedAt: new Date(Date.now() - 30_000).toISOString() },
  ] });
  await chat.send(o2, op2.userId, 'order', 'Выехал, буду минут через 20.');

  // 3. Отмена после оплаты — ждёт решения поддержки.
  await only(petrov);
  const o3 = await place(ivan, 'crane_upto_25', 3, { kind: 'individual' }, { lat: 55.86, lng: 37.45, address: 'МО, Химки, Ленинградское ш., 25' });
  await acceptAndPay(petrov, o3, ivan);
  await orders.cancelByCustomer(ivan, o3, 'Перенесли монтаж на следующий месяц');

  // 4. Идёт поиск исполнителя (предложение у СтройТехПарка, 40 секунд).
  await db.execute(sql`UPDATE equipment_units SET is_online = (verification_status = 'approved')`);
  await place(legalOwner, 'dump_truck_10_20', 4, { kind: 'legal', legalProfileId: legalOrg });

  // 5. Заявка независимого диспетчера ждёт подтверждения заказчиком по SMS-ссылке.
  const agentQuote = await pricing.quote(ivan, { categoryId: await cat('manipulator_7_10'), site, requirements: {}, days: [{ date: mskDate(5), startTime: '09:00', hours: 6 }] }, new Date(), agent.orgId);
  await orders.createForAgent(agent.orgId, agent.owner.userId, agentQuote.id, 'Разгрузка плит', 'http://localhost:3000');

  await app.get(NotificationsService).processPending(1000);

  console.log(`
════════════════════════════════════════════════════════════
 ДЕМО-ДАННЫЕ ЗАГРУЖЕНЫ (не для production)
════════════════════════════════════════════════════════════
 Админка (пароль у всех: ${DEMO_PASSWORD})
   admin@demo.kovsh — суперадминистратор
   support@demo.kovsh — поддержка
   finance@demo.kovsh — финансист
   moderator@demo.kovsh — модератор
 2FA: ключ ${DEMO_TOTP} — добавьте в приложение-аутентификатор
      (текущий код: ${authenticator.generate(DEMO_TOTP)})

 Приложения (вход по SMS; в тестовом режиме код пишется в лог сервера)
   +7 900 000-01-01  владелец ООО «СтройТехПарк»
   +7 900 000-01-02  диспетчер ООО «СтройТехПарк»
   +7 900 000-01-03  машинист ООО «СтройТехПарк»
   +7 900 000-02-01  ИП Петров (сам машинист)
   +7 900 000-03-01  владелец ООО «Подъём»;  +7 900 000-03-02 — машинист
   +7 900 000-04-01  независимый диспетчер
   +7 900 000-05-01  заказчик-физлицо
   +7 900 000-06-01  заказчик, руководитель ООО «ГородСтрой»
════════════════════════════════════════════════════════════`);
  await app.close();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
