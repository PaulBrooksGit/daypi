-- Audit, outbox, jobs, webhook receipts (ADR-05)

CREATE TABLE audit_events (
  id                bigserial PRIMARY KEY,
  tenant_id         uuid REFERENCES tenants(id) ON DELETE RESTRICT,
  actor_user_id     uuid REFERENCES users(id) ON DELETE RESTRICT,
  actor_client_id   uuid,
  action            text NOT NULL,
  entity_type       text,
  entity_id         uuid,
  reason            text,
  correlation_id    text,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX audit_events_tenant_occurred_idx ON audit_events(tenant_id, occurred_at DESC);
CREATE INDEX audit_events_action_idx ON audit_events(action, occurred_at DESC);

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE outbox_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid REFERENCES tenants(id) ON DELETE RESTRICT,
  aggregate_type   text NOT NULL,
  aggregate_id     uuid,
  event_type       text NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'processing', 'done', 'dead')),
  attempt_count    integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  available_at     timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  last_error       text
);

CREATE INDEX outbox_events_poll_idx
  ON outbox_events (status, available_at)
  WHERE status IN ('pending', 'processing');

CREATE TABLE job_attempts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_event_id   uuid NOT NULL REFERENCES outbox_events(id) ON DELETE RESTRICT,
  attempt_no        integer NOT NULL,
  error_summary     text,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  UNIQUE (outbox_event_id, attempt_no)
);

CREATE TABLE webhook_receipts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text NOT NULL,
  provider_event_id text NOT NULL,
  payload_hash      text NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE delivery_attempts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_event_id   uuid NOT NULL REFERENCES outbox_events(id) ON DELETE RESTRICT,
  destination       text NOT NULL,
  attempt_no        integer NOT NULL,
  response_code     integer,
  error_summary     text,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz
);

CREATE INDEX delivery_attempts_outbox_idx ON delivery_attempts(outbox_event_id);
