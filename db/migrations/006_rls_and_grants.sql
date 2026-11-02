-- Row-Level Security for tenant-owned tables.
-- daypi_app is not owner and has no BYPASSRLS; FORCE RLS applies even to table owner
-- for defence in depth if the wrong role is ever used.

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'memberships',
    'permission_grants',
    'sites',
    'verified_domains',
    'invitations',
    'integration_clients',
    'entitlements',
    'children',
    'guardians',
    'child_guardian_relationships',
    'relationship_restrictions',
    'platform_subscriptions',
    'usage_accounts',
    'usage_ledger_entries',
    'stored_objects',
    'outbox_events'
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

-- Audit events: readable/writable only with tenant context when tenant_id is set;
-- platform-global rows (tenant_id IS NULL) are not selectable by app role via RLS.
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_tenant_isolation ON audit_events;
CREATE POLICY audit_tenant_isolation ON audit_events
  FOR ALL
  USING (tenant_id IS NOT NULL AND tenant_id = require_tenant_id())
  WITH CHECK (tenant_id IS NOT NULL AND tenant_id = require_tenant_id());

-- Grants for application role (non-owner)
GRANT USAGE ON SCHEMA public TO daypi_app;

GRANT SELECT, INSERT, UPDATE ON
  users, tenants, sessions
TO daypi_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  memberships,
  permission_grants,
  sites,
  verified_domains,
  invitations,
  integration_clients,
  entitlements,
  children,
  guardians,
  child_guardian_relationships,
  relationship_restrictions,
  platform_subscriptions,
  usage_accounts,
  stored_objects,
  outbox_events,
  job_attempts,
  webhook_receipts,
  delivery_attempts
TO daypi_app;

-- Append-only: no UPDATE/DELETE
GRANT SELECT, INSERT ON usage_ledger_entries, audit_events TO daypi_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO daypi_app;

-- Explicitly revoke dangerous privileges
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO daypi_migrator;
GRANT USAGE ON SCHEMA public TO daypi_app;
