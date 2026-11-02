-- Children / families structural stubs for isolation tests (Phase 1 deepens APIs)

CREATE TABLE children (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  given_name          text NOT NULL,
  family_name         text NOT NULL,
  preferred_name      text,
  date_of_birth       date NOT NULL,
  enrolment_status    text NOT NULL DEFAULT 'lead'
                        CHECK (enrolment_status IN ('lead', 'waiting', 'active', 'graduated', 'withdrawn')),
  start_date          date,
  leave_date          date,
  deleted_at          timestamptz,
  anonymised_at       timestamptz,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TRIGGER children_set_updated_at
  BEFORE UPDATE ON children
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX children_tenant_status_idx ON children(tenant_id, enrolment_status)
  WHERE deleted_at IS NULL;

CREATE TABLE guardians (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id                   uuid REFERENCES users(id) ON DELETE RESTRICT,
  given_name                text NOT NULL,
  family_name               text NOT NULL,
  email                     citext,
  phone_e164                text,
  marketing_email_opt_in    boolean NOT NULL DEFAULT false,
  marketing_sms_opt_in      boolean NOT NULL DEFAULT false,
  sms_opted_out_at          timestamptz,
  deleted_at                timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TRIGGER guardians_set_updated_at
  BEFORE UPDATE ON guardians
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE child_guardian_relationships (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  child_id                    uuid NOT NULL,
  guardian_id                 uuid NOT NULL,
  relationship                text NOT NULL DEFAULT 'guardian',
  has_parental_responsibility boolean NOT NULL DEFAULT false,
  is_billing_contact          boolean NOT NULL DEFAULT false,
  is_emergency_contact        boolean NOT NULL DEFAULT false,
  is_authorised_collector     boolean NOT NULL DEFAULT false,
  access_level                text NOT NULL DEFAULT 'full'
                                CHECK (access_level IN ('full', 'limited', 'none')),
  revoked_at                  timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, child_id, guardian_id),
  FOREIGN KEY (tenant_id, child_id) REFERENCES children (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, guardian_id) REFERENCES guardians (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX child_guardian_guardian_idx
  ON child_guardian_relationships(tenant_id, guardian_id)
  WHERE revoked_at IS NULL;

CREATE TABLE relationship_restrictions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  child_id              uuid NOT NULL,
  subject_guardian_id   uuid NOT NULL,
  restriction_type      text NOT NULL,
  notes_ref             text,
  effective_from        timestamptz NOT NULL DEFAULT now(),
  effective_to          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, child_id) REFERENCES children (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, subject_guardian_id) REFERENCES guardians (tenant_id, id) ON DELETE RESTRICT
);
