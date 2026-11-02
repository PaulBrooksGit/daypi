-- Platform billing draft structures (no live billing / promotional grants — D03/D04)
-- Storage metadata (private objects)

CREATE TABLE platform_subscriptions (
  tenant_id              uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  plan_code              text NOT NULL DEFAULT 'draft_standard_39',
  pricing_version_id     text NOT NULL DEFAULT 'draft_v0',
  status                 text NOT NULL DEFAULT 'trialing'
                           CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled')),
  external_customer_ref  text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER platform_subscriptions_set_updated_at
  BEFORE UPDATE ON platform_subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE usage_accounts (
  tenant_id       uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  balance_minor   integer NOT NULL DEFAULT 0,
  currency        char(3) NOT NULL DEFAULT 'GBP',
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER usage_accounts_set_updated_at
  BEFORE UPDATE ON usage_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE usage_ledger_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  amount_minor      integer NOT NULL CHECK (amount_minor <> 0),
  balance_after_minor integer NOT NULL,
  kind              text NOT NULL
                      CHECK (kind IN (
                        'grant', 'purchase', 'reservation', 'charge',
                        'release', 'refund', 'adjustment'
                      )),
  -- welcome / promotional grants stay disabled in application until D04
  reference_type    text,
  reference_id      uuid,
  idempotency_key   text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, id)
);

CREATE TRIGGER usage_ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON usage_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE stored_objects (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  storage_key         text NOT NULL,
  content_type        text NOT NULL,
  size_bytes          bigint NOT NULL CHECK (size_bytes >= 0),
  checksum_sha256     text,
  scan_status         text NOT NULL DEFAULT 'pending'
                        CHECK (scan_status IN ('pending', 'clean', 'quarantine')),
  created_by_user_id  uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, storage_key)
);

CREATE INDEX stored_objects_tenant_created_idx ON stored_objects(tenant_id, created_at DESC);
