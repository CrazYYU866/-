-- Промокоды (В-33, К-13, Л-8, Н-15) и оплата юрлиц по счёту (К-1, Л-5).

CREATE TABLE promo_codes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              citext NOT NULL UNIQUE,
  percent           int NOT NULL CHECK (percent BETWEEN 1 AND 100),
  first_order_only  boolean NOT NULL DEFAULT true,
  valid_from        timestamptz,
  valid_to          timestamptz,
  max_uses          int CHECK (max_uses > 0),
  personal_user_id  uuid REFERENCES users (id),
  active            boolean NOT NULL DEFAULT true,
  description       text,
  created_by        uuid REFERENCES admin_users (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER promo_codes_updated_at BEFORE UPDATE ON promo_codes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE quotes ADD COLUMN promo_code_id uuid REFERENCES promo_codes (id), ADD COLUMN discount_kopecks bigint NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN promo_code_id uuid REFERENCES promo_codes (id), ADD COLUMN discount_kopecks bigint NOT NULL DEFAULT 0;
CREATE INDEX orders_promo_idx ON orders (promo_code_id) WHERE promo_code_id IS NOT NULL;

-- Производственный календарь: исключения из правила «сб и вс — выходные» (праздники, переносы). Заполняет администратор.
CREATE TABLE business_calendar (
  day         date PRIMARY KEY,
  is_working  boolean NOT NULL,
  note        text
);

-- Счета на оплату юрлицам (К-1, Л-5). Номер — сквозной.
CREATE SEQUENCE invoice_number_seq START 1;
CREATE TABLE invoices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number             bigint NOT NULL UNIQUE DEFAULT nextval('invoice_number_seq'),
  order_id           uuid NOT NULL REFERENCES orders (id),
  part               text NOT NULL CHECK (part IN ('first', 'final')),
  amount_kopecks     bigint NOT NULL CHECK (amount_kopecks > 0),
  legal_profile_id   uuid NOT NULL REFERENCES customer_legal_profiles (id),
  seller             jsonb NOT NULL,   -- реквизиты платформы на момент выставления
  buyer              jsonb NOT NULL,   -- реквизиты заказчика на момент выставления
  status             text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'paid', 'cancelled', 'expired')),
  due_at             timestamptz NOT NULL,
  issued_at          timestamptz NOT NULL DEFAULT now(),
  paid_at            timestamptz,
  marked_paid_by     uuid REFERENCES admin_users (id),
  payment_id         uuid REFERENCES payments (id)
);
CREATE UNIQUE INDEX invoices_one_open_per_part_uq ON invoices (order_id, part) WHERE status = 'issued';
