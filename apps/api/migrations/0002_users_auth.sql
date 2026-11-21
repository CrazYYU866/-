-- Пользователи и вход по SMS (ТЗ §2.1, §2.2, §19).

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone           text NOT NULL UNIQUE CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  full_name       text,
  photo_file_id   uuid,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  blocked_reason  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Запрос кода: хранится только хэш кода.
CREATE TABLE otp_challenges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         text NOT NULL,
  app           text NOT NULL CHECK (app IN ('client', 'partner')),
  code_hash     text NOT NULL,
  attempts      int  NOT NULL DEFAULT 0,
  max_attempts  int  NOT NULL,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  ip            inet,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_challenges_phone_idx ON otp_challenges (phone, app, created_at DESC);

-- Сессии: refresh-токен хранится как хэш; ротация в пределах «семьи».
-- Повторное использование старого токена отзывает всю семью.
CREATE TABLE auth_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  app                 text NOT NULL CHECK (app IN ('client', 'partner')),
  family_id           uuid NOT NULL,
  refresh_token_hash  text NOT NULL UNIQUE,
  device_id           text,
  user_agent          text,
  ip                  inet,
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  revoke_reason       text CHECK (revoke_reason IN ('rotated', 'logout', 'reuse_detected', 'user_blocked', 'admin')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX auth_sessions_family_idx ON auth_sessions (family_id);

CREATE TABLE push_devices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  app         text NOT NULL CHECK (app IN ('client', 'partner')),
  platform    text NOT NULL CHECK (platform IN ('ios', 'android')),
  token       text NOT NULL UNIQUE,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_devices_user_idx ON push_devices (user_id) WHERE active;
CREATE TRIGGER push_devices_updated_at BEFORE UPDATE ON push_devices FOR EACH ROW EXECUTE FUNCTION set_updated_at();
