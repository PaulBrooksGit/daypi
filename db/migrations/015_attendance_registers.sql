-- Phase 1 DayByte minimum — attendance events and corrections (register accuracy)

CREATE TABLE attendance_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  child_id            uuid NOT NULL,
  dated_session_id    uuid NOT NULL,
  booking_id          uuid,
  event_type          text NOT NULL
                        CHECK (event_type IN ('check_in', 'check_out')),
  occurred_at         timestamptz NOT NULL,
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  recorded_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  collector_guardian_id uuid,
  notes               text,
  superseded_by_correction_id uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, child_id) REFERENCES children (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, dated_session_id)
    REFERENCES dated_sessions (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, booking_id) REFERENCES bookings (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, collector_guardian_id)
    REFERENCES guardians (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX attendance_events_session_child_idx
  ON attendance_events(tenant_id, dated_session_id, child_id, occurred_at);

CREATE TABLE attendance_corrections (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  attendance_event_id   uuid NOT NULL,
  child_id              uuid NOT NULL,
  dated_session_id      uuid NOT NULL,
  correction_type       text NOT NULL
                          CHECK (correction_type IN (
                            'amend_time', 'amend_type', 'void_event', 'add_missing'
                          )),
  previous_event_type   text,
  previous_occurred_at  timestamptz,
  new_event_type        text
                          CHECK (new_event_type IS NULL OR new_event_type IN ('check_in', 'check_out')),
  new_occurred_at       timestamptz,
  reason                text NOT NULL,
  applied_by_user_id    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  applied_at            timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, attendance_event_id)
    REFERENCES attendance_events (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, child_id) REFERENCES children (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, dated_session_id)
    REFERENCES dated_sessions (tenant_id, id) ON DELETE RESTRICT
);

ALTER TABLE attendance_events
  ADD CONSTRAINT attendance_events_correction_fk
  FOREIGN KEY (tenant_id, superseded_by_correction_id)
  REFERENCES attendance_corrections (tenant_id, id) ON DELETE RESTRICT;

-- Append-only corrections: forbid UPDATE/DELETE
CREATE TRIGGER attendance_corrections_append_only
  BEFORE UPDATE OR DELETE ON attendance_corrections
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
