-- Заказы, распределение, назначение, исполнение (ТЗ §7–§11; Р-1…Р-18; Н-1…Н-22; К-1…К-8; Л-1…Л-6).

-- ── Отложенные задания (таймеры) ────────────────────────────────────────────
-- Создаются в той же транзакции, что и изменение заказа; обработчики идемпотентны.
CREATE TABLE scheduled_jobs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type        text NOT NULL,
  payload     jsonb NOT NULL,
  run_at      timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled')),
  locked_at   timestamptz,
  attempts    int NOT NULL DEFAULT 0,
  last_error  text,
  dedupe_key  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  done_at     timestamptz
);
CREATE INDEX scheduled_jobs_due_idx ON scheduled_jobs (run_at) WHERE status = 'pending';
CREATE UNIQUE INDEX scheduled_jobs_dedupe_uq ON scheduled_jobs (dedupe_key) WHERE status = 'pending' AND dedupe_key IS NOT NULL;

-- Доменные события (outbox): из них модуль уведомлений (этап 8) строит push и сообщения.
CREATE TABLE domain_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type         text NOT NULL,
  order_id     uuid,
  org_id       uuid,
  user_ids     uuid[] NOT NULL DEFAULT '{}',
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX domain_events_unprocessed_idx ON domain_events (id) WHERE processed_at IS NULL;
CREATE INDEX domain_events_order_idx ON domain_events (order_id, id);

-- ── Заказы ─────────────────────────────────────────────────────────────────
CREATE SEQUENCE order_number_seq START 100001;

CREATE TABLE orders (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number                     bigint NOT NULL UNIQUE DEFAULT nextval('order_number_seq'),
  customer_id                uuid NOT NULL REFERENCES users (id),
  quote_id                   uuid NOT NULL UNIQUE REFERENCES quotes (id),
  -- Заказ, оформленный независимым диспетчером (К-12, Л-7).
  agent_org_id               uuid REFERENCES organizations (id),
  source                     text NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'agent')),
  category_id                uuid NOT NULL REFERENCES equipment_categories (id),
  region_id                  uuid NOT NULL REFERENCES regions (id),
  site_point                 geography(Point, 4326) NOT NULL,
  site_address               text NOT NULL,
  site_comment               text,
  requirements               jsonb NOT NULL DEFAULT '{}'::jsonb,
  urgency                    text NOT NULL CHECK (urgency IN ('urgent', 'scheduled')),
  first_start_at             timestamptz NOT NULL,
  last_end_at                timestamptz NOT NULL,
  total_hours                int NOT NULL,
  status                     text NOT NULL,
  version                    int NOT NULL DEFAULT 0,
  -- Снимок цены для заказчика: не меняется никогда (Н-1, Н-21).
  rent_tariff_id             uuid NOT NULL REFERENCES tariffs (id),
  delivery_tariff_id         uuid NOT NULL REFERENCES tariffs (id),
  hour_price_kopecks         bigint NOT NULL,
  km_price_kopecks           bigint NOT NULL,
  rent_kopecks               bigint NOT NULL,
  customer_delivery_kopecks  bigint NOT NULL,
  customer_delivery_km       numeric(8, 1) NOT NULL,
  total_kopecks              bigint NOT NULL,
  prepayment_kopecks         bigint NOT NULL,
  extra_hours                int NOT NULL DEFAULT 0,
  extra_kopecks              bigint NOT NULL DEFAULT 0,
  -- Фактическая доставка текущего исполнителя (Н-2, П-3).
  partner_delivery_km        numeric(8, 1),
  partner_delivery_kopecks   bigint,
  -- Текущий исполнитель.
  partner_org_id             uuid REFERENCES organizations (id),
  equipment_unit_id          uuid REFERENCES equipment_units (id),
  managing_member_id         uuid REFERENCES organization_members (id),
  -- Поиск.
  search_started_at          timestamptz,
  search_deadline_at         timestamptz,
  search_round               int NOT NULL DEFAULT 0,
  -- Оплата (заполняет модуль платежей, этап 7).
  prepaid_at                 timestamptz,
  prepayment_deadline_at     timestamptz,
  assignment_deadline_at     timestamptz,
  completion_reported_at     timestamptz,
  completed_at               timestamptz,
  auto_completed             boolean NOT NULL DEFAULT false,
  cancelled_at               timestamptz,
  cancelled_by               text CHECK (cancelled_by IN ('customer', 'partner', 'system', 'admin')),
  cancellation_reason        text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_customer_idx ON orders (customer_id, created_at DESC);
CREATE INDEX orders_partner_idx ON orders (partner_org_id, created_at DESC);
CREATE INDEX orders_status_idx ON orders (status);
CREATE TRIGGER orders_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Смены заказа (Л-1, К-3): у каждой свой машинист и свой ход выполнения.
CREATE TABLE order_shifts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id             uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  seq                  int NOT NULL,
  starts_at            timestamptz NOT NULL,
  ends_at              timestamptz NOT NULL,
  hours                int NOT NULL,
  work_date            date NOT NULL,          -- день начала в часовом поясе объекта (П-4)
  operator_user_id     uuid REFERENCES users (id),
  operator_member_id   uuid REFERENCES organization_members (id),
  status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'en_route', 'arrived', 'in_progress', 'finished', 'cancelled')),
  assign_deadline_at   timestamptz,
  UNIQUE (order_id, seq)
);

