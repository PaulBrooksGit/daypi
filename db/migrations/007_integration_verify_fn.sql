-- SECURITY DEFINER helper so integration client credentials can be verified
-- without a prior tenant context. Function runs as table owner (migrator).
-- Returns no row on mismatch. Does not bypass tenant isolation for data access.

CREATE OR REPLACE FUNCTION verify_integration_client(p_client_id uuid, p_secret_hash text)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  secret_hash text,
  scopes text[],
  revoked_at timestamptz,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT c.id, c.tenant_id, c.secret_hash, c.scopes, c.revoked_at, c.expires_at
  FROM integration_clients c
  WHERE c.id = p_client_id
    AND c.secret_hash = p_secret_hash;
END;
$$;

REVOKE ALL ON FUNCTION verify_integration_client(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION verify_integration_client(uuid, text) TO daypi_app;

-- Allow sessions updates from app role (already granted); ensure SELECT on tenants for membership bootstrap.
GRANT SELECT ON tenants TO daypi_app;
