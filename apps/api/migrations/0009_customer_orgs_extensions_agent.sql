-- Организации заказчиков (Н-30), продление работ (Н-5, Н-28), заказ независимого диспетчера по SMS-ссылке (Н-27, Н-30).

-- ── Организации заказчиков ─────────────────────────────────────────────────
-- customer_legal_profiles становится организацией заказчика: user_id — руководитель, создавший её.
DROP INDEX customer_legal_profiles_user_inn_uq;
-- Одна организация на ИНН: чужую организацию нельзя привязать к себе по ИНН (Н-30).
CREATE UNIQUE INDEX customer_legal_profiles_inn_uq ON customer_legal_profiles (inn) WHERE archived_at IS NULL;

CREATE TABLE customer_org_members (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id   uuid NOT NULL REFERENCES customer_legal_profiles (id),
  user_id      uuid NOT NULL REFERENCES users (id),
  role         text NOT NULL CHECK (role IN ('owner', 'employee')),
  status       text NOT NULL CHECK (status IN ('invited', 'active', 'removed')),
  invited_by   uuid REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_id, user_id)
);
CREATE UNIQUE INDEX customer_org_members_one_owner_uq ON customer_org_members (profile_id) WHERE role = 'owner';
INSERT INTO customer_org_members (profile_id, user_id, role, status)
  SELECT id, user_id, 'owner', 'active' FROM customer_legal_profiles;

-- ── Продление работ ────────────────────────────────────────────────────────
CREATE TABLE order_extensions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES orders (id),
  shift_id        uuid NOT NULL REFERENCES order_shifts (id),
  hours           int NOT NULL CHECK (hours > 0),
  amount_kopecks  bigint NOT NULL CHECK (amount_kopecks > 0),
  status          text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected', 'cancelled')),
  requested_by    uuid NOT NULL REFERENCES users (id),
  decided_by      uuid REFERENCES users (id),
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX order_extensions_one_open_uq ON order_extensions (order_id) WHERE status = 'requested';

ALTER TABLE payments DROP CONSTRAINT payments_part_check;
ALTER TABLE payments ADD CONSTRAINT payments_part_check CHECK (part IN ('first', 'final', 'extra'));
DROP INDEX payments_one_success_per_part_uq;
CREATE UNIQUE INDEX payments_one_success_per_part_uq ON payments (order_id, part) WHERE status = 'succeeded' AND part <> 'extra';

-- ── Заказ независимого диспетчера ─────────────────────────────────────────
ALTER TABLE orders
  ADD COLUMN customer_link_token_hash text UNIQUE,
  ADD COLUMN customer_confirmed_at timestamptz,
  ADD COLUMN created_by_user_id uuid REFERENCES users (id);
-- Плательщик выбирается фактическим заказчиком при подтверждении ссылки — до этого он не определён.
ALTER TABLE orders ALTER COLUMN payer_kind DROP NOT NULL;
ALTER TABLE quotes ADD COLUMN agent_org_id uuid REFERENCES organizations (id);