-- Единый календарь машиниста: один заказ (смена) в календарный день (Р-5, П-4).
CREATE TABLE operator_day_assignments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users (id),
  work_date      date NOT NULL,
  order_id       uuid NOT NULL REFERENCES orders (id),
  shift_id       uuid NOT NULL REFERENCES order_shifts (id),
  org_id         uuid NOT NULL REFERENCES organizations (id),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'declined', 'replaced', 'cancelled', 'done')),
  assigned_by    uuid REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz
);
CREATE UNIQUE INDEX operator_day_one_order_uq ON operator_day_assignments (user_id, work_date) WHERE status = 'active';

ALTER TABLE unit_bookings ADD CONSTRAINT unit_bookings_order_fk FOREIGN KEY (order_id) REFERENCES orders (id);

-- Полная история статусов (ТЗ §11), включая офлайн-события машиниста (Р-18, П-15).
CREATE TABLE order_status_history (
  id                          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id                    uuid NOT NULL REFERENCES orders (id),
  shift_id                    uuid REFERENCES order_shifts (id),
  from_status                 text,
  to_status                   text NOT NULL,
  actor_type                  text NOT NULL CHECK (actor_type IN ('customer', 'partner', 'operator', 'system', 'admin')),
  actor_id                    uuid,
  reason                      text,
  meta                        jsonb,
  client_event_id             uuid UNIQUE,
  device_recorded_at          timestamptz,
  point                       geography(Point, 4326),
  location_unavailable_reason text,
  created_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_status_history_order_idx ON order_status_history (order_id, id);
CREATE TRIGGER order_status_history_append_only BEFORE UPDATE OR DELETE ON order_status_history
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

-- Предложения (ТЗ §8): одновременно — не больше одного активного на заказ.
CREATE TABLE order_offers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES orders (id),
  unit_id        uuid NOT NULL REFERENCES equipment_units (id),
  org_id         uuid NOT NULL REFERENCES organizations (id),
  search_round   int NOT NULL,
  radius_km      int NOT NULL,
  distance_km    numeric(8, 1) NOT NULL,
  score          numeric(6, 4) NOT NULL,
  score_details  jsonb NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'skipped', 'expired', 'revoked', 'failed')),
  offered_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  responded_at   timestamptz,
  responder_id   uuid REFERENCES users (id)
);
CREATE UNIQUE INDEX order_offers_one_pending_uq ON order_offers (order_id) WHERE status = 'pending';
CREATE UNIQUE INDEX order_offers_unit_round_uq ON order_offers (order_id, unit_id, search_round);
CREATE INDEX order_offers_org_pending_idx ON order_offers (org_id) WHERE status = 'pending';

-- Компании, исключённые из поиска по заказу (П-12, Н-14, К-8).
CREATE TABLE order_excluded_orgs (
  order_id    uuid NOT NULL REFERENCES orders (id),
  org_id      uuid NOT NULL REFERENCES organizations (id),
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, org_id)
);

-- История назначений техники и машинистов (Р-3, Р-8, Р-16).
CREATE TABLE order_assignments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES orders (id),
  shift_id           uuid REFERENCES order_shifts (id),
  org_id             uuid NOT NULL REFERENCES organizations (id),
  unit_id            uuid REFERENCES equipment_units (id),
  operator_user_id   uuid REFERENCES users (id),
  kind               text NOT NULL CHECK (kind IN ('accepted', 'operator_assigned', 'operator_replaced', 'operator_declined',
                                                    'unit_replaced', 'released', 'returned_to_search')),
  actor_id           uuid REFERENCES users (id),
  reason             text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_assignments_order_idx ON order_assignments (order_id, created_at);

-- «Сообщить о проблеме» (Р-17).
CREATE TABLE order_incidents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES orders (id),
  shift_id      uuid REFERENCES order_shifts (id),
  reported_by   uuid NOT NULL REFERENCES users (id),
  type          text NOT NULL CHECK (type IN ('breakdown', 'other')),
  comment       text,
  file_ids      uuid[] NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Факты по надёжности компании (Р-7, Н-14, К-7).
CREATE TABLE partner_incidents (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organizations (id),
  order_id    uuid REFERENCES orders (id),
  type        text NOT NULL CHECK (type IN ('assignment_timeout', 'replacement_timeout', 'operator_declined',
                                             'released_order', 'partner_cancelled', 'offer_expired', 'offer_skipped')),
  meta        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX partner_incidents_org_idx ON partner_incidents (org_id, created_at DESC);

ALTER TABLE orders
  ADD COLUMN cancellation_fee_kopecks bigint,
  ADD COLUMN replacement_deadline_at timestamptz;
