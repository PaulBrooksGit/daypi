-- DayStar: versioned audit templates, actions, internal scoring, testimonials.

CREATE TABLE quality_audit_templates (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name                  text NOT NULL,
  description           text NOT NULL DEFAULT '',
  current_version_id    uuid,
  status                text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'archived')),
  created_by_user_id    uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TRIGGER quality_audit_templates_set_updated_at
  BEFORE UPDATE ON quality_audit_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE quality_audit_template_versions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  template_id           uuid NOT NULL,
  version_number        integer NOT NULL CHECK (version_number >= 1),
  criteria              jsonb NOT NULL DEFAULT '[]'::jsonb,
  scoring_notes         text NOT NULL DEFAULT '',
  created_by_user_id    uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, template_id, version_number),
  FOREIGN KEY (tenant_id, template_id)
    REFERENCES quality_audit_templates (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER quality_audit_template_versions_append_only
  BEFORE UPDATE OR DELETE ON quality_audit_template_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE quality_audit_templates
  ADD CONSTRAINT quality_audit_templates_current_version_fk
  FOREIGN KEY (tenant_id, current_version_id)
  REFERENCES quality_audit_template_versions (tenant_id, id) ON DELETE RESTRICT;

CREATE TABLE quality_audit_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  template_id           uuid NOT NULL,
  template_version_id   uuid NOT NULL,
  title                 text NOT NULL,
  status                text NOT NULL DEFAULT 'in_progress'
                          CHECK (status IN ('in_progress', 'completed', 'cancelled')),
  internal_score        numeric(6, 2),
  score_label           text,
  notes                 text NOT NULL DEFAULT '',
  -- Internal scores are not official inspection compliance (Brief §12).
  compliance_claim      text NOT NULL DEFAULT 'internal_only'
                          CHECK (compliance_claim = 'internal_only'),
  conducted_by_user_id  uuid REFERENCES users(id) ON DELETE RESTRICT,
  completed_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, template_id)
    REFERENCES quality_audit_templates (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, template_version_id)
    REFERENCES quality_audit_template_versions (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER quality_audit_runs_set_updated_at
  BEFORE UPDATE ON quality_audit_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE quality_audit_actions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  audit_run_id          uuid NOT NULL,
  title                 text NOT NULL,
  detail                text NOT NULL DEFAULT '',
  status                text NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
  due_on                date,
  assigned_user_id      uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_by_user_id    uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, audit_run_id)
    REFERENCES quality_audit_runs (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER quality_audit_actions_set_updated_at
  BEFORE UPDATE ON quality_audit_actions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE quality_testimonials (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  author_display_name   text NOT NULL,
  body                  text NOT NULL,
  guardian_id           uuid,
  visibility            text NOT NULL DEFAULT 'private'
                          CHECK (visibility IN ('private', 'staff', 'public')),
  moderation_status     text NOT NULL DEFAULT 'pending'
                          CHECK (moderation_status IN (
                            'pending',
                            'approved',
                            'rejected',
                            'withdrawn'
                          )),
  submitted_by_user_id  uuid REFERENCES users(id) ON DELETE RESTRICT,
  moderated_by_user_id  uuid REFERENCES users(id) ON DELETE RESTRICT,
  moderated_at          timestamptz,
  moderation_note       text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, guardian_id) REFERENCES guardians (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER quality_testimonials_set_updated_at
  BEFORE UPDATE ON quality_testimonials
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX quality_testimonials_visibility_idx
  ON quality_testimonials(tenant_id, moderation_status, visibility);
