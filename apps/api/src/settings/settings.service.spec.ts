import { ERROR_CODES } from '@kovsh/contracts';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { resetTestDatabase } from '../../test/db';
import { AppException } from '../common/app-exception';
import * as schema from '../database/schema';
import { SettingsService } from './settings.service';

describe('SettingsService', () => {
  let pool: Pool;
  let service: SettingsService;

  beforeEach(async () => {
    pool = await resetTestDatabase();
    service = new SettingsService(drizzle(pool, { schema }), { SETTINGS_CACHE_MS: 0 } as never);
  });
  afterEach(async () => {
    await pool.end();
  });

  it('возвращает утверждённое значение по умолчанию', async () => {
    await expect(service.get('offer_timeout_sec')).resolves.toBe(40);
    await expect(service.get('search_radius_max_km')).resolves.toBe(150);
  });

  it('утверждённые финансовые параметры: комиссия 12%, диспетчер 7% (Ф-1)', async () => {
    await expect(service.get('platform_commission_percent')).resolves.toBe(12);
    await expect(service.get('agent_commission_percent')).resolves.toBe(7);
  });

  it('незаданный параметр не подменяется выдуманным значением', async () => {
    await pool.query(`INSERT INTO platform_settings (key, value) VALUES ('platform_commission_percent', 'null'::jsonb)`);
    await expect(service.get('platform_commission_percent')).rejects.toMatchObject({ code: ERROR_CODES.SETTING_NOT_CONFIGURED });
  });

  it('сохраняет переопределение и пишет историю', async () => {
    await service.set('offer_timeout_sec', 45, null, 'тест');
    await service.set('offer_timeout_sec', 50, null);
    await expect(service.get('offer_timeout_sec')).resolves.toBe(50);

    const { rows } = await pool.query(
      "SELECT old_value, new_value, reason FROM platform_settings_history WHERE key = 'offer_timeout_sec' ORDER BY id",
    );
    expect(rows).toEqual([
      { old_value: null, new_value: 45, reason: 'тест' },
      { old_value: 45, new_value: 50, reason: null },
    ]);
  });

  it('отклоняет недопустимое значение', async () => {
    await expect(service.set('platform_commission_percent', 150, null)).rejects.toBeInstanceOf(AppException);
    await expect(service.set('offer_timeout_sec', -1, null)).rejects.toBeInstanceOf(AppException);
  });

  it('список показывает, где значение по умолчанию, а где изменено администратором', async () => {
    const list = await service.list();
    expect(list.find((s) => s.key === 'platform_commission_percent')).toMatchObject({ configured: true, isDefault: true, value: 12 });
    await service.set('platform_commission_percent', 13, null);
    const after = await service.list();
    expect(after.find((s) => s.key === 'platform_commission_percent')).toMatchObject({ configured: true, isDefault: false, value: 13 });
  });

  it('строка из цифр (ИНН, счёт) остаётся строкой', async () => {
    await service.set('platform_inn', '7707083893', null);
    await expect(service.get('platform_inn')).resolves.toBe('7707083893');
  });

  it('история изменений не редактируется', async () => {
    await service.set('offer_timeout_sec', 45, null);
    await expect(pool.query('DELETE FROM platform_settings_history')).rejects.toThrow(/только добавление/);
  });
});
