-- DayCare: premises/equipment assets, inspection schedules, findings, actions.

CREATE TABLE facility_assets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  site_id               uuid,
  name                  text NOT NULL,
  category              text NOT NULL DEFAULT 'equipment'
                          CHECK (category IN (
                            'premises',
                            'equipment',
                            'vehicle',
                            'outdoor',
                            'other'
                          )),
  location_label        text NOT NULL DEFAULT '',
  status                text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'out_of_service', 'retired')),
  serial_number         text,
  notes                 text NOT NULL DEFAULT '',
  created_by_user_id    uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER facility_assets_set_updated_at
  BEFORE UPDATE ON facility_assets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX facility_assets_tenant_status_idx
  ON facility_assets(tenant_id, status, category);

CREATE TABLE facility_inspection_schedules (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  asset_id              uuid NOT NULL,
  title                 text NOT NULL,
  cadence_days          integer NOT NULL CHECK (cadence_days >= 1),
  next_due_on           date NOT NULL,
  status                text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'paused', 'cancelled')),
  created_by_user_id    uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES facility_assets (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER facility_inspection_schedules_set_updated_at
  BEFORE UPDATE ON facility_inspection_schedules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE facility_inspections (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  asset_id              uuid NOT NULL,
  schedule_id           uuid,
  inspected_at          timestamptz NOT NULL DEFAULT now(),
  outcome               text NOT NULL
                          CHECK (outcome IN ('pass', 'pass_with_notes', 'fail')),
  notes                 text NOT NULL DEFAULT '',
  evidence_object_id    uuid,
  inspected_by_user_id  uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES facility_assets (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, schedule_id)
    REFERENCES facility_inspection_schedules (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, evidence_object_id)
    REFERENCES stored_objects (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER facility_inspections_append_only
  BEFORE UPDATE OR DELETE ON facility_inspections
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE facility_findings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  inspection_id         uuid NOT NULL,
  asset_id              uuid NOT NULL,
  severity              text NOT NULL DEFAULT 'medium'
                          CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  description           text NOT NULL,
  status                text NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'in_progress', 'resolved', 'accepted_risk')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, inspection_id)
    REFERENCES facility_inspections (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, asset_id) REFERENCES facility_assets (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER facility_findings_set_updated_at
  BEFORE UPDATE ON facility_findings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE facility_maintenance_actions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  finding_id            uuid,
  asset_id              uuid NOT NULL,
  title                 text NOT NULL,
  detail                text NOT NULL DEFAULT '',
  status                text NOT NULL DEFAULT 'planned'
                          CHECK (status IN ('planned', 'in_progress', 'done', 'cancelled')),
  due_on                date,
  completed_at          timestamptz,
  created_by_user_id    uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, finding_id)
    REFERENCES facility_findings (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, asset_id) REFERENCES facility_assets (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER facility_maintenance_actions_set_updated_at
  BEFORE UPDATE ON facility_maintenance_actions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
