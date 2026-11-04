-- DayGrow: health/development records. Allergy status never defaults to "None".

CREATE TABLE child_allergy_profiles (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  child_id              uuid NOT NULL,
  -- unknown | unconfirmed | confirmed_present | confirmed_none — never initialise as None
  overall_status        text NOT NULL DEFAULT 'unknown'
                          CHECK (overall_status IN (
                            'unknown',
                            'unconfirmed',
                            'confirmed_present',
                            'confirmed_none'
                          )),
  notes                 text NOT NULL DEFAULT '',
  reviewed_at           timestamptz,
  reviewed_by_user_id   uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, child_id),
  FOREIGN KEY (tenant_id, child_id) REFERENCES children (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER child_allergy_profiles_set_updated_at
  BEFORE UPDATE ON child_allergy_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE child_allergies (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  child_id              uuid NOT NULL,
  allergen              text NOT NULL,
  confirmation_status   text NOT NULL DEFAULT 'unconfirmed'
                          CHECK (confirmation_status IN (
                            'unknown',
                            'unconfirmed',
                            'confirmed_present'
                          )),
  severity              text
                          CHECK (severity IS NULL OR severity IN ('mild', 'moderate', 'severe')),
  reaction_notes        text NOT NULL DEFAULT '',
  recorded_by_user_id   uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, child_id) REFERENCES children (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER child_allergies_set_updated_at
  BEFORE UPDATE ON child_allergies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX child_allergies_child_idx
  ON child_allergies(tenant_id, child_id);

CREATE TABLE child_conditions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  child_id              uuid NOT NULL,
  name                  text NOT NULL,
  confirmation_status   text NOT NULL DEFAULT 'unconfirmed'
                          CHECK (confirmation_status IN (
                            'unknown',
                            'unconfirmed',
                            'confirmed_present',
                            'resolved'
                          )),
  care_notes            text NOT NULL DEFAULT '',
  recorded_by_user_id   uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, child_id) REFERENCES children (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER child_conditions_set_updated_at
  BEFORE UPDATE ON child_conditions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE child_care_plans (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  child_id              uuid NOT NULL,
  title                 text NOT NULL,
  body_markdown         text NOT NULL DEFAULT '',
  status                text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('draft', 'active', 'archived')),
  effective_from        date,
  effective_to          date,
  created_by_user_id    uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, child_id) REFERENCES children (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER child_care_plans_set_updated_at
  BEFORE UPDATE ON child_care_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE child_observations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  child_id              uuid NOT NULL,
  observed_at           timestamptz NOT NULL DEFAULT now(),
  category              text NOT NULL DEFAULT 'general',
  body_markdown         text NOT NULL,
  created_by_user_id    uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, child_id) REFERENCES children (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER child_observations_append_only
  BEFORE UPDATE OR DELETE ON child_observations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE INDEX child_observations_child_idx
  ON child_observations(tenant_id, child_id, observed_at DESC);

-- Longitudinal measurements: units explicit; validated reference charts Pending (D01).
CREATE TABLE child_measurements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  child_id              uuid NOT NULL,
  measured_at           timestamptz NOT NULL DEFAULT now(),
  measurement_type      text NOT NULL
                          CHECK (measurement_type IN ('height_cm', 'weight_kg', 'other')),
  value_numeric         numeric(12, 4) NOT NULL,
  unit                  text NOT NULL,
  notes                 text NOT NULL DEFAULT '',
  reference_chart_id    text,
  created_by_user_id    uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, child_id) REFERENCES children (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER child_measurements_append_only
  BEFORE UPDATE OR DELETE ON child_measurements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
