import { HttpStatus, Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ERROR_CODES, SETTINGS_REGISTRY, type SettingKey, type SettingValue } from '@kovsh/contracts';
import { eq, sql } from 'drizzle-orm';
import { AppException } from '../common/app-exception';
import { APP_ENV } from '../config/config.module';
import type { AppEnv } from '../config/env';
import { DB, type Database } from '../database/database.module';
import { platformSettings, platformSettingsHistory } from '../database/schema';

export interface SettingView {
  key: SettingKey;
  value: unknown;
  isDefault: boolean;
  configured: boolean;
  source: string;
}

/**
 * Настраиваемые параметры платформы (ТЗ §22).
 * Значение = переопределение администратора или утверждённое значение по умолчанию.
 * Если значение не утверждено и не задано, `get` бросает SETTING_NOT_CONFIGURED,
 * чтобы зависящая функциональность не работала на выдуманных числах.
 */
@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger('Settings');
  /**
   * Снимок переопределений в памяти. Чтение настройки не обращается к БД: настройки читаются внутри
   * транзакций, и отдельное соединение на каждое чтение под нагрузкой исчерпывало пул (найдено нагрузочным тестом).
   * Снимок обновляется в фоне не реже раза в SETTINGS_CACHE_MS и сразу после изменения на этом экземпляре.
   */
  private snapshot: Map<string, unknown> | null = null;
  private loadedAt = 0;
  private refreshing: Promise<void> | null = null;

  constructor(@Inject(DB) private readonly db: Database, @Inject(APP_ENV) private readonly env: AppEnv) {}

  async onModuleInit(): Promise<void> {
    if (this.env.SETTINGS_CACHE_MS > 0) await this.refresh();
  }

  private refresh(): Promise<void> {
    this.refreshing ??= this.readOverrides()
      .then((rows) => { this.snapshot = new Map(rows.map((r) => [r.key, r.value])); this.loadedAt = Date.now(); })
      .catch((e: unknown) => this.logger.error(`Не удалось обновить настройки: ${String(e)}`))
      .finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async override(key: SettingKey): Promise<{ found: boolean; value: unknown }> {
    if (this.env.SETTINGS_CACHE_MS <= 0) {
      const [row] = await this.readOverrides(key);
      return row ? { found: true, value: row.value } : { found: false, value: undefined };
    }
    if (!this.snapshot) await this.refresh();
    else if (Date.now() - this.loadedAt > this.env.SETTINGS_CACHE_MS) void this.refresh();
    const snap = this.snapshot ?? new Map<string, unknown>();
    return snap.has(key) ? { found: true, value: snap.get(key) } : { found: false, value: undefined };
  }

  async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    const row = await this.override(key);
    const value = row.found ? row.value : SETTINGS_REGISTRY[key].default;
    if (value === null || value === undefined) {
      throw new AppException(
        ERROR_CODES.SETTING_NOT_CONFIGURED,
        `Параметр «${key}» не задан администратором`,
        HttpStatus.SERVICE_UNAVAILABLE,
        { key },
      );
    }
    return SETTINGS_REGISTRY[key].schema.parse(value) as SettingValue<K>;
  }

  async list(): Promise<SettingView[]> {
    const rows = await this.readOverrides();
    const overrides = new Map(rows.map((r) => [r.key, r.value]));
    return (Object.keys(SETTINGS_REGISTRY) as SettingKey[]).map((key) => {
      const def = SETTINGS_REGISTRY[key];
      const has = overrides.has(key);
      const value = has ? overrides.get(key) : def.default;
      return { key, value, isDefault: !has, configured: value !== null && value !== undefined, source: def.source };
    });
  }

  /**
   * Значения читаются как текст и разбираются один раз: стандартное чтение jsonb повторно разбирает строку,
   * и строка из цифр (ИНН, счёт) превращалась бы в число.
   */
  private async readOverrides(key?: SettingKey): Promise<{ key: string; value: unknown }[]> {
    const rows = await this.db
      .select({ key: platformSettings.key, raw: sql<string>`${platformSettings.value}::text` })
      .from(platformSettings)
      .where(key ? eq(platformSettings.key, key) : undefined);
    return rows.map((r) => ({ key: r.key, value: JSON.parse(r.raw) as unknown }));
  }

  async set<K extends SettingKey>(
    key: K,
    value: unknown,
    changedBy: string | null,
    reason?: string,
  ): Promise<SettingValue<K>> {
    const parsed = SETTINGS_REGISTRY[key].schema.safeParse(value);
    if (!parsed.success) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, `Недопустимое значение для «${key}»`, HttpStatus.BAD_REQUEST, {
        key,
        issues: parsed.error.issues.map((i) => i.message),
      });
    }
    await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(platformSettings)
        .where(eq(platformSettings.key, key))
        .for('update');
      await tx
        .insert(platformSettings)
        .values({ key, value: parsed.data, updatedBy: changedBy })
        .onConflictDoUpdate({ target: platformSettings.key, set: { value: parsed.data, updatedBy: changedBy } });
      await tx.insert(platformSettingsHistory).values({
        key,
        oldValue: current?.value ?? null,
        newValue: parsed.data,
        changedBy,
        reason: reason ?? null,
      });
    });
    if (this.env.SETTINGS_CACHE_MS > 0) await this.refresh();
    return parsed.data as SettingValue<K>;
  }
}
