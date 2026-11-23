import type { INestApplication } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { REDIS } from '../src/redis/redis.module';
import { createApp } from '../src/app.factory';
import { resetTestDatabase } from './db';
import { TestClient } from './helpers';

/**
 * Проверка безопасности (ТЗ §19, этап 13): все маршруты API перечисляются из самого приложения,
 * поэтому новый эндпоинт без защиты сразу ломает тест.
 */
const PUBLIC: RegExp[] = [
  /^GET \/api\/v1\/health$/,
  /^GET \/api\/v1\/catalog\//, // каталог можно смотреть до входа
  /^POST \/api\/v1\/auth\/(otp\/request|otp\/verify|refresh)$/,
  /^POST \/api\/v1\/admin\/auth\/(login|refresh)$/,
  /^(GET|POST) \/api\/v1\/public\/orders\/:token/, // заявка диспетчера по SMS-ссылке: доступ по секретному токену (Н-30)
  /^POST \/api\/v1\/webhooks\/payments\//, // защищается подписью провайдера
  /^(GET|POST) \/api\/v1\/dev\/payments\//, // тестовая страница оплаты; в production провайдер dev запрещён
];
const UUID = '00000000-0000-4000-8000-000000000000';

interface Route { method: string; path: string }

function listRoutes(app: INestApplication): Route[] {
  const server = app.getHttpAdapter().getInstance() as { router?: { stack: unknown[] }; _router?: { stack: unknown[] } };
  const stack = (server.router ?? server._router)?.stack ?? [];
  const out: Route[] = [];
  for (const layer of stack as { route?: { path: string; methods: Record<string, boolean> } }[]) {
    if (!layer.route) continue;
    for (const m of Object.keys(layer.route.methods)) out.push({ method: m.toUpperCase(), path: layer.route.path });
  }
  return out.filter((r) => r.path.startsWith('/api/v1/'));
}
const concrete = (p: string) => p.replace(/:token/g, 'x'.repeat(40)).replace(/:[A-Za-z]+/g, UUID);
const isPublic = (r: Route) => PUBLIC.some((re) => re.test(`${r.method} ${r.path}`));

describe('Безопасность API', () => {
  let app: INestApplication;
  let pool: Pool;
  let t: TestClient;

  beforeAll(async () => {
    pool = await resetTestDatabase();
    app = await createApp();
    await app.init();
    t = new TestClient(app);
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('маршрутов много и список собран из приложения', () => {
    expect(listRoutes(app).length).toBeGreaterThan(150);
  });

  it('без токена закрыты все маршруты, кроме явно публичных', async () => {
    const open: string[] = [];
    for (const r of listRoutes(app).filter((x) => !isPublic(x))) {
      const res = await t.http()[r.method.toLowerCase() as 'get'](concrete(r.path)).send({});
      if (res.status !== 401) open.push(`${r.method} ${r.path} → ${res.status}`);
    }
    expect(open).toEqual([]);
  });

  it('поддельный и чужой по типу токен не принимается нигде', async () => {
    const bad = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.invalid';
    const failed: string[] = [];
    for (const r of listRoutes(app).filter((x) => !isPublic(x)).slice(0, 400)) {
      const res = await t.http()[r.method.toLowerCase() as 'get'](concrete(r.path)).set('Authorization', bad).send({});
      if (res.status !== 401) failed.push(`${r.method} ${r.path} → ${res.status}`);
    }
    expect(failed).toEqual([]);
  });

  it('токен приложения заказчика не открывает разделы партнёра и админки', async () => {
    const { token } = await t.login('+79990009001', 'client');
    const leaks: string[] = [];
    for (const r of listRoutes(app).filter((x) => /^\/api\/v1\/(partner|admin)\//.test(x.path) && !isPublic(x))) {
      const res = await t.http()[r.method.toLowerCase() as 'get'](concrete(r.path)).set('Authorization', `Bearer ${token}`).set('X-Org-Id', UUID).send({});
      if (res.status < 400) leaks.push(`${r.method} ${r.path} → ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });

  it('токен приложения партнёра не открывает разделы заказчика', async () => {
    const { token } = await t.login('+79990009002', 'partner');
    const leaks: string[] = [];
    for (const r of listRoutes(app).filter((x) => /^\/api\/v1\/client\//.test(x.path))) {
      const res = await t.http()[r.method.toLowerCase() as 'get'](concrete(r.path)).set('Authorization', `Bearer ${token}`).send({});
      if (res.status < 400) leaks.push(`${r.method} ${r.path} → ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });

  it('защитные заголовки; сервер не раскрывает технологию', async () => {
    const res = await t.http().get('/api/v1/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('тестовые SMS (тестовый стенд): видит только суперадмин', async () => {
    await t.http().post('/api/v1/auth/otp/request').send({ phone: '+79990009010', app: 'client' }).expect(200);
    const root = await t.adminLogin('root@sec.test', 'superadmin');
    const support = await t.adminLogin('sup@sec.test', 'support');
    const list = await t.http().get('/api/v1/admin/dev/sms').set('Authorization', `Bearer ${root}`).expect(200);
    expect(list.body.find((m: { phone: string }) => m.phone === '+79990009010')?.text).toMatch(/\d{6}/);
    await t.http().get('/api/v1/admin/dev/sms').set('Authorization', `Bearer ${support}`).expect(403);
  });

  it('ошибки не раскрывают внутренности (стек, SQL)', async () => {
    const res = await t.http().get(`/api/v1/client/orders/not-a-uuid`).set('Authorization', `Bearer ${(await t.login('+79990009003', 'client')).token}`);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/at \w+ \(|SELECT|postgres|node_modules/i);
  });
});

describe('Ограничение частоты запросов', () => {
  let app: INestApplication;
  const saved = { ...process.env };
  beforeAll(async () => {
    process.env.RATE_LIMIT_PER_MIN = '20';
    process.env.RATE_LIMIT_AUTH_PER_MIN = '5';
    app = await createApp();
    await app.init();
    const redis = app.get<Redis>(REDIS);
    await redis.flushdb();
  });
  afterAll(async () => {
    process.env = saved;
    await app.close();
  });

  it('вход: после лимита — 429 с Retry-After; health не ограничивается', async () => {
    const t = new TestClient(app);
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await t.http().post('/api/v1/auth/refresh').send({ refreshToken: 'x'.repeat(30) })).status);
    expect(codes.slice(0, 5).every((c) => c !== 429)).toBe(true);
    const last = await t.http().post('/api/v1/auth/refresh').send({ refreshToken: 'x'.repeat(30) });
    expect(last.status).toBe(429);
    expect(last.body.code).toBe('RATE_LIMITED');
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
    for (let i = 0; i < 30; i++) await t.http().get('/api/v1/health').expect(200);
  });
});
