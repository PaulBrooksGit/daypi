-- DayStep: outings/trips — participants, permissions, headcounts.
-- Live/background GPS gated by D08; optional online location samples only.

CREATE TABLE trips (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  site_id               uuid,
  title                 text NOT NULL,
  description           text NOT NULL DEFAULT '',
  destination           text NOT NULL DEFAULT '',
  status                text NOT NULL DEFAULT 'planned'
                          CHECK (status IN (
                            'planned',
                            'permissions_pending',
                            'ready',
                            'in_progress',
                            'completed',
                            'cancelled'
                          )),
  starts_at             timestamptz NOT NULL,
  ends_at               timestamptz,
  risk_summary          text NOT NULL DEFAULT '',
  created_by_user_id    uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id) ON DELETE RESTRICT,
  CHECK (ends_at IS NULL OR ends_at >= starts_at)
);

CREATE TRIGGER trips_set_updated_at
  BEFORE UPDATE ON trips
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX trips_tenant_status_idx ON trips(tenant_id, status, starts_at);

CREATE TABLE trip_participants (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  trip_id               uuid NOT NULL,
  child_id              uuid,
  staff_profile_id      uuid,
  role                  text NOT NULL DEFAULT 'child'
                          CHECK (role IN ('child', 'staff', 'volunteer')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, trip_id, child_id),
  FOREIGN KEY (tenant_id, trip_id) REFERENCES trips (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, child_id) REFERENCES children (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, staff_profile_id)
    REFERENCES staff_profiles (tenant_id, id) ON DELETE RESTRICT,
  CHECK (
    (role = 'child' AND child_id IS NOT NULL)
    OR (role IN ('staff', 'volunteer') AND staff_profile_id IS NOT NULL)
  )
);

CREATE TABLE trip_permissions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  trip_id               uuid NOT NULL,
  child_id              uuid NOT NULL,
  guardian_id           uuid NOT NULL,
  status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'granted', 'declined', 'revoked')),
  responded_at          timestamptz,
  response_note         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, trip_id, child_id, guardian_id),
  FOREIGN KEY (tenant_id, trip_id) REFERENCES trips (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, child_id) REFERENCES children (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, guardian_id) REFERENCES guardians (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER trip_permissions_set_updated_at
  BEFORE UPDATE ON trip_permissions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE trip_headcounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  trip_id               uuid NOT NULL,
  counted_at            timestamptz NOT NULL DEFAULT now(),
  expected_count        integer NOT NULL CHECK (expected_count >= 0),
  actual_count          integer NOT NULL CHECK (actual_count >= 0),
  notes                 text NOT NULL DEFAULT '',
  recorded_by_user_id   uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, trip_id) REFERENCES trips (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER trip_headcounts_append_only
  BEFORE UPDATE OR DELETE ON trip_headcounts
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Online-only location samples (no background GPS promise; D08).
CREATE TABLE trip_location_samples (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  trip_id               uuid NOT NULL,
  captured_at           timestamptz NOT NULL DEFAULT now(),
  latitude              numeric(9, 6) NOT NULL,
  longitude             numeric(9, 6) NOT NULL,
  accuracy_metres       numeric(10, 2),
  source                text NOT NULL DEFAULT 'online_manual'
                          CHECK (source IN ('online_manual', 'online_foreground')),
  -- Explicit: samples are point-in-time; never imply live background tracking.
  is_live_stream        boolean NOT NULL DEFAULT false
                          CHECK (is_live_stream = false),
  recorded_by_user_id   uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, trip_id) REFERENCES trips (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER trip_location_samples_append_only
  BEFORE UPDATE OR DELETE ON trip_location_samples
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE INDEX trip_location_samples_trip_idx
  ON trip_location_samples(tenant_id, trip_id, captured_at DESC);
