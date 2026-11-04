-- /auth/me calls list_memberships_for_user before any tenant is selected.
-- memberships has FORCE ROW LEVEL SECURITY, so the SECURITY DEFINER body still
-- evaluated require_tenant_id() and failed closed for daypi_app.
-- Match outbox claim pattern: ENABLE RLS without FORCE so table-owner
-- SECURITY DEFINER helpers bypass RLS; daypi_app remains policy-bound.

ALTER TABLE memberships NO FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON memberships;
CREATE POLICY tenant_isolation ON memberships
  USING (tenant_id = require_tenant_id())
  WITH CHECK (tenant_id = require_tenant_id());

CREATE OR REPLACE FUNCTION list_memberships_for_user(p_user_id uuid)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  role_template text,
  status text,
  display_name text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.id, m.tenant_id, m.role_template, m.status, t.display_name
  FROM memberships m
  JOIN tenants t ON t.id = m.tenant_id
  WHERE m.user_id = p_user_id AND m.status = 'active'
  ORDER BY t.display_name;
$$;

REVOKE ALL ON FUNCTION list_memberships_for_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_memberships_for_user(uuid) TO daypi_app;
