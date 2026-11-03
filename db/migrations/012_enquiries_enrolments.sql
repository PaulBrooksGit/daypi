-- Phase 1 DayCore — enquiries and enrolments

CREATE TABLE enquiries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  site_id             uuid,
  child_given_name    text NOT NULL,
  child_family_name   text NOT NULL,
  child_date_of_birth date,
  guardian_given_name text NOT NULL,
  guardian_family_name text NOT NULL,
  guardian_email      citext,
  guardian_phone_e164 text,
  status              text NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'waiting', 'offered', 'accepted', 'declined', 'withdrawn', 'enrolled')),
  notes               text,
  source              text,
  child_id            uuid,
  guardian_id         uuid,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, child_id) REFERENCES children (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, guardian_id) REFERENCES guardians (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER enquiries_set_updated_at
  BEFORE UPDATE ON enquiries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX enquiries_tenant_status_idx ON enquiries(tenant_id, status);

CREATE TABLE enrolments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  site_id         uuid NOT NULL,
  child_id        uuid NOT NULL,
  enquiry_id      uuid,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'active', 'paused', 'ended', 'cancelled')),
  start_date      date NOT NULL,
  end_date        date,
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, child_id) REFERENCES children (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, enquiry_id) REFERENCES enquiries (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER enrolments_set_updated_at
  BEFORE UPDATE ON enrolments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX enrolments_tenant_child_idx ON enrolments(tenant_id, child_id);
CREATE INDEX enrolments_tenant_status_idx ON enrolments(tenant_id, status);
