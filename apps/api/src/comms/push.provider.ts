import { Logger } from '@nestjs/common';

/** Отправка push (ТЗ §16). Прод — Expo Push / FCM / APNs; разработка — запись в лог. */
export interface PushProvider {
  send(tokens: string[], message: { title: string; body: string; data: Record<string, unknown> }): Promise<void>;
}
export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');

export class DevPushProvider implements PushProvider {
  private readonly logger = new Logger('DevPush');
  readonly sent: { tokens: string[]; title: string; body: string }[] = [];
  async send(tokens: string[], m: { title: string; body: string }): Promise<void> {
    if (tokens.length === 0) return;
    this.sent.push({ tokens, title: m.title, body: m.body });
    this.logger.log(`[DEV PUSH] ${tokens.length} устр.: ${m.title} — ${m.body}`);
  }
}
