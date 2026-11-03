-- Provider webhook handlers resolve payments/messages before tenant context exists.
-- Same pattern as outbox (011): ENABLE RLS without FORCE so table-owner
-- SECURITY DEFINER helpers bypass RLS; daypi_app remains constrained by policies.
-- Handlers then set_config tenant context and continue under normal RLS.

ALTER TABLE payment_attempts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE messages NO FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION find_payment_by_provider_intent(
  p_provider text,
  p_intent_id text
) RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT pa.id, pa.tenant_id
  FROM payment_attempts pa
  WHERE pa.provider = p_provider
    AND pa.provider_payment_intent_id = p_intent_id
  LIMIT 1;
END;
$$;

CREATE OR REPLACE FUNCTION find_message_by_provider_sid(
  p_provider text,
  p_sid text
) RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.tenant_id
  FROM messages m
  WHERE m.provider = p_provider
    AND m.provider_message_sid = p_sid
  LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION find_payment_by_provider_intent(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION find_message_by_provider_sid(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION find_payment_by_provider_intent(text, text) TO daypi_app;
GRANT EXECUTE ON FUNCTION find_message_by_provider_sid(text, text) TO daypi_app;
