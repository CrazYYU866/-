-- Организации-партнёры, сотрудники, документы, файлы, администраторы (ТЗ §3, §4, §19; Р-1…Р-17; В-32; В-40).

-- SMS-коды теперь бывают разного назначения (вход, смена реквизитов — П-17).
ALTER TABLE otp_challenges ADD COLUMN purpose text NOT NULL DEFAULT 'login'
  CHECK (purpose IN ('login', 'bank_account_change'));
DROP INDEX otp_challenges_phone_idx;
CREATE INDEX otp_challenges_phone_idx ON otp_challenges (phone, app, purpose, created_at DESC);

-- Администраторы (В-40).
CREATE TABLE admin_users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             citext NOT NULL UNIQUE,
  full_name         text NOT NULL,
  password_hash     text NOT NULL,
  role              text NOT NULL CHECK (role IN ('superadmin', 'support', 'finance', 'moderator')),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  totp_secret_enc   text,
  totp_enabled      boolean NOT NULL DEFAULT false,
  failed_logins     int NOT NULL DEFAULT 0,
  locked_until      timestamptz,
  last_login_at     timestamptz,
  created_by        uuid REFERENCES admin_users (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER admin_users_updated_at BEFORE UPDATE ON admin_users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE admin_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id            uuid NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  family_id           uuid NOT NULL,
  refresh_token_hash  text NOT NULL UNIQUE,
  ip                  inet,
  user_agent          text,
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  revoke_reason       text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_sessions_family_idx ON admin_sessions (family_id);

-- Журнал действий администраторов: только добавление.
CREATE TABLE admin_audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id    uuid REFERENCES admin_users (id),
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  before      jsonb,
  after       jsonb,
  reason      text,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_log_entity_idx ON admin_audit_log (entity, entity_id, created_at DESC);
CREATE TRIGGER admin_audit_log_append_only BEFORE UPDATE OR DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

-- Файлы. Документы — всегда приватные, выдаются только через API с проверкой прав.
CREATE TABLE files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key   text NOT NULL UNIQUE,
  mime          text NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),
  sha256        text NOT NULL,
  original_name text,
  uploaded_by_user_id   uuid REFERENCES users (id),
  uploaded_by_admin_id  uuid REFERENCES admin_users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (uploaded_by_user_id IS NOT NULL OR uploaded_by_admin_id IS NOT NULL)
);

