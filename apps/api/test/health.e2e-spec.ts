import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../src/app.factory';
import { resetTestDatabase } from './db';

describe('HTTP: health и формат ошибок', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    pool = await resetTestDatabase();
    app = await createApp();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('GET /api/v1/health — все зависимости доступны', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', db: 'ok', postgis: 'ok', redis: 'ok' });
  });

  it('неизвестный маршрут отдаёт ошибку в едином формате', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/nope').set('x-request-id', 'req-1').expect(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND', requestId: 'req-1' });
    expect(typeof res.body.message).toBe('string');
  });
});
