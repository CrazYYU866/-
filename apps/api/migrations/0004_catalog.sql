-- Каталог спецтехники, характеристики, регионы, тарифы, карточки техники (ТЗ §6, §12, §13, §17; этап 4).

-- ── Регионы и зоны обслуживания ─────────────────────────────────────────────
CREATE TABLE regions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  timezone    text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  sort        int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER regions_updated_at BEFORE UPDATE ON regions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Границы региона (или его частей). По ним определяется регион объекта (К-15).
CREATE TABLE service_zones (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region_id   uuid NOT NULL REFERENCES regions (id) ON DELETE CASCADE,
  name        text NOT NULL,
  area        geography(MultiPolygon, 4326) NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_zones_area_idx ON service_zones USING gist (area);

INSERT INTO regions (code, name, timezone, sort) VALUES
  ('moscow', 'Москва', 'Europe/Moscow', 10),
  ('moscow_oblast', 'Московская область', 'Europe/Moscow', 20);

-- ── Единицы измерения ───────────────────────────────────────────────────────
CREATE TABLE measure_units (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code    text NOT NULL UNIQUE,
  label   text NOT NULL,
  name    text NOT NULL
);
INSERT INTO measure_units (code, label, name) VALUES
  ('t', 'т', 'тонны'), ('kg', 'кг', 'килограммы'), ('m', 'м', 'метры'), ('mm', 'мм', 'миллиметры'),
  ('m3', 'м³', 'кубические метры'), ('hp', 'л.с.', 'лошадиные силы'), ('tm', 'т·м', 'тонна-метры'),
  ('pcs', 'шт.', 'штуки');

-- ── Категории (дерево: категория → подкатегория → …) ────────────────────────
CREATE TABLE equipment_categories (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id              uuid REFERENCES equipment_categories (id),
  slug                   text NOT NULL UNIQUE,
  name                   text NOT NULL,
  description            text,
  image_file_id          uuid REFERENCES files (id),
  year_required          boolean NOT NULL DEFAULT true,
  visible_to_customers   boolean NOT NULL DEFAULT true,
  visible_to_partners    boolean NOT NULL DEFAULT true,
  sort                   int NOT NULL DEFAULT 0,
  archived_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX equipment_categories_parent_idx ON equipment_categories (parent_id);
CREATE TRIGGER equipment_categories_updated_at BEFORE UPDATE ON equipment_categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Характеристики. Наследуются подкатегориями.
CREATE TABLE category_attributes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id   uuid NOT NULL REFERENCES equipment_categories (id),
  key           text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  label         text NOT NULL,
  type          text NOT NULL CHECK (type IN ('number', 'integer', 'boolean', 'text', 'enum', 'multi_enum')),
  unit_id       uuid REFERENCES measure_units (id),
  options       jsonb,
  required      boolean NOT NULL DEFAULT false,
  filterable    boolean NOT NULL DEFAULT false,
  min_value     numeric,
  max_value     numeric,
  sort          int NOT NULL DEFAULT 0,
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((type IN ('enum', 'multi_enum')) = (options IS NOT NULL))
);
CREATE UNIQUE INDEX category_attributes_key_uq ON category_attributes (category_id, key) WHERE archived_at IS NULL;
CREATE TRIGGER category_attributes_updated_at BEFORE UPDATE ON category_attributes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Тарифы (версии, только добавление) ──────────────────────────────────────
-- kind: rent_hour — аренда за час (Н-3); delivery_km — доставка за км (ТЗ §13).
-- Действует последняя неотменённая версия с valid_from <= момента расчёта.
-- Тариф подкатегории приоритетнее тарифа родителя.
CREATE TABLE tariffs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id    uuid NOT NULL REFERENCES equipment_categories (id),
  region_id      uuid NOT NULL REFERENCES regions (id),
  kind           text NOT NULL CHECK (kind IN ('rent_hour', 'delivery_km')),
  price_kopecks  bigint NOT NULL CHECK (price_kopecks > 0),
  valid_from     timestamptz NOT NULL DEFAULT now(),
  reason         text,
  created_by     uuid REFERENCES admin_users (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  cancelled_at   timestamptz,
  cancelled_by   uuid REFERENCES admin_users (id)
);
CREATE UNIQUE INDEX tariffs_version_uq ON tariffs (category_id, region_id, kind, valid_from) WHERE cancelled_at IS NULL;
CREATE INDEX tariffs_lookup_idx ON tariffs (category_id, region_id, kind, valid_from DESC) WHERE cancelled_at IS NULL;

-- Тариф нельзя изменить; можно только отменить ещё не вступивший в силу.
CREATE OR REPLACE FUNCTION tariffs_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Тарифы не удаляются'; END IF;
  IF NEW.category_id <> OLD.category_id OR NEW.region_id <> OLD.region_id OR NEW.kind <> OLD.kind
     OR NEW.price_kopecks <> OLD.price_kopecks OR NEW.valid_from <> OLD.valid_from THEN
    RAISE EXCEPTION 'Тариф не изменяется: создайте новую версию';
  END IF;
  IF OLD.cancelled_at IS NOT NULL THEN RAISE EXCEPTION 'Тариф уже отменён'; END IF;
  IF NEW.cancelled_at IS NOT NULL AND OLD.valid_from <= now() THEN
    RAISE EXCEPTION 'Нельзя отменить уже действующую версию: создайте новую';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tariffs_guard BEFORE UPDATE OR DELETE ON tariffs FOR EACH ROW EXECUTE FUNCTION tariffs_guard();

-- ── Единицы техники ─────────────────────────────────────────────────────────
CREATE TABLE equipment_units (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  uuid NOT NULL REFERENCES organizations (id),
  category_id             uuid NOT NULL REFERENCES equipment_categories (id),
  brand                   text NOT NULL,
  model                   text NOT NULL,
  year                    int CHECK (year BETWEEN 1950 AND 2100),
  reg_number              text,
  attributes              jsonb NOT NULL DEFAULT '{}'::jsonb,
  base_point              geography(Point, 4326) NOT NULL,
  base_address            text NOT NULL,
  work_radius_km          int NOT NULL CHECK (work_radius_km BETWEEN 1 AND 1000),
  allow_beyond_radius     boolean NOT NULL DEFAULT false,
  is_online               boolean NOT NULL DEFAULT false,
  verification_status     text NOT NULL DEFAULT 'draft'
                            CHECK (verification_status IN ('draft', 'pending', 'approved', 'rejected')),
  rejection_reason        text,
  verified_at             timestamptz,
  submitted_at            timestamptz,
  archived_at             timestamptz,
  created_by              uuid NOT NULL REFERENCES users (id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  -- На линии может быть только проверенная и не архивная техника.
  CHECK (NOT is_online OR (verification_status = 'approved' AND archived_at IS NULL))
);
CREATE INDEX equipment_units_org_idx ON equipment_units (org_id) WHERE archived_at IS NULL;
CREATE INDEX equipment_units_base_idx ON equipment_units USING gist (base_point);
CREATE INDEX equipment_units_attrs_idx ON equipment_units USING gin (attributes);
CREATE INDEX equipment_units_matching_idx ON equipment_units (category_id) WHERE is_online;
CREATE UNIQUE INDEX equipment_units_reg_number_uq ON equipment_units (upper(reg_number)) WHERE reg_number IS NOT NULL AND archived_at IS NULL;
CREATE TRIGGER equipment_units_updated_at BEFORE UPDATE ON equipment_units FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE equipment_unit_status_history (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id         uuid NOT NULL REFERENCES equipment_units (id),
  from_status     text,
  to_status       text NOT NULL,
  reason          text,
  actor_user_id   uuid REFERENCES users (id),
  actor_admin_id  uuid REFERENCES admin_users (id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER equipment_unit_status_history_append_only BEFORE UPDATE OR DELETE ON equipment_unit_status_history
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

CREATE TABLE equipment_photos (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id    uuid NOT NULL REFERENCES equipment_units (id) ON DELETE CASCADE,
  file_id    uuid NOT NULL REFERENCES files (id),
  sort       int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (unit_id, file_id)
);

-- Расписание доступности (В-12): рабочие интервалы по дням недели, время местное (часовой пояс региона базы).
CREATE TABLE equipment_schedules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id     uuid NOT NULL REFERENCES equipment_units (id) ON DELETE CASCADE,
  weekday     int NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  CHECK (start_time < end_time)
);
CREATE INDEX equipment_schedules_unit_idx ON equipment_schedules (unit_id, weekday);

-- Календарь занятости (В-12): брони техники под заказы. Пересечения запрещены на уровне БД.
CREATE TABLE unit_bookings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id     uuid NOT NULL REFERENCES equipment_units (id),
  period      tstzrange NOT NULL,
  order_id    uuid,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  EXCLUDE USING gist (unit_id WITH =, period WITH &&) WHERE (status = 'active')
);
CREATE INDEX unit_bookings_unit_idx ON unit_bookings USING gist (unit_id, period);
