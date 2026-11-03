-- DayText: messaging with delivery tracking; transactional vs marketing preferences
-- Twilio sandbox until commercial messaging rules approved. No hard-coded per-message price.

CREATE TABLE messages (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  channel                     text NOT NULL CHECK (channel IN ('sms', 'email')),
  purpose                     text NOT NULL CHECK (purpose IN ('transactional', 'marketing')),
  subject                     text,
  body                        text NOT NULL,
  status                      text NOT NULL DEFAULT 'queued'
                                CHECK (status IN (
                                  'queued', 'sending', 'sent', 'delivered', 'failed', 'cancelled'
                                )),
  estimated_segments          integer NOT NULL DEFAULT 1 CHECK (estimated_segments >= 1),
  estimated_cost_minor        integer NOT NULL DEFAULT 0 CHECK (estimated_cost_minor >= 0),
  actual_cost_minor           integer,
  usage_reservation_key       text,
  provider                    text NOT NULL DEFAULT 'twilio_sandbox'
                                CHECK (provider IN ('twilio_sandbox', 'email_sandbox')),
  provider_message_sid        text,
  idempotency_key             text NOT NULL,
  created_by_user_id          uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TRIGGER messages_set_updated_at
  BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX messages_tenant_created_idx ON messages(tenant_id, created_at DESC);

CREATE TABLE message_recipients (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  message_id                  uuid NOT NULL,
  guardian_id                 uuid,
  phone_e164                  text,
  email                       citext,
  delivery_status             text NOT NULL DEFAULT 'queued'
                                CHECK (delivery_status IN (
                                  'queued', 'sent', 'delivered', 'failed', 'undelivered', 'skipped'
                                )),
  skip_reason                 text,
  provider_recipient_sid      text,
  error_code                  text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, guardian_id) REFERENCES guardians (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER message_recipients_set_updated_at
  BEFORE UPDATE ON message_recipients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX message_recipients_message_idx
  ON message_recipients(tenant_id, message_id);

CREATE TABLE message_delivery_events (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  message_id                  uuid NOT NULL,
  recipient_id                uuid,
  provider                    text NOT NULL,
  provider_event_id           text NOT NULL,
  status                      text NOT NULL,
  payload_hash                text NOT NULL,
  occurred_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (provider, provider_event_id),
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, recipient_id) REFERENCES message_recipients (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER message_delivery_events_append_only
  BEFORE UPDATE OR DELETE ON message_delivery_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Configurable SMS cost estimate (pence per segment) — not a production commercial rule (D04).
CREATE TABLE messaging_rate_config (
  tenant_id                   uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  sms_segment_cost_minor      integer NOT NULL DEFAULT 4 CHECK (sms_segment_cost_minor >= 0),
  currency                    char(3) NOT NULL DEFAULT 'GBP',
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
