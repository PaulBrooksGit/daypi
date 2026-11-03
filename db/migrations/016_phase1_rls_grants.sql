-- Phase 1 RLS + grants for DayCore / DayByte / DayTeam tables

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'enquiries',
    'enrolments',
    'opening_calendars',
    'rooms',
    'session_definitions',
    'dated_sessions',
    'bookings',
    'reservations',
    'staff_profiles',
    'staff_qualifications',
    'staff_assignments',
    'rota_shifts',
    'time_events',
    'leave_requests',
    'attendance_events',
    'attendance_corrections'
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
  enquiries,
  enrolments,
  opening_calendars,
  rooms,
  session_definitions,
  dated_sessions,
  bookings,
  reservations,
  staff_profiles,
  staff_qualifications,
  staff_assignments,
  rota_shifts,
  time_events,
  leave_requests,
  attendance_events
TO daypi_app;

-- Corrections are append-only
GRANT SELECT, INSERT ON attendance_corrections TO daypi_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO daypi_app;
