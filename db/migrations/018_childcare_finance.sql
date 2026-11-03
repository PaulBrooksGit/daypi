-- Core DayBank: childcare invoicing/payments + platform usage ledger helpers
-- Distinct from platform subscription context. Stripe sandbox only until D05.
-- Live collection gated by FEATURE_STRIPE_LIVE / disabled routes.

CREATE TABLE billing_accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  guardian_id           uuid,
  child_id              uuid,
  display_name          text NOT NULL,
  currency              char(3) NOT NULL DEFAULT 'GBP',
  status                text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'closed')),
  balance_minor         integer NOT NULL DEFAULT 0,
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, guardian_id) REFERENCES guardians (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, child_id) REFERENCES children (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER billing_accounts_set_updated_at
  BEFORE UPDATE ON billing_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE invoices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  billing_account_id    uuid NOT NULL,
  invoice_number        text NOT NULL,
  status                text NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'issued', 'void', 'credited')),
  currency              char(3) NOT NULL DEFAULT 'GBP',
  subtotal_minor        integer NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
  tax_minor             integer NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor           integer NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  amount_paid_minor     integer NOT NULL DEFAULT 0 CHECK (amount_paid_minor >= 0),
  issued_at             timestamptz,
  due_at                timestamptz,
  pricing_snapshot      jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key       text,
  created_by_user_id    uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, invoice_number),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, billing_account_id) REFERENCES billing_accounts (tenant_id, id) ON DELETE RESTRICT,
  CHECK (amount_paid_minor <= total_minor OR status IN ('credited', 'void'))
);

CREATE TRIGGER invoices_set_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Issued invoice money/snapshot fields are immutable; only paid amount / void/credit status may change.
CREATE OR REPLACE FUNCTION protect_issued_invoice() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'issued' THEN
    IF NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor
       OR NEW.tax_minor IS DISTINCT FROM OLD.tax_minor
       OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.pricing_snapshot IS DISTINCT FROM OLD.pricing_snapshot
       OR NEW.billing_account_id IS DISTINCT FROM OLD.billing_account_id
       OR NEW.invoice_number IS DISTINCT FROM OLD.invoice_number
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at THEN
      RAISE EXCEPTION 'issued invoice fields are immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW.status NOT IN ('issued', 'void', 'credited') THEN
      RAISE EXCEPTION 'invalid issued invoice status transition' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.status IN ('void', 'credited') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'terminal invoice status cannot change' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER invoices_protect_issued
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION protect_issued_invoice();

CREATE TABLE invoice_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  invoice_id            uuid NOT NULL,
  description           text NOT NULL,
  quantity              integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_amount_minor     integer NOT NULL,
  amount_minor          integer NOT NULL,
  child_id              uuid,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, child_id) REFERENCES children (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE invoice_credits (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  invoice_id            uuid NOT NULL,
  amount_minor          integer NOT NULL CHECK (amount_minor > 0),
  reason                text NOT NULL,
  created_by_user_id    uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER invoice_credits_append_only
  BEFORE UPDATE OR DELETE ON invoice_credits
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE payment_attempts (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  invoice_id                  uuid NOT NULL,
  billing_account_id          uuid NOT NULL,
  amount_minor                integer NOT NULL CHECK (amount_minor > 0),
  currency                    char(3) NOT NULL DEFAULT 'GBP',
  status                      text NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'succeeded', 'failed', 'cancelled')),
  provider                    text NOT NULL DEFAULT 'stripe_sandbox'
                                CHECK (provider IN ('stripe_sandbox', 'manual_sandbox')),
  provider_payment_intent_id  text,
  provider_event_id           text,
  failure_code                text,
  idempotency_key             text NOT NULL,
  created_by_user_id          uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, billing_account_id) REFERENCES billing_accounts (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER payment_attempts_set_updated_at
  BEFORE UPDATE ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE UNIQUE INDEX payment_attempts_provider_intent_uidx
  ON payment_attempts(provider, provider_payment_intent_id)
  WHERE provider_payment_intent_id IS NOT NULL;

CREATE TABLE payment_allocations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  payment_attempt_id    uuid NOT NULL,
  invoice_id            uuid NOT NULL,
  amount_minor          integer NOT NULL CHECK (amount_minor > 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, payment_attempt_id, invoice_id),
  FOREIGN KEY (tenant_id, payment_attempt_id) REFERENCES payment_attempts (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER payment_allocations_append_only
  BEFORE UPDATE OR DELETE ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE finance_ledger_entries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  billing_account_id    uuid NOT NULL,
  amount_minor          integer NOT NULL CHECK (amount_minor <> 0),
  balance_after_minor   integer NOT NULL,
  kind                  text NOT NULL
                          CHECK (kind IN (
                            'invoice_issue', 'payment', 'refund', 'credit', 'adjustment'
                          )),
  reference_type        text,
  reference_id          uuid,
  idempotency_key       text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, billing_account_id) REFERENCES billing_accounts (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER finance_ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON finance_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE refunds (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  payment_attempt_id    uuid NOT NULL,
  amount_minor          integer NOT NULL CHECK (amount_minor > 0),
  reason                text NOT NULL,
  status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'succeeded', 'failed')),
  provider_refund_id    text,
  created_by_user_id    uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, payment_attempt_id) REFERENCES payment_attempts (tenant_id, id) ON DELETE RESTRICT
);

-- Platform usage: reservation / settlement helpers rely on existing usage_* tables.
-- Add optional link from ledger kinds already constrained in 004.
