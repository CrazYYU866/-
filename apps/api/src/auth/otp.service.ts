import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES, type ClientApp, type OtpRequestResponse } from '@kovsh/contracts';
import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { AppException } from '../common/app-exception';
import { APP_ENV } from '../config/config.module';
import type { AppEnv } from '../config/env';
import { DB, type Database } from '../database/database.module';
import { otpChallenges } from '../database/schema';
import { REDIS } from '../redis/redis.module';
import { SettingsService } from '../settings/settings.service';
import { SMS_PROVIDER, type SmsProvider } from './sms/sms.provider';

export type OtpPurpose = 'login' | 'bank_account_change';

@Injectable()
export class OtpService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    private readonly settings: SettingsService,
  ) {}

  async request(
    phone: string,
    app: ClientApp,
    ip: string | null,
    purpose: OtpPurpose = 'login',
  ): Promise<OtpRequestResponse> {
    const [length, ttl, maxAttempts, cooldown, perPhone, perIp] = await Promise.all([
      this.settings.get('otp_code_length'),
      this.settings.get('otp_ttl_sec'),
      this.settings.get('otp_max_attempts'),
      this.settings.get('otp_resend_cooldown_sec'),
      this.settings.get('otp_max_per_phone_per_hour'),
      this.settings.get('otp_max_per_ip_per_hour'),
    ]);

    // Повторная отправка не чаще одного раза в cooldown секунд.
    const cooldownKey = `otp:cooldown:${purpose}:${app}:${phone}`;
    const acquired = await this.redis.set(cooldownKey, '1', 'EX', cooldown, 'NX');
    if (acquired !== 'OK') {
      const left = await this.redis.ttl(cooldownKey);
      throw new AppException(ERROR_CODES.OTP_COOLDOWN, 'Код уже отправлен, повторите позже', HttpStatus.TOO_MANY_REQUESTS, {
        resendAfterSec: Math.max(left, 1),
      });
    }
    await this.enforceHourlyLimit(`otp:phone:${phone}`, perPhone);
    if (ip !== null) await this.enforceHourlyLimit(`otp:ip:${ip}`, perIp);

    const code = Array.from({ length }, () => randomInt(0, 10)).join('');
    const [challenge] = await this.db
      .insert(otpChallenges)
      .values({
        phone,
        app,
        purpose,
        codeHash: 'pending',
        maxAttempts,
        expiresAt: new Date(Date.now() + ttl * 1000),
        ip,
      })
      .returning({ id: otpChallenges.id });
    if (!challenge) throw new Error('Не удалось создать запрос кода');
    await this.db
      .update(otpChallenges)
      .set({ codeHash: this.hash(challenge.id, code) })
      .where(eq(otpChallenges.id, challenge.id));

    // Предыдущие неиспользованные коды на этот номер становятся недействительными.
    await this.db
      .update(otpChallenges)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(otpChallenges.phone, phone),
          eq(otpChallenges.app, app),
          eq(otpChallenges.purpose, purpose),
          isNull(otpChallenges.consumedAt),
          lt(otpChallenges.createdAt, sql`(SELECT created_at FROM otp_challenges WHERE id = ${challenge.id})`),
        ),
      );

    const text =
      purpose === 'login'
        ? `Код входа в «Ковш на Час»: ${code}. Никому его не сообщайте.`
        : `Код подтверждения смены банковских реквизитов: ${code}. Если это не вы — обратитесь в поддержку.`;
    await this.sms.send(phone, text);
    return { resendAfterSec: cooldown, expiresInSec: ttl };
  }

  /** Проверяет код. При успехе код погашается и больше не может быть использован. */
  async verify(phone: string, app: ClientApp, code: string, purpose: OtpPurpose = 'login'): Promise<void> {
    const [challenge] = await this.db
      .select()
      .from(otpChallenges)
      .where(
        and(
          eq(otpChallenges.phone, phone),
          eq(otpChallenges.app, app),
          eq(otpChallenges.purpose, purpose),
          isNull(otpChallenges.consumedAt),
        ),
      )
      .orderBy(desc(otpChallenges.createdAt))
      .limit(1);

    if (!challenge) throw new AppException(ERROR_CODES.OTP_INVALID, 'Неверный код', HttpStatus.UNAUTHORIZED);
    if (challenge.expiresAt.getTime() <= Date.now()) {
      throw new AppException(ERROR_CODES.OTP_EXPIRED, 'Срок действия кода истёк, запросите новый', HttpStatus.UNAUTHORIZED);
    }

    // Попытка засчитывается атомарно, чтобы параллельные запросы не обошли лимит.
    const [counted] = await this.db
      .update(otpChallenges)
      .set({ attempts: sql`${otpChallenges.attempts} + 1` })
      .where(
        and(
          eq(otpChallenges.id, challenge.id),
          isNull(otpChallenges.consumedAt),
          lt(otpChallenges.attempts, otpChallenges.maxAttempts),
        ),
      )
      .returning({ attempts: otpChallenges.attempts });
    if (!counted) {
      throw new AppException(
        ERROR_CODES.OTP_ATTEMPTS_EXCEEDED,
        'Превышено число попыток, запросите новый код',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (!this.matches(challenge.codeHash, this.hash(challenge.id, code))) {
      throw new AppException(ERROR_CODES.OTP_INVALID, 'Неверный код', HttpStatus.UNAUTHORIZED, {
        attemptsLeft: challenge.maxAttempts - counted.attempts,
      });
    }

    const [consumed] = await this.db
      .update(otpChallenges)
      .set({ consumedAt: new Date() })
      .where(
        and(eq(otpChallenges.id, challenge.id), isNull(otpChallenges.consumedAt), gt(otpChallenges.expiresAt, new Date())),
      )
      .returning({ id: otpChallenges.id });
    if (!consumed) throw new AppException(ERROR_CODES.OTP_INVALID, 'Код уже использован', HttpStatus.UNAUTHORIZED);
  }

  private async enforceHourlyLimit(key: string, limit: number): Promise<void> {
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, 3600);
    if (count > limit) {
      throw new AppException(ERROR_CODES.RATE_LIMITED, 'Слишком много запросов кода, попробуйте позже', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private hash(challengeId: string, code: string): string {
    return createHmac('sha256', this.env.OTP_HASH_SECRET).update(`${challengeId}:${code}`).digest('hex');
  }

  private matches(a: string, b: string): boolean {
    const ba = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  }
}
