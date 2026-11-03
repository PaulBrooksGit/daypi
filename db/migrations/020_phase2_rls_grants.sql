-- Phase 2 RLS + grants for DayDocs / DayBank / DayText tables

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'documents',
    'document_versions',
    'consent_requests',
    'signature_evidence',
    'document_acknowledgements',
    'billing_accounts',
    'invoices',
    'invoice_lines',
    'invoice_credits',
    'payment_attempts',
    'payment_allocations',
    'finance_ledger_entries',
    'refunds',
    'messages',
    'message_recipients',
    'message_delivery_events',
    'messaging_rate_config'
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

GRANT SELECT, INSERT, UPDATE, DELETE ON
  documents,
  consent_requests,
  billing_accounts,
  invoices,
  invoice_lines,
  payment_attempts,
  refunds,
  messages,
  message_recipients,
  messaging_rate_config
TO daypi_app;

-- Append-only tables
GRANT SELECT, INSERT ON
  document_versions,
  signature_evidence,
  document_acknowledgements,
  invoice_credits,
  payment_allocations,
  finance_ledger_entries,
  message_delivery_events
TO daypi_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO daypi_app;
