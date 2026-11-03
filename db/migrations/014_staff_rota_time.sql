-- Phase 1 DayTeam minimum — staff, assignments, planned rota, actual time
-- Planned rota and actual attendance are separate (Brief §8).

CREATE TABLE staff_profiles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id         uuid REFERENCES users(id) ON DELETE RESTRICT,
  given_name      text NOT NULL,
  family_name     text NOT NULL,
  email           citext,
  phone_e164      text,
  job_title       text,
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'inactive', 'left')),
  started_on      date,
  left_on         date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TRIGGER staff_profiles_set_updated_at
  BEFORE UPDATE ON staff_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE UNIQUE INDEX staff_profiles_user_uidx
  ON staff_profiles (tenant_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE TABLE staff_qualifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  staff_profile_id  uuid NOT NULL,
  title             text NOT NULL,
  awarded_on        date,
  expires_on        date,
  reference_code    text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_profile_id)
    REFERENCES staff_profiles (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE staff_assignments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  staff_profile_id  uuid NOT NULL,
  site_id           uuid NOT NULL,
  room_id           uuid,
  role_label        text NOT NULL DEFAULT 'practitioner',
  effective_from    date NOT NULL DEFAULT CURRENT_DATE,
  effective_to      date,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_profile_id)
    REFERENCES staff_profiles (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, room_id) REFERENCES rooms (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE rota_shifts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  staff_profile_id  uuid NOT NULL,
  site_id           uuid NOT NULL,
  room_id           uuid,
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,
  status            text NOT NULL DEFAULT 'planned'
                      CHECK (status IN ('planned', 'cancelled')),
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (ends_at > starts_at),
  FOREIGN KEY (tenant_id, staff_profile_id)
    REFERENCES staff_profiles (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, room_id) REFERENCES rooms (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER rota_shifts_set_updated_at
  BEFORE UPDATE ON rota_shifts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX rota_shifts_site_time_idx
  ON rota_shifts(tenant_id, site_id, starts_at);

CREATE TABLE time_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  staff_profile_id  uuid NOT NULL,
  site_id           uuid NOT NULL,
  event_type        text NOT NULL
                      CHECK (event_type IN ('clock_in', 'clock_out', 'break_start', 'break_end')),
  occurred_at       timestamptz NOT NULL,
  recorded_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_profile_id)
    REFERENCES staff_profiles (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX time_events_staff_time_idx
  ON time_events(tenant_id, staff_profile_id, occurred_at);

CREATE TABLE leave_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  staff_profile_id  uuid NOT NULL,
  starts_on         date NOT NULL,
  ends_on           date NOT NULL,
  leave_type        text NOT NULL DEFAULT 'annual',
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'declined', 'cancelled')),
  reason            text,
  decided_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  decided_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (ends_on >= starts_on),
  FOREIGN KEY (tenant_id, staff_profile_id)
    REFERENCES staff_profiles (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER leave_requests_set_updated_at
  BEFORE UPDATE ON leave_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
