-- DayPI Phase 0 — extensions and shared helpers
-- Owner: daypi_migrator. Application connects as daypi_app (no BYPASSRLS).

-- Extensions are created by environment bootstrap / test reset when the migrator
-- lacks CREATE EXTENSION. IF NOT EXISTS keeps migrate idempotent when present.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION require_tenant_id() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE
  tid uuid;
BEGIN
  tid := current_tenant_id();
  IF tid IS NULL THEN
    RAISE EXCEPTION 'tenant context required' USING ERRCODE = '42501';
  END IF;
  RETURN tid;
END;
$$;

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
