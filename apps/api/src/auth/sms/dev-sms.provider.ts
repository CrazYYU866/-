import { Logger } from '@nestjs/common';
import type { SmsProvider } from './sms.provider';

/**
 * Тестовый провайдер для локальной разработки и автотестов.
 * Ничего не отправляет, пишет текст в лог. В production запрещён проверкой конфигурации.
 */
export class DevSmsProvider implements SmsProvider {
  private readonly logger = new Logger('DevSms');
  private readonly outbox = new Map<string, string>();

  async send(phone: string, text: string): Promise<void> {
    this.outbox.set(phone, text);
    this.logger.warn(`[DEV SMS] ${phone}: ${text}`);
  }

  /** Последнее сообщение на номер — только для тестов. */
  lastMessage(phone: string): string | undefined {
    return this.outbox.get(phone);
  }
}
