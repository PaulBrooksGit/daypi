-- Identity / tenancy (ADR-03, ERD §5.1)

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           citext NOT NULL UNIQUE,
  password_hash   text,
  mfa_enabled     boolean NOT NULL DEFAULT false,
  mfa_secret_enc  text,
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'locked', 'disabled')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_login_at   timestamptz
);

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE tenants (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name       text NOT NULL,
  setting_type       text NOT NULL DEFAULT 'childminder',
  primary_timezone   text NOT NULL DEFAULT 'Europe/London',
  status             text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'suspended', 'closed')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER tenants_set_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role_template   text NOT NULL,
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'invited', 'revoked')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  UNIQUE (tenant_id, user_id),
  UNIQUE (tenant_id, id)
);

CREATE INDEX memberships_user_id_idx ON memberships(user_id);
CREATE INDEX memberships_tenant_status_idx ON memberships(tenant_id, status);

CREATE TABLE permission_grants (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  membership_id           uuid,
  integration_client_id   uuid,
  operation               text NOT NULL,
  scope                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (membership_id IS NOT NULL AND integration_client_id IS NULL)
    OR (membership_id IS NULL AND integration_client_id IS NOT NULL)
  ),
  UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX permission_grants_membership_op_uidx
  ON permission_grants (membership_id, operation)
  WHERE membership_id IS NOT NULL;

CREATE UNIQUE INDEX permission_grants_client_op_uidx
  ON permission_grants (integration_client_id, operation)
  WHERE integration_client_id IS NOT NULL;

ALTER TABLE permission_grants
  ADD CONSTRAINT permission_grants_membership_fk
  FOREIGN KEY (tenant_id, membership_id)
  REFERENCES memberships (tenant_id, id)
  ON DELETE RESTRICT;

CREATE TABLE sites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name         text NOT NULL,
  timezone     text NOT NULL DEFAULT 'Europe/London',
  address_line1 text,
  address_line2 text,
  city         text,
  postal_code  text,
  country_code char(2) NOT NULL DEFAULT 'GB',
  is_primary   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TRIGGER sites_set_updated_at
  BEFORE UPDATE ON sites
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE UNIQUE INDEX sites_one_primary_per_tenant
  ON sites (tenant_id)
  WHERE is_primary;

CREATE TABLE verified_domains (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  hostname             citext NOT NULL UNIQUE,
  purpose              text NOT NULL
                         CHECK (purpose IN ('app_entry', 'public_site', 'redirect')),
  verification_status  text NOT NULL DEFAULT 'pending'
                         CHECK (verification_status IN ('pending', 'verified', 'revoked')),
  verified_at          timestamptz,
  certificate_state    text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE invitations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  email           citext NOT NULL,
  role_template   text NOT NULL,
  token_hash      text NOT NULL,
  invited_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  expires_at      timestamptz NOT NULL,
  accepted_at     timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE INDEX invitations_tenant_email_idx ON invitations(tenant_id, email);

CREATE TABLE integration_clients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name            text NOT NULL,
  secret_hash     text NOT NULL,
  scopes          text[] NOT NULL DEFAULT '{}',
  expires_at      timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

ALTER TABLE permission_grants
  ADD CONSTRAINT permission_grants_client_fk
  FOREIGN KEY (tenant_id, integration_client_id)
  REFERENCES integration_clients (tenant_id, id)
  ON DELETE RESTRICT;

CREATE TABLE entitlements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  module_key   text NOT NULL,
  enabled      boolean NOT NULL DEFAULT true,
  limits       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, module_key),
  UNIQUE (tenant_id, id)
);

CREATE TRIGGER entitlements_set_updated_at
  BEFORE UPDATE ON entitlements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_hash      text NOT NULL UNIQUE,
  active_tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  user_agent      text,
  ip_address      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);
