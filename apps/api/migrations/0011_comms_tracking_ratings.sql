-- Уведомления (ТЗ §16), чат (ТЗ §10, П-14), звонки (ТЗ §10, В-27, В-35), GPS (ТЗ §9, Р-19–21, П-1, П-2, П-16), оценки (В-29, В-30).

CREATE TABLE notifications (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users (id),
  type        text NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL,
  order_id    uuid REFERENCES orders (id),
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, id DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- Чат: канал заказа (заказчик + машинист + диспетчеры и руководители) и внутренний канал компании (без заказчика).
CREATE TABLE chat_messages (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id        uuid NOT NULL REFERENCES orders (id),
  channel         text NOT NULL CHECK (channel IN ('order', 'internal')),
  sender_user_id  uuid REFERENCES users (id),
  sender_role     text NOT NULL CHECK (sender_role IN ('customer', 'operator', 'dispatcher', 'manager', 'owner', 'support', 'system')),
  body            text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_order_idx ON chat_messages (order_id, channel, id);
CREATE TABLE chat_reads (
  order_id      uuid NOT NULL REFERENCES orders (id),
  channel       text NOT NULL,
  user_id       uuid NOT NULL REFERENCES users (id),
  last_read_id  bigint NOT NULL,
  PRIMARY KEY (order_id, channel, user_id)
);

-- Звонки через подменные номера: реальные номера сторон не раскрываются.
CREATE TABLE call_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES orders (id),
  caller_user_id     uuid NOT NULL REFERENCES users (id),
  callee_user_id     uuid NOT NULL REFERENCES users (id),
  provider           text NOT NULL,
  virtual_number     text NOT NULL,
  provider_session_id text,
  status             text NOT NULL DEFAULT 'allocated' CHECK (status IN ('allocated', 'completed', 'missed', 'failed', 'expired')),
  duration_sec       int,
  recording_file_id  uuid REFERENCES files (id),
  expires_at         timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX call_sessions_order_idx ON call_sessions (order_id, created_at);

-- GPS телефона машиниста — только по активному заказу и только после «Выехал» (П-1).
CREATE TABLE location_pings (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id      uuid NOT NULL REFERENCES orders (id),
  shift_id      uuid REFERENCES order_shifts (id),
  user_id       uuid NOT NULL REFERENCES users (id),
  point         geography(Point, 4326) NOT NULL,
  accuracy_m    real,
  speed_mps     real,
  heading       real,
  battery       real,
  phase         text NOT NULL CHECK (phase IN ('en_route', 'on_site')),
  recorded_at   timestamptz NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX location_pings_order_idx ON location_pings (order_id, recorded_at);

-- Оценки (В-29, В-30): не публичные; видят участники заказа и администрация.
CREATE TABLE ratings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid NOT NULL REFERENCES orders (id),
  author_user_id   uuid NOT NULL REFERENCES users (id),
  author_side      text NOT NULL CHECK (author_side IN ('customer', 'partner')),
  target_user_id   uuid NOT NULL REFERENCES users (id),
  target_kind      text NOT NULL CHECK (target_kind IN ('operator', 'customer')),
  stars            int NOT NULL CHECK (stars BETWEEN 1 AND 5),
  text             text CHECK (length(text) <= 2000),
  status           text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden')),
  hidden_reason    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, author_side, target_user_id)
);
CREATE INDEX ratings_target_idx ON ratings (target_user_id) WHERE status = 'visible';
CREATE TABLE rating_complaints (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rating_id    uuid NOT NULL REFERENCES ratings (id),
  author_id    uuid NOT NULL REFERENCES users (id),
  reason       text NOT NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution   text,
  resolved_by  uuid REFERENCES admin_users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rating_id, author_id)
);
