-- Расчёт стоимости до поиска исполнителя (ТЗ §7, §12, §13; Н-1, Н-3, Н-6, Н-7, К-2, К-3, Л-1, Л-4).
-- Цена фиксируется в расчёте и переносится в заказ без изменений (Н-1, Н-21).
CREATE TABLE quotes (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id                uuid NOT NULL REFERENCES users (id),
  category_id                uuid NOT NULL REFERENCES equipment_categories (id),
  region_id                  uuid NOT NULL REFERENCES regions (id),
  site_point                 geography(Point, 4326) NOT NULL,
  site_address               text NOT NULL,
  requirements               jsonb NOT NULL DEFAULT '{}'::jsonb,
  days                       jsonb NOT NULL,            -- выбранные дни и часы (Л-1)
  shifts                     jsonb NOT NULL,            -- смены ≤ max_shift_hours (К-3)
  total_hours                int NOT NULL CHECK (total_hours > 0),
  urgency                    text NOT NULL CHECK (urgency IN ('urgent', 'scheduled')),
  first_start_at             timestamptz NOT NULL,
  last_end_at                timestamptz NOT NULL,
  -- База расчёта доставки: ближайшая подходящая свободная техника на линии (Н-1).
  reference_unit_id          uuid NOT NULL REFERENCES equipment_units (id),
  reference_route_km         numeric(8, 1) NOT NULL,
  reference_route_minutes    int NOT NULL,
  routing_provider           text NOT NULL,
  -- Снимок тарифов.
  rent_tariff_id             uuid NOT NULL REFERENCES tariffs (id),
  delivery_tariff_id         uuid NOT NULL REFERENCES tariffs (id),
  hour_price_kopecks         bigint NOT NULL,
  km_price_kopecks           bigint NOT NULL,
  -- Суммы в копейках (Н-6).
  rent_kopecks               bigint NOT NULL,
  delivery_kopecks           bigint NOT NULL,
  subtotal_kopecks           bigint NOT NULL,
  total_kopecks              bigint NOT NULL CHECK (total_kopecks % 100 = 0),  -- итог — целые рубли
  expires_at                 timestamptz NOT NULL,
  used_at                    timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quotes_customer_idx ON quotes (customer_id, created_at DESC);
