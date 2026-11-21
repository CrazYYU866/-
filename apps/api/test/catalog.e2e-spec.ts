import type { INestApplication } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { createApp } from '../src/app.factory';
import { CatalogService } from '../src/catalog/catalog.service';
import { REDIS } from '../src/redis/redis.module';
import { resetTestDatabase } from './db';
import { innLegal, ogrnLegal, PDF, TestClient } from './helpers';

// Квадрат ~ 20×20 км вокруг центра Москвы — только для теста определения региона.
const TEST_ZONE = {
  type: 'Polygon',
  coordinates: [[[37.45, 55.65], [37.80, 55.65], [37.80, 55.85], [37.45, 55.85], [37.45, 55.65]]],
};
const CENTER = { lat: 55.7558, lng: 37.6173 };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);

interface Node { id: string; slug: string; name: string; isLeaf: boolean; children: Node[]; attributes: { key: string; required: boolean; inherited: boolean }[]; hourPriceKopecks?: number | null }
const flat = (nodes: Node[]): Node[] => nodes.flatMap((n) => [n, ...flat(n.children)]);

describe('Этап 4: каталог, тарифы, техника', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;
  let t: TestClient;
  let superadmin: string;
  let moderator: string;
  let moscowId: string;
  let oblastId: string;
  let seq = 0;
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const inOrg = (token: string, orgId: string) => ({ ...bearer(token), 'X-Org-Id': orgId });
  const slugId = async (slug: string) => (await pool.query('SELECT id FROM equipment_categories WHERE slug = $1', [slug])).rows[0].id as string;

  async function partnerWithOrg(verified = true) {
    seq++;
    const phone = `+7916200${String(seq).padStart(4, '0')}`;
    const { token } = await t.login(phone);
    const org = (await t.http().post('/api/v1/partner/organizations').set(bearer(token)).send({
      kind: 'partner', legalForm: 'llc', name: `ООО Техника ${seq}`, representativeName: 'Петров П.П.',
      inn: innLegal(3000 + seq), ogrn: ogrnLegal(3000 + seq), legalAddress: 'Москва, 1', email: 'a@b.ru', contactPhone: '+79160000099',
    }).expect(201)).body;
    if (verified) await pool.query("UPDATE organizations SET status = 'verified', verified_at = now() WHERE id = $1", [org.id]);
    return { token, orgId: org.id as string, phone };
  }

  const excavatorBody = async (extra: Record<string, unknown> = {}) => ({
    categoryId: await slugId('mini_excavator'), brand: 'JCB', model: '8030', year: 2021, regNumber: `${1000 + seq}АА77`,
    attributes: { operating_weight: 3.0, digging_depth: 3.1, undercarriage: 'Гусеничная', has_hydraulic_hammer: false },
    base: { ...CENTER, address: 'Москва, ул. Тверская, 1' }, workRadiusKm: 50, ...extra,
  });

  beforeAll(async () => {
    pool = await resetTestDatabase();
    app = await createApp();
    await app.init();
    redis = app.get(REDIS);
    t = new TestClient(app);
    superadmin = await t.adminLogin('root@kovsh.test', 'superadmin');
    moderator = await t.adminLogin('mod@kovsh.test', 'moderator');
    moscowId = (await pool.query("SELECT id FROM regions WHERE code = 'moscow'")).rows[0].id;
    oblastId = (await pool.query("SELECT id FROM regions WHERE code = 'moscow_oblast'")).rows[0].id;
  });
  beforeEach(async () => redis.flushdb());
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('Стартовый каталог', () => {
    it('6 групп, 27 видов техники, цены Москвы и области из списка заказчика', async () => {
      const res = await t.http().get(`/api/v1/catalog/categories?regionId=${moscowId}`).expect(200);
      const tree = res.body as Node[];
      expect(tree.map((n) => n.name)).toEqual([
        'Экскаваторная техника', 'Погрузочная техника', 'Самосвалы и грузовая техника',
        'Подъёмная техника', 'Дорожная и землеройная техника', 'Тракторы и транспортировка',
      ]);
      const leaves = flat(tree).filter((n) => n.isLeaf);
      expect(leaves).toHaveLength(27);
      const price = (slug: string) => leaves.find((l) => l.slug === slug)?.hourPriceKopecks;
      expect(price('mini_excavator')).toBe(250_000);
      expect(price('backhoe_loader_hammer')).toBe(350_000);
      expect(price('dump_truck_25_35')).toBe(275_000);
      expect(price('crane_50_60')).toBe(600_000);
      expect(price('aerial_from_40')).toBe(500_000);
      expect(price('tractor_mtz')).toBe(200_000);
      expect(price('lowbed_trailer')).toBe(500_000);
      const oblast = flat((await t.http().get(`/api/v1/catalog/categories?regionId=${oblastId}`)).body).find((n: Node) => n.slug === 'crane_32_40');
      expect(oblast?.hourPriceKopecks).toBe(450_000);
    });

    it('характеристики наследуются подкатегориями', async () => {
      const res = await t.http().get(`/api/v1/catalog/categories/${await slugId('crane_upto_25')}/attributes`).expect(200);
      expect(res.body.map((a: { key: string }) => a.key)).toEqual(['load_capacity', 'max_lift_height', 'boom_length', 'boom_reach', 'load_moment']);
      expect(res.body.every((a: { inherited: boolean }) => a.inherited)).toBe(true);
    });

    it('тарифы доставки не заданы: расчёт доставки не будет работать на выдуманных ценах', async () => {
      const catalog = app.get(CatalogService);
      await expect(catalog.effectiveTariff(await slugId('mini_excavator'), moscowId, 'delivery_km')).resolves.toBeNull();
    });
  });

  describe('Регион объекта по границам', () => {
    it('без загруженных границ регион не определяется', async () => {
      const res = await t.http().get(`/api/v1/catalog/regions/resolve?lat=${CENTER.lat}&lng=${CENTER.lng}`).expect(404);
      expect(res.body.code).toBe('REGION_NOT_FOUND');
    });

    it('после импорта GeoJSON точка внутри — Москва, снаружи — не обслуживается', async () => {
      await t.http().post(`/api/v1/admin/regions/${moscowId}/zones`).set(bearer(moderator)).send({ name: 'x', geojson: TEST_ZONE }).expect(403);
      const imp = await t.http().post(`/api/v1/admin/regions/${moscowId}/zones`).set(bearer(superadmin))
        .send({ name: 'Тестовая зона', geojson: { type: 'Feature', properties: {}, geometry: TEST_ZONE } }).expect(201);
      expect(imp.body.areaKm2).toBeGreaterThan(400);
      const inside = await t.http().get(`/api/v1/catalog/regions/resolve?lat=${CENTER.lat}&lng=${CENTER.lng}`).expect(200);
      expect(inside.body.code).toBe('moscow');
      await t.http().get('/api/v1/catalog/regions/resolve?lat=56.5&lng=38.5').expect(404);
      const bad = await t.http().post(`/api/v1/admin/regions/${moscowId}/zones`).set(bearer(superadmin)).send({ name: 'x', geojson: { type: 'Point', coordinates: [1, 2] } }).expect(400);
      expect(bad.body.code).toBe('INVALID_GEOMETRY');
    });
  });

  describe('Управление каталогом без изменения кода', () => {
    it('новая категория «Буровая установка»: характеристики, тарифы, показ заказчикам', async () => {
      const group = await t.http().post('/api/v1/admin/catalog/categories').set(bearer(superadmin))
        .send({ slug: 'drilling', name: 'Буровая техника', sort: 70 }).expect(201);
      const leaf = await t.http().post('/api/v1/admin/catalog/categories').set(bearer(superadmin))
        .send({ slug: 'drilling_rig', name: 'Буровая установка', parentId: group.body.id }).expect(201);
      await t.http().post(`/api/v1/admin/catalog/categories/${group.body.id}/attributes`).set(bearer(superadmin))
        .send({ key: 'drilling_depth', label: 'Глубина бурения', type: 'number', unitCode: 'm', required: true, filterable: true }).expect(201);
      await t.http().post(`/api/v1/admin/catalog/categories/${leaf.body.id}/attributes`).set(bearer(superadmin))
        .send({ key: 'drill_type', label: 'Тип бурения', type: 'enum', options: ['Шнековое', 'Колонковое'] }).expect(201);
      await t.http().post(`/api/v1/admin/catalog/categories/${leaf.body.id}/attributes`).set(bearer(superadmin))
        .send({ key: 'bad', label: 'Список без вариантов', type: 'enum' }).expect(400);
      await t.http().post('/api/v1/admin/tariffs').set(bearer(superadmin))
        .send({ categoryId: leaf.body.id, regionId: moscowId, kind: 'rent_hour', priceKopecks: 400_000, reason: 'Запуск' }).expect(201);
      await t.http().post('/api/v1/admin/tariffs').set(bearer(superadmin))
        .send({ categoryId: leaf.body.id, regionId: moscowId, kind: 'delivery_km', priceKopecks: 10_000 }).expect(201);

      const tree = flat((await t.http().get(`/api/v1/catalog/categories?regionId=${moscowId}`)).body);
      const rig = tree.find((n) => n.slug === 'drilling_rig');
      expect(rig).toMatchObject({ isLeaf: true, hourPriceKopecks: 400_000 });
      expect(rig?.attributes.map((a) => a.key)).toEqual(['drilling_depth', 'drill_type']);

      await t.http().patch(`/api/v1/admin/catalog/categories/${leaf.body.id}`).set(bearer(superadmin)).send({ visibleToCustomers: false }).expect(200);
      expect(flat((await t.http().get('/api/v1/catalog/categories')).body).some((n: Node) => n.slug === 'drilling_rig')).toBe(false);
      expect(flat((await t.http().get('/api/v1/catalog/categories?audience=partner')).body).some((n: Node) => n.slug === 'drilling_rig')).toBe(true);

      const del = await t.http().delete(`/api/v1/admin/catalog/categories/${leaf.body.id}`).set(bearer(superadmin)).expect(409);
      expect(del.body.code).toBe('CATEGORY_IN_USE');
      await t.http().post(`/api/v1/admin/catalog/categories/${leaf.body.id}/archive`).set(bearer(superadmin)).expect(200);
      expect(flat((await t.http().get('/api/v1/catalog/categories?audience=partner')).body).some((n: Node) => n.slug === 'drilling_rig')).toBe(false);

      const history = await t.http().get(`/api/v1/admin/catalog/history?entity=category&entityId=${leaf.body.id}`).set(bearer(moderator)).expect(200);
      expect(history.body.map((h: { action: string }) => h.action)).toEqual(['catalog.category.archive', 'catalog.category.update', 'catalog.category.create']);
    });

    it('изменять каталог и тарифы может только суперадминистратор', async () => {
      await t.http().post('/api/v1/admin/catalog/categories').set(bearer(moderator)).send({ slug: 'xx_cat', name: 'XX' }).expect(403);
      await t.http().post('/api/v1/admin/tariffs').set(bearer(moderator))
        .send({ categoryId: await slugId('mini_excavator'), regionId: moscowId, kind: 'rent_hour', priceKopecks: 1 }).expect(403);
      await t.http().get('/api/v1/admin/tariffs').set(bearer(moderator)).expect(200);
    });

    it('единицы измерения и удаление характеристики', async () => {
      await t.http().post('/api/v1/admin/catalog/units').set(bearer(superadmin)).send({ code: 'kw', label: 'кВт', name: 'киловатты' }).expect(201);
      const cat = await t.http().post('/api/v1/admin/catalog/categories').set(bearer(superadmin)).send({ slug: 'generators', name: 'Генераторы' }).expect(201);
      const attr = await t.http().post(`/api/v1/admin/catalog/categories/${cat.body.id}/attributes`).set(bearer(superadmin))
        .send({ key: 'power', label: 'Мощность', type: 'number', unitCode: 'kw' }).expect(201);
      const removed = await t.http().delete(`/api/v1/admin/catalog/attributes/${attr.body.id}`).set(bearer(superadmin)).expect(200);
      expect(removed.body.result).toBe('deleted');
    });
  });

  describe('Версии тарифов', () => {
    it('будущая версия не меняет текущую цену; действует с даты начала; запланированную можно отменить', async () => {
      const cat = await slugId('front_loader');
      const catalog = app.get(CatalogService);
      const future = new Date(Date.now() + 7 * 86_400_000);
      const created = await t.http().post('/api/v1/admin/tariffs').set(bearer(superadmin))
        .send({ categoryId: cat, regionId: moscowId, kind: 'rent_hour', priceKopecks: 320_000, validFrom: future.toISOString(), reason: 'Индексация' }).expect(201);

      expect((await catalog.effectiveTariff(cat, moscowId, 'rent_hour'))?.priceKopecks).toBe(300_000);
      expect((await catalog.effectiveTariff(cat, moscowId, 'rent_hour', new Date(future.getTime() + 1000)))?.priceKopecks).toBe(320_000);

      const list = await t.http().get(`/api/v1/admin/tariffs?categoryId=${cat}&regionId=${moscowId}&kind=rent_hour`).set(bearer(superadmin)).expect(200);
      expect(list.body.map((x: { state: string; priceKopecks: number }) => [x.state, x.priceKopecks])).toEqual([['scheduled', 320_000], ['current', 300_000]]);

      await t.http().post(`/api/v1/admin/tariffs/${created.body.id}/cancel`).set(bearer(superadmin)).expect(200);
      expect((await catalog.effectiveTariff(cat, moscowId, 'rent_hour', new Date(future.getTime() + 1000)))?.priceKopecks).toBe(300_000);

      const current = list.body.find((x: { state: string }) => x.state === 'current');
      await t.http().post(`/api/v1/admin/tariffs/${current.id}/cancel`).set(bearer(superadmin)).expect(409);
    });

    it('тариф нельзя изменить или удалить напрямую в БД', async () => {
      await expect(pool.query('UPDATE tariffs SET price_kopecks = 1')).rejects.toThrow(/создайте новую версию/);
      await expect(pool.query('DELETE FROM tariffs')).rejects.toThrow(/не удаляются/);
    });

    it('тариф подкатегории приоритетнее тарифа родителя; без своего — берётся родительский', async () => {
      const catalog = app.get(CatalogService);
      const group = await slugId('manipulators');
      const leaf = await slugId('manipulator_upto_5');
      await t.http().post('/api/v1/admin/tariffs').set(bearer(superadmin)).send({ categoryId: group, regionId: moscowId, kind: 'delivery_km', priceKopecks: 9_000 }).expect(201);
      expect((await catalog.effectiveTariff(leaf, moscowId, 'delivery_km'))?.priceKopecks).toBe(9_000);
      await t.http().post('/api/v1/admin/tariffs').set(bearer(superadmin)).send({ categoryId: leaf, regionId: moscowId, kind: 'delivery_km', priceKopecks: 8_000 }).expect(201);
      expect((await catalog.effectiveTariff(leaf, moscowId, 'delivery_km'))?.priceKopecks).toBe(8_000);
      expect(await catalog.effectiveTariff(leaf, oblastId, 'delivery_km')).toBeNull();
    });
  });

  describe('Карточка техники', () => {
    it('проверка характеристик и года выпуска', async () => {
      const { token, orgId } = await partnerWithOrg();
      const h = inOrg(token, orgId);
      const groupRes = await t.http().post('/api/v1/partner/equipment').set(h).send(await excavatorBody({ categoryId: await slugId('excavators') })).expect(400);
      expect(groupRes.body.code).toBe('CATEGORY_NOT_LEAF');
      const missing = await t.http().post('/api/v1/partner/equipment').set(h).send(await excavatorBody({ attributes: { digging_depth: 3 } })).expect(400);
      expect(missing.body).toMatchObject({ code: 'INVALID_ATTRIBUTES' });
      expect(missing.body.details).toEqual([{ key: 'operating_weight', message: 'обязательная характеристика «Эксплуатационная масса»' }]);
      const wrong = await t.http().post('/api/v1/partner/equipment').set(h)
        .send(await excavatorBody({ attributes: { operating_weight: 'три', undercarriage: 'Шагающая', foo: 1 } })).expect(400);
      expect(wrong.body.details.map((d: { key: string }) => d.key).sort()).toEqual(['foo', 'operating_weight', 'undercarriage']);
      const noYear = await t.http().post('/api/v1/partner/equipment').set(h).send(await excavatorBody({ year: null })).expect(400);
      expect(noYear.body.details[0].key).toBe('year');
      // У трала год выпуска необязателен (его нет в перечне характеристик заказчика).
      await t.http().post('/api/v1/partner/equipment').set(h).send({
        categoryId: await slugId('lowbed_trailer'), brand: 'ЧМЗАП', model: '9990', regNumber: null,
        attributes: { load_capacity: 40 }, base: { ...CENTER, address: 'Москва' }, workRadiusKm: 100,
      }).expect(201);
    });

    it('полный цикл: создание → документы → проверка → на линии; изменение госномера требует повторной проверки', async () => {
      const { token, orgId } = await partnerWithOrg();
      const h = inOrg(token, orgId);
      const unit = (await t.http().post('/api/v1/partner/equipment').set(h).send(await excavatorBody({ allowBeyondRadius: true })).expect(201)).body;
      expect(unit).toMatchObject({ verificationStatus: 'draft', isOnline: false, allowBeyondRadius: true, workRadiusKm: 50 });
      expect(unit.base.lat).toBeCloseTo(CENTER.lat, 5);

      const early = await t.http().post(`/api/v1/partner/equipment/${unit.id}/online`).set(h).expect(409);
      expect(early.body.code).toBe('UNIT_NOT_APPROVED');
      const incomplete = await t.http().post(`/api/v1/partner/equipment/${unit.id}/submit`).set(h).expect(422);
      expect(incomplete.body.details.missingDocuments).toEqual(['equipment_ownership']);

      const photo = await t.upload(token, JPEG, 'image/jpeg');
      await t.http().post(`/api/v1/partner/equipment/${unit.id}/photos`).set(h).send({ fileId: photo }).expect(201);
      const doc = await t.upload(token, PDF);
      await t.http().post(`/api/v1/partner/equipment/${unit.id}/documents`).set(h).send({ documentTypeCode: 'equipment_ownership', fileId: doc }).expect(201);
      await t.http().post(`/api/v1/partner/equipment/${unit.id}/submit`).set(h).expect(200);

      const queue = await t.http().get('/api/v1/admin/equipment').set(bearer(moderator)).expect(200);
      expect(queue.body.map((u: { id: string }) => u.id)).toContain(unit.id);
      const noDocReview = await t.http().post(`/api/v1/admin/equipment/${unit.id}/approve`).set(bearer(moderator)).expect(422);
      expect(noDocReview.body.code).toBe('UNIT_INCOMPLETE');
      const card = await t.http().get(`/api/v1/admin/equipment/${unit.id}`).set(bearer(moderator)).expect(200);
      await t.http().post(`/api/v1/admin/documents/${card.body.documentFiles[0].id}/approve`).set(bearer(moderator)).send({}).expect(200);
      await t.http().post(`/api/v1/admin/equipment/${unit.id}/approve`).set(bearer(moderator)).expect(200);

      const online = await t.http().post(`/api/v1/partner/equipment/${unit.id}/online`).set(h).expect(200);
      expect(online.body).toMatchObject({ verificationStatus: 'approved', isOnline: true, photos: [expect.objectContaining({ fileId: photo })] });

      const radius = await t.http().patch(`/api/v1/partner/equipment/${unit.id}`).set(h).send({ workRadiusKm: 80 }).expect(200);
      expect(radius.body).toMatchObject({ verificationStatus: 'approved', isOnline: true, workRadiusKm: 80, allowBeyondRadius: true, attributes: expect.objectContaining({ operating_weight: 3 }) });
      const reg = await t.http().patch(`/api/v1/partner/equipment/${unit.id}`).set(h).send({ regNumber: 'В777ВВ777' }).expect(200);
      expect(reg.body).toMatchObject({ verificationStatus: 'pending', isOnline: false, regNumber: 'В777ВВ777' });

      const history = await pool.query('SELECT to_status FROM equipment_unit_status_history WHERE unit_id = $1 ORDER BY id', [unit.id]);
      expect(history.rows.map((r) => r.to_status)).toEqual(['draft', 'pending', 'approved', 'pending']);
    });

    it('на линию нельзя, пока организация не подтверждена', async () => {
      const { token, orgId } = await partnerWithOrg(false);
      const unit = (await t.http().post('/api/v1/partner/equipment').set(inOrg(token, orgId)).send(await excavatorBody()).expect(201)).body;
      await pool.query("UPDATE equipment_units SET verification_status = 'approved' WHERE id = $1", [unit.id]);
      const res = await t.http().post(`/api/v1/partner/equipment/${unit.id}/online`).set(inOrg(token, orgId)).expect(409);
      expect(res.body.code).toBe('ORG_NOT_VERIFIED');
    });

    it('расписание и календарь занятости; брони одной техники не пересекаются', async () => {
      const { token, orgId } = await partnerWithOrg();
      const h = inOrg(token, orgId);
      const unit = (await t.http().post('/api/v1/partner/equipment').set(h).send(await excavatorBody()).expect(201)).body;
      await t.http().put(`/api/v1/partner/equipment/${unit.id}/schedule`).set(h)
        .send({ intervals: [{ weekday: 1, start: '08:00', end: '12:00' }, { weekday: 1, start: '11:00', end: '18:00' }] }).expect(400);
      const ok = await t.http().put(`/api/v1/partner/equipment/${unit.id}/schedule`).set(h)
        .send({ intervals: [{ weekday: 1, start: '08:00', end: '20:00' }, { weekday: 6, start: '09:00', end: '24:00' }] }).expect(200);
      expect(ok.body.schedule).toEqual([{ weekday: 1, start: '08:00', end: '20:00' }, { weekday: 6, start: '09:00', end: '24:00' }]);

      await pool.query("INSERT INTO unit_bookings (unit_id, period) VALUES ($1, tstzrange('2026-12-01 08:00+03', '2026-12-01 12:00+03'))", [unit.id]);
      await expect(pool.query("INSERT INTO unit_bookings (unit_id, period) VALUES ($1, tstzrange('2026-12-01 11:00+03', '2026-12-01 15:00+03'))", [unit.id]))
        .rejects.toThrow(/exclusion|unit_bookings/);
      const cal = await t.http().get(`/api/v1/partner/equipment/${unit.id}/calendar?from=2026-12-01T00:00:00%2B03:00&to=2026-12-02T00:00:00%2B03:00`).set(h).expect(200);
      expect(cal.body.bookings).toHaveLength(1);
      const archive = await t.http().delete(`/api/v1/partner/equipment/${unit.id}`).set(h).expect(409);
      expect(archive.body.message).toMatch(/предстоящие заказы/);
    });

    it('доступ: машинист не управляет техникой, чужая компания её не видит, госномер уникален', async () => {
      const a = await partnerWithOrg();
      const b = await partnerWithOrg();
      const body = await excavatorBody({ regNumber: 'Е123КХ199' });
      const unit = (await t.http().post('/api/v1/partner/equipment').set(inOrg(a.token, a.orgId)).send(body).expect(201)).body;
      await t.http().get(`/api/v1/partner/equipment/${unit.id}`).set(inOrg(b.token, b.orgId)).expect(404);
      const dup = await t.http().post('/api/v1/partner/equipment').set(inOrg(b.token, b.orgId)).send({ ...body, regNumber: 'е 123 кх 199' }).expect(409);
      expect(dup.body.message).toMatch(/госномером/);

      const opPhone = `+7916300${String(++seq).padStart(4, '0')}`;
      await t.http().post('/api/v1/partner/members').set(inOrg(a.token, a.orgId)).send({ phone: opPhone, role: 'operator' }).expect(201);
      const op = await t.login(opPhone);
      const inv = (await t.http().get('/api/v1/partner/invitations').set(bearer(op.token))).body;
      await t.http().post(`/api/v1/partner/invitations/${inv[0].memberId}/accept`).set(bearer(op.token)).expect(204);
      await t.http().get('/api/v1/partner/equipment').set(inOrg(op.token, a.orgId)).expect(403);
    });

    it('архивирование категории снимает её технику с линии', async () => {
      const { token, orgId } = await partnerWithOrg();
      const unit = (await t.http().post('/api/v1/partner/equipment').set(inOrg(token, orgId))
        .send(await excavatorBody({ categoryId: await slugId('telehandler'), attributes: { load_capacity: 4 } })).expect(201)).body;
      await pool.query("UPDATE equipment_units SET verification_status = 'approved', is_online = true WHERE id = $1", [unit.id]);
      const cat = await slugId('telehandler');
      await t.http().post(`/api/v1/admin/catalog/categories/${cat}/archive`).set(bearer(superadmin)).expect(200);
      const row = await pool.query('SELECT is_online FROM equipment_units WHERE id = $1', [unit.id]);
      expect(row.rows[0].is_online).toBe(false);
      await t.http().post(`/api/v1/admin/catalog/categories/${cat}/unarchive`).set(bearer(superadmin)).expect(200);
    });
  });
});
