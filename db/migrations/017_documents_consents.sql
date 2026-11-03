-- DayDocs: versioned documents, consents, acknowledgements, signature evidence
-- Signed versions are immutable; edits create new versions (Brief §8, §16 Phase 2).

CREATE TABLE documents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  title                 text NOT NULL,
  category              text NOT NULL DEFAULT 'policy',
  visibility            text NOT NULL DEFAULT 'staff'
                          CHECK (visibility IN ('staff', 'guardians', 'private')),
  status                text NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'published', 'archived')),
  current_version_id    uuid,
  created_by_user_id    uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TRIGGER documents_set_updated_at
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE document_versions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  document_id           uuid NOT NULL,
  version_number        integer NOT NULL CHECK (version_number >= 1),
  stored_object_id      uuid,
  title_snapshot        text NOT NULL,
  body_text             text,
  content_sha256        text NOT NULL,
  created_by_user_id    uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, document_id, version_number),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, stored_object_id) REFERENCES stored_objects (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER document_versions_append_only
  BEFORE UPDATE OR DELETE ON document_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE documents
  ADD CONSTRAINT documents_current_version_fk
  FOREIGN KEY (tenant_id, current_version_id)
  REFERENCES document_versions (tenant_id, id) ON DELETE RESTRICT;

CREATE INDEX document_versions_document_idx
  ON document_versions(tenant_id, document_id, version_number DESC);

CREATE TABLE consent_requests (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  document_id             uuid NOT NULL,
  document_version_id     uuid NOT NULL,
  child_id                uuid,
  guardian_id             uuid,
  title                   text NOT NULL,
  status                  text NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'signed', 'revoked', 'expired')),
  requested_by_user_id    uuid REFERENCES users(id) ON DELETE RESTRICT,
  expires_at              timestamptz,
  signed_at               timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES document_versions (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, child_id) REFERENCES children (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, guardian_id) REFERENCES guardians (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER consent_requests_set_updated_at
  BEFORE UPDATE ON consent_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX consent_requests_guardian_idx
  ON consent_requests(tenant_id, guardian_id, status);

CREATE TABLE signature_evidence (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  consent_request_id      uuid NOT NULL,
  document_version_id     uuid NOT NULL,
  signed_by_user_id       uuid REFERENCES users(id) ON DELETE RESTRICT,
  guardian_id             uuid,
  signed_at               timestamptz NOT NULL DEFAULT now(),
  signature_method        text NOT NULL DEFAULT 'typed_name'
                            CHECK (signature_method IN ('typed_name', 'drawn', 'checkbox_ack')),
  signer_display_name     text NOT NULL,
  content_sha256_at_sign  text NOT NULL,
  evidence_payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, consent_request_id),
  FOREIGN KEY (tenant_id, consent_request_id) REFERENCES consent_requests (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES document_versions (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, guardian_id) REFERENCES guardians (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER signature_evidence_append_only
  BEFORE UPDATE OR DELETE ON signature_evidence
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE document_acknowledgements (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  document_version_id     uuid NOT NULL,
  user_id                 uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  acknowledged_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, document_version_id, user_id),
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES document_versions (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER document_acknowledgements_append_only
  BEFORE UPDATE OR DELETE ON document_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
