-- Базовые расширения и инфраструктурные таблицы.
CREATE EXTENSION IF NOT EXISTS postgis;     -- геоданные (ТЗ §18)
CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- exclusion constraints для броней техники
CREATE EXTENSION IF NOT EXISTS citext;      -- регистронезависимые email

-- Автообновление updated_at.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Переопределения настраиваемых параметров (ТЗ §22). Реестр ключей и значения
-- по умолчанию живут в коде (@kovsh/contracts, SETTINGS_REGISTRY); здесь — только
-- значения, изменённые администратором.
CREATE TABLE platform_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER platform_settings_updated_at
  BEFORE UPDATE ON platform_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- История изменений настроек: только добавление записей.
CREATE TABLE platform_settings_history (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key         text NOT NULL,
  old_value   jsonb,
  new_value   jsonb NOT NULL,
  changed_by  uuid,
  reason      text,
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_settings_history_key_idx ON platform_settings_history (key, changed_at DESC);

CREATE OR REPLACE FUNCTION forbid_update_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Таблица % допускает только добавление записей', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER platform_settings_history_append_only
  BEFORE UPDATE OR DELETE ON platform_settings_history
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
