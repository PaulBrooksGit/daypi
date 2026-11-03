-- Phase 1 DayCore — sessions, bookings, reservations, capacity
-- Capacity rules are configurable/synthetic only (D01 compliance automation disabled).

CREATE TABLE opening_calendars (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  site_id         uuid NOT NULL,
  calendar_date   date NOT NULL,
  is_open         boolean NOT NULL DEFAULT true,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, site_id, calendar_date),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE rooms (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  site_id         uuid NOT NULL,
  name            text NOT NULL,
  capacity        integer CHECK (capacity IS NULL OR capacity > 0),
  age_min_months  integer,
  age_max_months  integer,
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER rooms_set_updated_at
  BEFORE UPDATE ON rooms
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE session_definitions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  site_id           uuid NOT NULL,
  room_id           uuid,
  name              text NOT NULL,
  local_start_time  time NOT NULL,
  local_end_time    time NOT NULL,
  default_capacity  integer NOT NULL CHECK (default_capacity > 0),
  timezone          text NOT NULL DEFAULT 'Europe/London',
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (local_end_time > local_start_time),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, room_id) REFERENCES rooms (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER session_definitions_set_updated_at
  BEFORE UPDATE ON session_definitions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE dated_sessions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  site_id                 uuid NOT NULL,
  session_definition_id   uuid NOT NULL,
  room_id                 uuid,
  session_date            date NOT NULL,
  starts_at               timestamptz NOT NULL,
  ends_at                 timestamptz NOT NULL,
  capacity                integer NOT NULL CHECK (capacity > 0),
  status                  text NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open', 'closed', 'cancelled')),
  version                 integer NOT NULL DEFAULT 1,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, session_definition_id, session_date),
  CHECK (ends_at > starts_at),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, session_definition_id)
    REFERENCES session_definitions (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, room_id) REFERENCES rooms (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER dated_sessions_set_updated_at
  BEFORE UPDATE ON dated_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX dated_sessions_tenant_date_idx
  ON dated_sessions(tenant_id, site_id, session_date);

CREATE TABLE bookings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  child_id          uuid NOT NULL,
  dated_session_id  uuid NOT NULL,
  status            text NOT NULL DEFAULT 'confirmed'
                      CHECK (status IN ('requested', 'confirmed', 'cancelled', 'rejected', 'waitlisted')),
  reservation_id    uuid,
  idempotency_key   text,
  requested_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  confirmed_at      timestamptz,
  cancelled_at      timestamptz,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, child_id) REFERENCES children (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, dated_session_id)
    REFERENCES dated_sessions (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER bookings_set_updated_at
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- At most one non-cancelled booking per child per dated session
CREATE UNIQUE INDEX bookings_active_child_session_uidx
  ON bookings (tenant_id, child_id, dated_session_id)
  WHERE status IN ('requested', 'confirmed', 'waitlisted');

CREATE UNIQUE INDEX bookings_idempotency_uidx
  ON bookings (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX bookings_session_status_idx
  ON bookings(tenant_id, dated_session_id, status);

CREATE TABLE reservations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  child_id          uuid NOT NULL,
  dated_session_id  uuid NOT NULL,
  status            text NOT NULL DEFAULT 'holding'
                      CHECK (status IN ('holding', 'converted', 'released', 'expired')),
  expires_at        timestamptz NOT NULL,
  held_by_user_id   uuid REFERENCES users(id) ON DELETE RESTRICT,
  released_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, child_id) REFERENCES children (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, dated_session_id)
    REFERENCES dated_sessions (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER reservations_set_updated_at
  BEFORE UPDATE ON reservations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX reservations_active_session_idx
  ON reservations(tenant_id, dated_session_id, status, expires_at)
  WHERE status = 'holding';

ALTER TABLE bookings
  ADD CONSTRAINT bookings_reservation_fk
  FOREIGN KEY (tenant_id, reservation_id)
  REFERENCES reservations (tenant_id, id) ON DELETE RESTRICT;
