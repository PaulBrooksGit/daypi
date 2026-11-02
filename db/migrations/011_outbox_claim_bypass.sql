-- Outbox claim must run without a prior tenant context (DayPush worker).
-- FORCE RLS subjects even the table owner to policies, so SECURITY DEFINER
-- claim/complete helpers owned by daypi_migrator still hit require_tenant_id().
-- ENABLE RLS without FORCE: daypi_app remains constrained; table-owner
-- SECURITY DEFINER functions bypass RLS for claim/complete only.
-- Handlers still establish per-event tenant context via withTenant().

ALTER TABLE outbox_events NO FORCE ROW LEVEL SECURITY;

-- Ensure policies still fail closed for the application role.
DROP POLICY IF EXISTS tenant_isolation ON outbox_events;
CREATE POLICY tenant_isolation ON outbox_events
  USING (tenant_id = require_tenant_id())
  WITH CHECK (tenant_id = require_tenant_id());

-- Reaffirm worker helpers are SECURITY DEFINER (owner = migrator / table owner).
CREATE OR REPLACE FUNCTION claim_outbox_batch(p_limit integer)
RETURNS SETOF outbox_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH cte AS (
    SELECT id FROM outbox_events
    WHERE status = 'pending' AND available_at <= now()
    ORDER BY available_at
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(p_limit, 1)
  )
  UPDATE outbox_events o
  SET status = 'processing', attempt_count = o.attempt_count + 1
  FROM cte
  WHERE o.id = cte.id
  RETURNING o.*;
END;
$$;

CREATE OR REPLACE FUNCTION complete_outbox_event(
  p_id uuid,
  p_ok boolean,
  p_error text,
  p_max_attempts integer
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attempts integer;
  v_delay integer;
BEGIN
  IF p_ok THEN
    UPDATE outbox_events
    SET status = 'done', processed_at = now(), last_error = NULL
    WHERE id = p_id;
  ELSE
    SELECT attempt_count INTO v_attempts FROM outbox_events WHERE id = p_id;
    v_delay := LEAST(2 ^ LEAST(COALESCE(v_attempts, 1), 8), 300);
    UPDATE outbox_events
    SET status = CASE WHEN COALESCE(v_attempts, 1) >= p_max_attempts THEN 'dead' ELSE 'pending' END,
        available_at = now() + (v_delay || ' seconds')::interval,
        last_error = left(p_error, 500)
    WHERE id = p_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION claim_outbox_batch(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_outbox_event(uuid, boolean, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_outbox_batch(integer) TO daypi_app;
GRANT EXECUTE ON FUNCTION complete_outbox_event(uuid, boolean, text, integer) TO daypi_app;
