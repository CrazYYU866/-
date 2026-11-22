-- Финансы: тип заказчика, платежи, возвраты, решения по отменам, журнал двойной записи, долги, выплаты
-- (ТЗ §14; Ф-1…Ф-3; Н-9, Н-10, Н-23; К-1, К-9, К-14; Л-5, Л-9; решения 07).

-- ── Заказчики-юрлица (Н-30) ────────────────────────────────────────────────
CREATE TABLE customer_legal_profiles (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users (id),
  inn            text NOT NULL CHECK (inn ~ '^(\d{10}|\d{12})$'),
  kpp            text CHECK (kpp ~ '^\d{9}$'),
  name           text NOT NULL,
  legal_address  text NOT NULL,
  email          citext NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  archived_at    timestamptz
);
CREATE UNIQUE INDEX customer_legal_profiles_user_inn_uq ON customer_legal_profiles (user_id, inn) WHERE archived_at IS NULL;
CREATE INDEX customer_legal_profiles_inn_idx ON customer_legal_profiles (inn);

ALTER TABLE orders
  ADD COLUMN payer_kind text NOT NULL DEFAULT 'individual' CHECK (payer_kind IN ('individual', 'legal')),
  ADD COLUMN payer_legal_profile_id uuid REFERENCES customer_legal_profiles (id),
  ADD COLUMN paid_kopecks bigint NOT NULL DEFAULT 0,
  ADD COLUMN refunded_kopecks bigint NOT NULL DEFAULT 0,
  ADD COLUMN final_payment_due_at timestamptz,
  ADD COLUMN settled_at timestamptz,
  ADD COLUMN commission_kopecks bigint,
  ADD COLUMN agent_kopecks bigint,
  ADD COLUMN platform_kopecks bigint,
  ADD COLUMN partner_amount_kopecks bigint,
  ADD COLUMN delivery_subsidy_kopecks bigint,
  ADD CONSTRAINT orders_payer_legal_chk CHECK ((payer_kind = 'legal') = (payer_legal_profile_id IS NOT NULL));

-- Сумма «к оплате сейчас»: у физлица — 100% (07), у юрлица — 50%. Колонку prepayment_kopecks переиспользуем как «первый платёж».
COMMENT ON COLUMN orders.prepayment_kopecks IS 'Первый платёж: физлицо — 100% суммы, юрлицо — 50% (решения 07)';
ALTER TABLE orders DROP COLUMN cancellation_fee_kopecks;

-- ── Платежи ────────────────────────────────────────────────────────────────
CREATE TABLE payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              uuid NOT NULL REFERENCES orders (id),
  part                  text NOT NULL CHECK (part IN ('first', 'final')),
  amount_kopecks        bigint NOT NULL CHECK (amount_kopecks > 0),
  provider              text NOT NULL,
  provider_payment_id   text,
  confirmation_url      text,
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'cancelled', 'failed')),
  idempotency_key       text NOT NULL UNIQUE,
  created_at            timestamptz NOT NULL DEFAULT now(),
  paid_at               timestamptz,
  UNIQUE (provider, provider_payment_id)
);
-- Один успешный платёж каждой части заказа — защита от повторного списания.
CREATE UNIQUE INDEX payments_one_success_per_part_uq ON payments (order_id, part) WHERE status = 'succeeded';
-- Не больше одного ожидающего платежа на часть: повторное нажатие «Оплатить» возвращает тот же платёж.
CREATE UNIQUE INDEX payments_one_pending_per_part_uq ON payments (order_id, part) WHERE status = 'pending';

CREATE TABLE payment_webhook_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider      text NOT NULL,
  event_id      text NOT NULL,
  payload       jsonb NOT NULL,
  processed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

-- ── Решения поддержки по отменам (07) ─────────────────────────────────────
CREATE TABLE cancellation_reviews (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          uuid NOT NULL UNIQUE REFERENCES orders (id),
  initiated_by      text NOT NULL CHECK (initiated_by IN ('customer', 'partner', 'system', 'admin')),
  reason            text,
  paid_kopecks      bigint NOT NULL,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'awaiting_approval', 'decided')),
  decision          text CHECK (decision IN ('full_refund', 'partial_refund', 'full_retention')),
  retained_kopecks  bigint,
  refund_kopecks    bigint,
  decision_reason   text,
  -- Распределение удержанного (Ф-3).
  partner_kopecks   bigint,
  agent_kopecks     bigint,
  platform_kopecks  bigint,
  decided_by        uuid REFERENCES admin_users (id),
  decided_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'pending' OR (retained_kopecks + refund_kopecks = paid_kopecks AND retained_kopecks >= 0 AND refund_kopecks >= 0))
);