-- Организации: ИП и юрлица (ТЗ §3), исполнители и независимые диспетчеры (К-12).
CREATE TABLE organizations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                 text NOT NULL CHECK (kind IN ('partner', 'agent')),
  legal_form           text NOT NULL CHECK (legal_form IN ('ip', 'llc', 'jsc', 'other_legal_entity')),
  name                 text NOT NULL,
  representative_name  text NOT NULL,
  inn                  text NOT NULL CHECK (inn ~ '^(\d{10}|\d{12})$'),
  ogrn                 text NOT NULL CHECK (ogrn ~ '^(\d{13}|\d{15})$'),
  kpp                  text CHECK (kpp ~ '^\d{9}$'),
  legal_address        text NOT NULL,
  email                citext NOT NULL,
  contact_phone        text NOT NULL,
  status               text NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'pending_review', 'verified', 'rejected', 'blocked')),
  rejection_reason     text,
  blocked_reason       text,
  registry_check       jsonb,
  verified_at          timestamptz,
  submitted_at         timestamptz,
  created_by           uuid NOT NULL REFERENCES users (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- ИП: ИНН 12 цифр, ОГРНИП 15; юрлицо: ИНН 10, ОГРН 13.
  CHECK ((legal_form = 'ip' AND length(inn) = 12 AND length(ogrn) = 15)
      OR (legal_form <> 'ip' AND length(inn) = 10 AND length(ogrn) = 13)),
  UNIQUE (inn, kind)
);
CREATE INDEX organizations_status_idx ON organizations (status, created_at);
CREATE TRIGGER organizations_updated_at BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE organization_status_history (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  from_status text,
  to_status   text NOT NULL,
  reason      text,
  actor_user_id   uuid REFERENCES users (id),
  actor_admin_id  uuid REFERENCES admin_users (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organization_status_history_org_idx ON organization_status_history (org_id, created_at);
CREATE TRIGGER organization_status_history_append_only BEFORE UPDATE OR DELETE ON organization_status_history
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

-- Банковские реквизиты: номер счёта шифруется на уровне приложения (ТЗ §19). Меняет только главный владелец (П-17).
CREATE TABLE organization_bank_accounts (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  bik                    text NOT NULL CHECK (bik ~ '^\d{9}$'),
  account_number_enc     text NOT NULL,
  account_number_last4   text NOT NULL,
  correspondent_account  text NOT NULL CHECK (correspondent_account ~ '^\d{20}$'),
  bank_name              text NOT NULL,
  is_current             boolean NOT NULL DEFAULT true,
  created_by             uuid NOT NULL REFERENCES users (id),
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX organization_bank_accounts_current_uq ON organization_bank_accounts (org_id) WHERE is_current;

-- Сотрудники. Роли: главный владелец (ровно один), руководитель, диспетчер, машинист (Р-10, Р-11).
-- can_operate: работает машинистом. Для роли operator всегда true; ИП-одиночка может назначать себя (П-13).
CREATE TABLE organization_members (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users (id),
  role         text NOT NULL CHECK (role IN ('owner', 'manager', 'dispatcher', 'operator')),
  can_operate  boolean NOT NULL DEFAULT false,
  status       text NOT NULL CHECK (status IN ('invited', 'active', 'blocked', 'detached')),
  invited_by   uuid REFERENCES users (id),
  joined_at    timestamptz,
  detached_at  timestamptz,
  detached_by  uuid REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id),
  CHECK (role <> 'operator' OR can_operate)
);
CREATE UNIQUE INDEX organization_members_one_owner_uq ON organization_members (org_id) WHERE role = 'owner';
-- Машинист работает только в одной компании (П-10).
CREATE UNIQUE INDEX organization_members_operator_one_company_uq ON organization_members (user_id)
  WHERE can_operate AND status = 'active';
CREATE INDEX organization_members_user_idx ON organization_members (user_id) WHERE status IN ('invited', 'active');
CREATE TRIGGER organization_members_updated_at BEFORE UPDATE ON organization_members FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE organization_ownership_history (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id           uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  from_user_id     uuid NOT NULL REFERENCES users (id),
  to_user_id       uuid NOT NULL REFERENCES users (id),
  admin_id         uuid NOT NULL REFERENCES admin_users (id),
  basis_file_ids   uuid[] NOT NULL,
  reason           text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Справочник типов документов (В-32). Управляется в админке.
CREATE TABLE document_types (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,
  title        text NOT NULL,
  applies_to   text NOT NULL CHECK (applies_to IN ('organization', 'equipment', 'operator')),
  legal_forms  text[],          -- NULL = для всех форм
  required     boolean NOT NULL DEFAULT true,
  has_expiry   boolean NOT NULL DEFAULT false,
  active       boolean NOT NULL DEFAULT true,
  sort         int NOT NULL DEFAULT 0
);

-- Стартовый набор по перечню В-32. Конкретные формулировки и обязательность администратор уточняет в админке.
INSERT INTO document_types (code, title, applies_to, legal_forms, required, sort) VALUES
  ('org_registration_record', 'Лист записи ЕГРЮЛ / ЕГРИП (подтверждение ОГРН/ОГРНИП)', 'organization', NULL, true, 10),
  ('org_inn_certificate', 'Документ о постановке на учёт в налоговом органе (ИНН)', 'organization', NULL, true, 20),
  ('org_director_authority', 'Документ о полномочиях руководителя (решение / протокол / приказ)', 'organization',
     ARRAY['llc', 'jsc', 'other_legal_entity'], true, 30),
  ('equipment_psm', 'ПСМ / ЭПСМ', 'equipment', NULL, false, 10),
  ('equipment_sts', 'СТС', 'equipment', NULL, false, 20),
  ('equipment_ownership', 'Подтверждение права собственности или законного пользования', 'equipment', NULL, true, 30),
  ('operator_passport', 'Паспорт', 'operator', NULL, true, 10),
  ('operator_tractor_license', 'Удостоверение тракториста-машиниста', 'operator', NULL, false, 20);

-- Загруженные документы и результат проверки.
CREATE TABLE documents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type         text NOT NULL CHECK (owner_type IN ('organization', 'equipment', 'operator')),
  owner_id           uuid NOT NULL,
  document_type_id   uuid NOT NULL REFERENCES document_types (id),
  file_id            uuid NOT NULL REFERENCES files (id),
  status             text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'approved', 'rejected', 'expired')),
  uploaded_by        uuid REFERENCES users (id),
  reviewer_admin_id  uuid REFERENCES admin_users (id),
  review_comment     text,
  reviewed_at        timestamptz,
  expires_at         date,
  superseded_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_owner_idx ON documents (owner_type, owner_id) WHERE superseded_at IS NULL;
CREATE INDEX documents_review_queue_idx ON documents (status, created_at) WHERE superseded_at IS NULL;

-- Проверка машиниста администрацией (В-32): назначать на заказ можно только проверенного.
ALTER TABLE organization_members
  ADD COLUMN operator_verification text NOT NULL DEFAULT 'not_submitted'
  CHECK (operator_verification IN ('not_submitted', 'pending', 'approved', 'rejected'));

-- Журнал значимых действий пользователей приложений (смена реквизитов — П-17, смена ролей, отвязка и т. п.).
CREATE TABLE user_action_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     uuid REFERENCES users (id),
  org_id      uuid REFERENCES organizations (id),
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  details     jsonb,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_action_log_org_idx ON user_action_log (org_id, created_at DESC);
CREATE TRIGGER user_action_log_append_only BEFORE UPDATE OR DELETE ON user_action_log
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
