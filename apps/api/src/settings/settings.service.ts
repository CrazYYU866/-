import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES, SETTINGS_REGISTRY, type SettingKey, type SettingValue } from '@kovsh/contracts';
import { eq } from 'drizzle-orm';
import { AppException } from '../common/app-exception';
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
export class SettingsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    const [row] = await this.db.select().from(platformSettings).where(eq(platformSettings.key, key));
    const value = row !== undefined ? row.value : SETTINGS_REGISTRY[key].default;
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
    const rows = await this.db.select().from(platformSettings);
    const overrides = new Map(rows.map((r) => [r.key, r.value]));
    return (Object.keys(SETTINGS_REGISTRY) as SettingKey[]).map((key) => {
      const def = SETTINGS_REGISTRY[key];
      const has = overrides.has(key);
      const value = has ? overrides.get(key) : def.default;
      return { key, value, isDefault: !has, configured: value !== null && value !== undefined, source: def.source };
    });
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
    return parsed.data as SettingValue<K>;
  }
}
