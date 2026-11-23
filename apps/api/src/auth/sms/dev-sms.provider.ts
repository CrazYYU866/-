import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import type { SmsProvider } from './sms.provider';

/**
 * Тестовый провайдер для локальной разработки и автотестов.
 * Ничего не отправляет, пишет текст в лог. В production запрещён проверкой конфигурации.
 */
export const DEV_SMS_KEY = 'dev:sms:outbox';

export class DevSmsProvider implements SmsProvider {
  private readonly logger = new Logger('DevSms');
  private readonly outbox = new Map<string, string>();

  /** redis — общий «почтовый ящик» тестовых SMS для всех экземпляров (раздел админки «Тестовые SMS» на тестовом стенде). */
  constructor(private readonly redis?: Redis) {}

  async send(phone: string, text: string): Promise<void> {
    this.outbox.set(phone, text);
    this.logger.warn(`[DEV SMS] ${phone}: ${text}`);
    if (this.redis) {
      await this.redis.lpush(DEV_SMS_KEY, JSON.stringify({ phone, text, at: new Date().toISOString() }));
      await this.redis.ltrim(DEV_SMS_KEY, 0, 199);
      await this.redis.expire(DEV_SMS_KEY, 86_400);
    }
  }

  /** Последние тестовые SMS (новые сверху). */
  async recent(limit = 50): Promise<{ phone: string; text: string; at: string }[]> {
    if (!this.redis) return [];
    return (await this.redis.lrange(DEV_SMS_KEY, 0, limit - 1)).map((r) => JSON.parse(r) as { phone: string; text: string; at: string });
  }

  /** Последнее сообщение на номер — только для тестов. */
  lastMessage(phone: string): string | undefined {
    return this.outbox.get(phone);
  }
}
