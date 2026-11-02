-- Platform worker helpers: claim/complete outbox without a prior tenant context.
-- Handlers still must use withTenant for tenant data access.

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

CREATE OR REPLACE FUNCTION complete_outbox_event(p_id uuid, p_ok boolean, p_error text, p_max_attempts integer)
RETURNS void
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

CREATE OR REPLACE FUNCTION record_job_attempt_row(
  p_outbox_event_id uuid,
  p_attempt_no integer,
  p_error_summary text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO job_attempts (outbox_event_id, attempt_no, error_summary, finished_at)
  VALUES (p_outbox_event_id, p_attempt_no, p_error_summary, now())
  ON CONFLICT (outbox_event_id, attempt_no) DO UPDATE
    SET error_summary = EXCLUDED.error_summary,
        finished_at = now();
END;
$$;

REVOKE ALL ON FUNCTION claim_outbox_batch(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_outbox_event(uuid, boolean, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_job_attempt_row(uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_outbox_batch(integer) TO daypi_app;
GRANT EXECUTE ON FUNCTION complete_outbox_event(uuid, boolean, text, integer) TO daypi_app;
GRANT EXECUTE ON FUNCTION record_job_attempt_row(uuid, integer, text) TO daypi_app;
