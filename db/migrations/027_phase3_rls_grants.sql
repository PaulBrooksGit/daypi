-- Phase 3 RLS + grants for DayMain / DayMake / DayStar / DayGrow / DayStep / DayCare

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'website_sites',
    'website_pages',
    'website_domain_verifications',
    'ai_drafts',
    'ai_proposals',
    'quality_audit_templates',
    'quality_audit_template_versions',
    'quality_audit_runs',
    'quality_audit_actions',
    'quality_testimonials',
    'child_allergy_profiles',
    'child_allergies',
    'child_conditions',
    'child_care_plans',
    'child_observations',
    'child_measurements',
    'trips',
    'trip_participants',
    'trip_permissions',
    'trip_headcounts',
    'trip_location_samples',
    'facility_assets',
    'facility_inspection_schedules',
    'facility_inspections',
    'facility_findings',
    'facility_maintenance_actions'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = require_tenant_id())
         WITH CHECK (tenant_id = require_tenant_id())',
      t
    );
  END LOOP;
END $$;

-- Global catalogue readable by app role (no RLS)
GRANT SELECT ON website_templates TO daypi_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  website_sites,
  website_pages,
  website_domain_verifications,
  ai_drafts,
  ai_proposals,
  quality_audit_templates,
  quality_audit_runs,
  quality_audit_actions,
  quality_testimonials,
  child_allergy_profiles,
  child_allergies,
  child_conditions,
  child_care_plans,
  trips,
  trip_participants,
  trip_permissions,
  facility_assets,
  facility_inspection_schedules,
  facility_findings,
  facility_maintenance_actions
TO daypi_app;

-- Append-only tables
GRANT SELECT, INSERT ON
  quality_audit_template_versions,
  child_observations,
  child_measurements,
  trip_headcounts,
  trip_location_samples,
  facility_inspections
TO daypi_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO daypi_app;
