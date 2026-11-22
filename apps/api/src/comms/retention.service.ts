import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { APP_ENV } from '../config/config.module';
import type { AppEnv } from '../config/env';
import { OrderCore } from '../orders/order-core';
import { SettingsService } from '../settings/settings.service';

/**
 * Сроки хранения: GPS — 48 часов после окончательного завершения (П-16, Н-19), переписка и записи звонков — 180 дней (В-27).
 * По заказам со спором данные хранятся до окончания разбирательства.
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    private readonly core: OrderCore,
    private readonly settings: SettingsService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  onModuleInit(): void {
    this.core.jobs.register('retention_daily', async () => {
      await this.cleanup();
      await this.core.jobs.schedule('retention_daily', {}, new Date(Date.now() + 86_400_000), { dedupeKey: 'retention:daily' });
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.env.NODE_ENV !== 'test') await this.core.jobs.schedule('retention_daily', {}, new Date(Date.now() + 3_600_000), { dedupeKey: 'retention:daily' });
  }

  async cleanup(): Promise<{ gps: number; chat: number; recordings: number }> {
    const [gpsHours, chatDays, recDays] = await Promise.all([
      this.settings.get('gps_retention_hours'),
      this.settings.get('chat_retention_days'),
      this.settings.get('call_recording_retention_days'),
    ]);
    const gps = await this.core.db.execute(sql`
      DELETE FROM location_pings WHERE order_id IN (
        SELECT id FROM orders WHERE status IN ('completed', 'awaiting_final_payment', 'cancelled', 'cancelled_unpaid', 'search_failed')
          AND COALESCE(completed_at, cancelled_at) < now() - (${gpsHours} * interval '1 hour'))`);
    const chat = await this.core.db.execute(sql`
      DELETE FROM chat_messages m WHERE m.created_at < now() - (${chatDays} * interval '1 day')
        AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = m.order_id AND o.status = 'disputed')`);
    const rec = await this.core.db.execute(sql`
      UPDATE call_sessions c SET recording_file_id = NULL WHERE recording_file_id IS NOT NULL AND c.created_at < now() - (${recDays} * interval '1 day')
        AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = c.order_id AND o.status = 'disputed')`);
    return { gps: gps.rowCount ?? 0, chat: chat.rowCount ?? 0, recordings: rec.rowCount ?? 0 };
  }
}
