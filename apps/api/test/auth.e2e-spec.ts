import type { INestApplication } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../src/app.factory';
import { DevSmsProvider } from '../src/auth/sms/dev-sms.provider';
import { SMS_PROVIDER } from '../src/auth/sms/sms.provider';
import { REDIS } from '../src/redis/redis.module';
import { resetTestDatabase } from './db';

const PHONE = '+79161234567';

describe('Вход по SMS и сессии', () => {
  let app: INestApplication;
  let pool: Pool;
  let sms: DevSmsProvider;
  let redis: Redis;
  const http = () => request(app.getHttpServer());

  const lastCode = (phone = PHONE): string => {
    const m = sms.lastMessage(phone)?.match(/(\d{6})/);
    if (!m?.[1]) throw new Error('Код не отправлен');
    return m[1];
  };

  async function login(phone = PHONE, app_: 'client' | 'partner' = 'client') {
    await http().post('/api/v1/auth/otp/request').send({ phone, app: app_ }).expect(200);
    const res = await http()
      .post('/api/v1/auth/otp/verify')
      .send({ phone, app: app_, code: lastCode(phone) })
      .expect(200);
    await redis.flushdb();
    return res.body as { accessToken: string; refreshToken: string; isNewUser: boolean; user: { id: string } };
  }

  beforeAll(async () => {
    pool = await resetTestDatabase();
    app = await createApp();
    await app.init();
    sms = app.get(SMS_PROVIDER);
    redis = app.get(REDIS);
  });
  beforeEach(async () => {
    await redis.flushdb();
    await pool.query('TRUNCATE users, otp_challenges, auth_sessions, push_devices, platform_settings CASCADE');
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('первый вход создаёт пользователя, повторный — нет', async () => {
    const first = await login();
    expect(first.isNewUser).toBe(true);
    expect(first.accessToken).toBeTruthy();
    const second = await login();
    expect(second.isNewUser).toBe(false);
    expect(second.user.id).toBe(first.user.id);
  });

  it('номер принимается в разных форматах', async () => {
    await http().post('/api/v1/auth/otp/request').send({ phone: '8 (916) 123-45-67', app: 'client' }).expect(200);
    expect(sms.lastMessage(PHONE)).toMatch(/\d{6}/);
  });

  it('некорректный номер — INVALID_PHONE', async () => {
    const res = await http().post('/api/v1/auth/otp/request').send({ phone: '12345', app: 'client' }).expect(400);
    expect(res.body.code).toBe('INVALID_PHONE');
  });

  it('повторный запрос кода раньше срока — OTP_COOLDOWN', async () => {
    await http().post('/api/v1/auth/otp/request').send({ phone: PHONE, app: 'client' }).expect(200);
    const res = await http().post('/api/v1/auth/otp/request').send({ phone: PHONE, app: 'client' }).expect(429);
    expect(res.body.code).toBe('OTP_COOLDOWN');
  });

  it('лимит запросов кода на номер в час', async () => {
    for (let i = 0; i < 5; i++) {
      await http().post('/api/v1/auth/otp/request').send({ phone: PHONE, app: 'client' }).expect(200);
      await redis.del(`otp:cooldown:client:${PHONE}`);
    }
    const res = await http().post('/api/v1/auth/otp/request').send({ phone: PHONE, app: 'client' }).expect(429);
    expect(res.body.code).toBe('RATE_LIMITED');
  });

  it('неверный код уменьшает число попыток, после лимита код блокируется', async () => {
    await http().post('/api/v1/auth/otp/request').send({ phone: PHONE, app: 'client' }).expect(200);
    const good = lastCode();
    const bad = good === '000000' ? '111111' : '000000';
    const first = await http().post('/api/v1/auth/otp/verify').send({ phone: PHONE, app: 'client', code: bad }).expect(401);
    expect(first.body).toMatchObject({ code: 'OTP_INVALID', details: { attemptsLeft: 4 } });
    for (let i = 0; i < 4; i++) {
      await http().post('/api/v1/auth/otp/verify').send({ phone: PHONE, app: 'client', code: bad }).expect(401);
    }
    const blocked = await http()
      .post('/api/v1/auth/otp/verify')
      .send({ phone: PHONE, app: 'client', code: good })
      .expect(429);
    expect(blocked.body.code).toBe('OTP_ATTEMPTS_EXCEEDED');
  });

  it('код нельзя использовать дважды', async () => {
    await http().post('/api/v1/auth/otp/request').send({ phone: PHONE, app: 'client' }).expect(200);
    const code = lastCode();
    await http().post('/api/v1/auth/otp/verify').send({ phone: PHONE, app: 'client', code }).expect(200);
    await http().post('/api/v1/auth/otp/verify').send({ phone: PHONE, app: 'client', code }).expect(401);
  });

  it('просроченный код — OTP_EXPIRED', async () => {
    await http().post('/api/v1/auth/otp/request').send({ phone: PHONE, app: 'client' }).expect(200);
    await pool.query("UPDATE otp_challenges SET expires_at = now() - interval '1 second'");
    const res = await http()
      .post('/api/v1/auth/otp/verify')
      .send({ phone: PHONE, app: 'client', code: lastCode() })
      .expect(401);
    expect(res.body.code).toBe('OTP_EXPIRED');
  });

  it('код для клиентского приложения не подходит для партнёрского', async () => {
    await http().post('/api/v1/auth/otp/request').send({ phone: PHONE, app: 'client' }).expect(200);
    await http().post('/api/v1/auth/otp/verify').send({ phone: PHONE, app: 'partner', code: lastCode() }).expect(401);
  });

  it('профиль: без токена 401, с токеном — чтение и изменение имени', async () => {
    await http().get('/api/v1/me').expect(401);
    const { accessToken } = await login();
    const auth = { Authorization: `Bearer ${accessToken}` };
    const me = await http().get('/api/v1/me').set(auth).expect(200);
    expect(me.body).toMatchObject({ phone: PHONE, fullName: null, status: 'active' });
    const upd = await http().patch('/api/v1/me').set(auth).send({ fullName: 'Иван Петров' }).expect(200);
    expect(upd.body.fullName).toBe('Иван Петров');
    await http().patch('/api/v1/me').set(auth).send({ fullName: 'И' }).expect(400);
  });

  it('push-токен регистрируется и переходит к новому владельцу', async () => {
    const a = await login(PHONE);
    const b = await login('+79161234568');
    const token = 'expo-push-token-0000000001';
    await http().post('/api/v1/me/push-devices').set({ Authorization: `Bearer ${a.accessToken}` })
      .send({ platform: 'ios', token }).expect(204);
    await http().post('/api/v1/me/push-devices').set({ Authorization: `Bearer ${b.accessToken}` })
      .send({ platform: 'ios', token }).expect(204);
    const { rows } = await pool.query('SELECT user_id FROM push_devices WHERE token = $1', [token]);
    expect(rows).toEqual([{ user_id: b.user.id }]);
  });

  it('refresh выдаёт новую пару; повторное использование старого токена отзывает всю семью', async () => {
    const { refreshToken } = await login();
    const r1 = await http().post('/api/v1/auth/refresh').send({ refreshToken }).expect(200);
    expect(r1.body.refreshToken).not.toBe(refreshToken);

    const reuse = await http().post('/api/v1/auth/refresh').send({ refreshToken }).expect(401);
    expect(reuse.body.code).toBe('REFRESH_REUSED');

    // Новый токен тоже отозван — злоумышленник и владелец оба должны войти заново.
    await http().post('/api/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken }).expect(401);
    await http().get('/api/v1/me').set({ Authorization: `Bearer ${r1.body.accessToken}` }).expect(401);
  });

  it('параллельный refresh одним токеном: успешен ровно один', async () => {
    const { refreshToken } = await login();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => http().post('/api/v1/auth/refresh').send({ refreshToken })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('после выхода access-токен перестаёт работать', async () => {
    const { accessToken } = await login();
    const auth = { Authorization: `Bearer ${accessToken}` };
    await http().post('/api/v1/auth/logout').set(auth).expect(204);
    await http().get('/api/v1/me').set(auth).expect(401);
  });

  it('заблокированный пользователь не может работать и войти', async () => {
    const { accessToken } = await login();
    await pool.query("UPDATE users SET status = 'blocked' WHERE phone = $1", [PHONE]);
    const me = await http().get('/api/v1/me').set({ Authorization: `Bearer ${accessToken}` }).expect(403);
    expect(me.body.code).toBe('USER_BLOCKED');

    await http().post('/api/v1/auth/otp/request').send({ phone: PHONE, app: 'client' }).expect(200);
    const res = await http().post('/api/v1/auth/otp/verify').send({ phone: PHONE, app: 'client', code: lastCode() }).expect(403);
    expect(res.body.code).toBe('USER_BLOCKED');
  });

  it('поддельный access-токен отклоняется', async () => {
    await http().get('/api/v1/me').set({ Authorization: 'Bearer abc.def.ghi' }).expect(401);
  });
});
