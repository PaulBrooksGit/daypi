-- List active memberships for a user without requiring tenant context.
-- Used by /auth/me. Does not expose other tenants' operational data.

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
