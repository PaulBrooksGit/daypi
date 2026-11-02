-- Fail closed with an error when app.tenant_id is missing (not merely empty result sets).

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
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = require_tenant_id())
         WITH CHECK (tenant_id = require_tenant_id())',
      t
    );
  END LOOP;
  -- Keep claim path viable: owner SECURITY DEFINER must not be FORCEd.
  ALTER TABLE outbox_events NO FORCE ROW LEVEL SECURITY;
END $$;

DROP POLICY IF EXISTS audit_tenant_isolation ON audit_events;
CREATE POLICY audit_tenant_isolation ON audit_events
  FOR ALL
  USING (tenant_id IS NOT NULL AND tenant_id = require_tenant_id())
  WITH CHECK (tenant_id IS NOT NULL AND tenant_id = require_tenant_id());
