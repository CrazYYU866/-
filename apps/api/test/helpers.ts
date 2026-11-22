import type { INestApplication } from '@nestjs/common';
import { authenticator } from 'otplib';
import type Redis from 'ioredis';
import request from 'supertest';
import { REDIS } from '../src/redis/redis.module';
import { AdminAuthService } from '../src/admin/admin-auth.service';
import { DevSmsProvider } from '../src/auth/sms/dev-sms.provider';
import { SMS_PROVIDER } from '../src/auth/sms/sms.provider';

const w10 = [2, 4, 10, 3, 5, 9, 4, 6, 8];
const w11 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const w12 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const ctrl = (d: number[], w: number[]) => (w.reduce((s, x, i) => s + x * (d[i] ?? 0), 0) % 11) % 10;
const pad = (n: number, len: number) => String(n).padStart(len, '0');

/** Генераторы корректных реквизитов для тестов. */
export function innLegal(seed: number): string {
  const d = [...('77' + pad(seed, 7))].map(Number);
  return d.join('') + ctrl(d, w10);
}
export function innIp(seed: number): string {
  const d = [...('50' + pad(seed, 8))].map(Number);
  d.push(ctrl(d, w11));
  d.push(ctrl(d, w12));
  return d.join('');
}
export function ogrnLegal(seed: number): string {
  const body = '10277' + pad(seed, 7);
  return body + String(Number((BigInt(body) % 11n) % 10n));
}
export function ogrnIp(seed: number): string {
  const body = '30450' + pad(seed, 9);
  return body + String(Number((BigInt(body) % 13n) % 10n));
}

export const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

export class TestClient {
  private readonly totpSecrets = new Map<string, string>();
  constructor(private readonly app: INestApplication) {}
  http() {
    return request(this.app.getHttpServer());
  }
  private get sms(): DevSmsProvider {
    return this.app.get(SMS_PROVIDER);
  }
  lastCode(phone: string): string {
    const m = this.sms.lastMessage(phone)?.match(/(\d{6})/);
    if (!m?.[1]) throw new Error(`Нет кода для ${phone}`);
    return m[1];
  }
  async login(phone: string, app: 'client' | 'partner' = 'partner'): Promise<{ token: string; userId: string }> {
    // Лимиты отправки кодов из прошлых запусков тестов не должны мешать входу.
    const redis = this.app.get<Redis>(REDIS);
    const keys = await redis.keys(`otp:*${phone}*`);
    if (keys.length) await redis.del(...keys);
    await this.http().post('/api/v1/auth/otp/request').send({ phone, app }).expect(200);
    const res = await this.http().post('/api/v1/auth/otp/verify').send({ phone, app, code: this.lastCode(phone) }).expect(200);
    return { token: res.body.accessToken, userId: res.body.user.id };
  }
  async adminLogin(email: string, role: 'superadmin' | 'support' | 'finance' | 'moderator'): Promise<string> {
    const password = 'very-strong-password-123';
    await this.app.get(AdminAuthService).createAdmin({ email, fullName: `Админ ${role}`, role, password }, null).catch(() => undefined);
    const secret = this.totpSecrets.get(email);
    if (secret) {
      const res = await this.http().post('/api/v1/admin/auth/login').send({ email, password, totpCode: authenticator.generate(secret) }).expect(200);
      return res.body.accessToken;
    }
    // Первый вход: двухфакторная авторизация обязательна (С-9) — подключаем.
    const first = await this.http().post('/api/v1/admin/auth/login').send({ email, password }).expect(200);
    const setup = await this.http().post('/api/v1/admin/auth/2fa/setup').set('Authorization', `Bearer ${first.body.accessToken}`).expect(201);
    await this.http().post('/api/v1/admin/auth/2fa/confirm').set('Authorization', `Bearer ${first.body.accessToken}`).send({ code: authenticator.generate(setup.body.secret) }).expect(204);
    this.totpSecrets.set(email, setup.body.secret);
    return first.body.accessToken;
  }
  async upload(token: string, body: Buffer = PDF, mime = 'application/pdf'): Promise<string> {
    const res = await this.http()
      .post('/api/v1/files')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', body, { filename: 'doc.pdf', contentType: mime })
      .expect(201);
    return res.body.id;
  }
}
