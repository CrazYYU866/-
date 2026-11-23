import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { createApp } from '../src/app.factory';
import { loadEnv } from '../src/config/env';
import { resetTestDatabase } from './db';
import { TestClient } from './helpers';

describe('Подсказки адресов (тестовый геокодер)', () => {
  let app: INestApplication;
  let pool: Pool;
  let t: TestClient;
  let token: string;

  beforeAll(async () => {
    pool = await resetTestDatabase();
    app = await createApp();
    await app.init();
    t = new TestClient(app);
    token = (await t.login('+79990007001', 'client')).token;
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('требует авторизацию', async () => {
    await t.http().get('/api/v1/geo/suggest?q=Химки').expect(401);
  });

  it('находит адрес по словам и помечает тестовый источник', async () => {
    const res = await t.http().get('/api/v1/geo/suggest').query({ q: 'химки ленинградское' }).set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.provider).toBe('dev');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ address: 'МО, Химки, Ленинградское ш., 25', hint: 'тестовый адрес' });
  });

  it('понимает координаты', async () => {
    const res = await t.http().get('/api/v1/geo/suggest').query({ q: '55.75, 37.62' }).set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.items[0]).toMatchObject({ lat: 55.75, lng: 37.62 });
  });

  it('тестовый геокодер запрещён в production', () => {
    expect(() => loadEnv({ ...process.env, NODE_ENV: 'production', GEOCODER_PROVIDER: 'dev' })).toThrow(/GEOCODER_PROVIDER/);
  });
});