-- ── Возвраты ──────────────────────────────────────────────────────────────
CREATE TABLE refunds (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id             uuid NOT NULL REFERENCES orders (id),
  payment_id           uuid NOT NULL REFERENCES payments (id),
  amount_kopecks       bigint NOT NULL CHECK (amount_kopecks > 0),
  status               text NOT NULL CHECK (status IN ('pending_approval', 'processing', 'succeeded', 'failed', 'rejected')),
  reason               text NOT NULL,
  requested_by         uuid REFERENCES admin_users (id),
  approved_by          uuid REFERENCES admin_users (id),
  provider_refund_id   text,
  idempotency_key      text NOT NULL UNIQUE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz
);
CREATE INDEX refunds_order_idx ON refunds (order_id);

-- ── Журнал двойной записи (ТЗ §14, §19) ──────────────────────────────────
-- Сумма проводок каждой транзакции = 0. Ключ идемпотентности не даёт провести одну операцию дважды.
CREATE TABLE ledger_transactions (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind             text NOT NULL,
  order_id         uuid REFERENCES orders (id),
  idempotency_key  text NOT NULL UNIQUE,
  meta             jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ledger_entries (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id  bigint NOT NULL REFERENCES ledger_transactions (id),
  account         text NOT NULL,
  -- Дебет — положительное число, кредит — отрицательное. Копейки.
  amount_kopecks  bigint NOT NULL CHECK (amount_kopecks <> 0),
  order_id        uuid REFERENCES orders (id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account, created_at);
CREATE INDEX ledger_entries_order_idx ON ledger_entries (order_id);

CREATE OR REPLACE FUNCTION ledger_check_balance() RETURNS trigger AS $$
DECLARE s bigint;
BEGIN
  SELECT COALESCE(sum(amount_kopecks), 0) INTO s FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF s <> 0 THEN RAISE EXCEPTION 'Проводки транзакции % не сбалансированы: %', NEW.transaction_id, s; END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_balance();
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER ledger_transactions_append_only BEFORE UPDATE OR DELETE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

-- ── Долги юрлиц по второй части (Н-9, К-9) ───────────────────────────────
CREATE TABLE customer_debts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          uuid NOT NULL UNIQUE REFERENCES orders (id),
  customer_id       uuid NOT NULL REFERENCES users (id),
  legal_profile_id  uuid REFERENCES customer_legal_profiles (id),
  inn               text,
  amount_kopecks    bigint NOT NULL CHECK (amount_kopecks > 0),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'written_off')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz
);
CREATE INDEX customer_debts_open_idx ON customer_debts (customer_id) WHERE status = 'open';
CREATE INDEX customer_debts_inn_open_idx ON customer_debts (inn) WHERE status = 'open';

-- ── Выплаты исполнителям и диспетчерам (Н-10) ────────────────────────────
CREATE TABLE payouts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations (id),
  kind                 text NOT NULL CHECK (kind IN ('partner', 'agent')),
  payout_date          date NOT NULL,
  amount_kopecks       bigint NOT NULL CHECK (amount_kopecks > 0),
  status               text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'paid', 'failed', 'blocked')),
  status_reason        text,
  bank_account_id      uuid REFERENCES organization_bank_accounts (id),
  provider             text,
  provider_payout_id   text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  paid_at              timestamptz,
  UNIQUE (org_id, kind, payout_date)
);
CREATE TABLE payout_items (
  payout_id       uuid NOT NULL REFERENCES payouts (id),
  order_id        uuid NOT NULL REFERENCES orders (id),
  kind            text NOT NULL CHECK (kind IN ('partner', 'agent')),
  source          text NOT NULL CHECK (source IN ('completion', 'cancellation')),
  amount_kopecks  bigint NOT NULL,
  -- Одна выплата исполнителю и одна диспетчеру по каждому заказу — защита от повторной выплаты.
  PRIMARY KEY (order_id, kind)
);
