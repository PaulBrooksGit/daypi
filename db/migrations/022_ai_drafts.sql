-- DayMake: constrained AI drafts with provenance; consequential apply disabled (D07).

CREATE TABLE ai_drafts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  draft_type            text NOT NULL
                          CHECK (draft_type IN (
                            'activity_plan',
                            'label',
                            'template',
                            'reward_sheet',
                            'website_page'
                          )),
  title                 text NOT NULL,
  body_markdown         text NOT NULL DEFAULT '',
  status                text NOT NULL DEFAULT 'draft'
                          CHECK (status IN (
                            'draft',
                            'ready_for_review',
                            'approved_unpublished',
                            'rejected',
                            'archived'
                          )),
  provider              text NOT NULL DEFAULT 'synthetic',
  model_version         text NOT NULL DEFAULT 'daypi-synthetic-v1',
  prompt_version        text NOT NULL DEFAULT 'daymake-v1',
  provenance            jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_refs           jsonb NOT NULL DEFAULT '[]'::jsonb,
  edited_body_markdown  text,
  rejection_reason      text,
  created_by_user_id    uuid REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by_user_id   uuid REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TRIGGER ai_drafts_set_updated_at
  BEFORE UPDATE ON ai_drafts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX ai_drafts_tenant_status_idx
  ON ai_drafts(tenant_id, status, created_at DESC);

-- Proposal log: orchestrator returns typed proposals; consequential execute stays gated.
CREATE TABLE ai_proposals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  draft_id              uuid,
  action_type           text NOT NULL
                          CHECK (action_type IN (
                            'create_unpublished_draft',
                            'update_draft_content',
                            'publish_content',
                            'financial_adjustment',
                            'booking_change',
                            'health_record_change',
                            'broadcast_message'
                          )),
  is_consequential      boolean NOT NULL DEFAULT false,
  status                text NOT NULL DEFAULT 'proposed'
                          CHECK (status IN (
                            'proposed',
                            'approved_draft_only',
                            'rejected',
                            'execution_blocked'
                          )),
  input_summary         jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposed_payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id    uuid REFERENCES users(id) ON DELETE RESTRICT,
  decided_by_user_id    uuid REFERENCES users(id) ON DELETE RESTRICT,
  decided_at            timestamptz,
  decision_note         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, draft_id) REFERENCES ai_drafts (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER ai_proposals_set_updated_at
  BEFORE UPDATE ON ai_proposals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX ai_proposals_tenant_status_idx
  ON ai_proposals(tenant_id, status, created_at DESC);
