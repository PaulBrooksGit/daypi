import type { DbClient, DbPool } from './pool.js';
import { getPool } from './pool.js';

/**
 * Run work inside a transaction with pooling-safe tenant context.
 * Uses set_config(..., true) so the setting is local to the transaction and
 * cannot leak to the next borrower of a pooled connection.
 * Missing / empty tenantId fails closed before any tenant query runs.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (db: DbClient) => Promise<T>,
  pool: DbPool = getPool(),
): Promise<T> {
  if (!tenantId || !/^[0-9a-f-]{36}$/i.test(tenantId)) {
    throw new TenantContextError('tenant context required');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Assert that no tenant context is visible on a bare connection (pool safety). */
export async function readTenantSetting(client: DbClient): Promise<string | null> {
  const res = await client.query<{ v: string | null }>(
    "SELECT NULLIF(current_setting('app.tenant_id', true), '') AS v",
  );
  return res.rows[0]?.v ?? null;
}

export class TenantContextError extends Error {
  readonly code = 'TENANT_CONTEXT_REQUIRED';
  constructor(message = 'tenant context required') {
    super(message);
    this.name = 'TenantContextError';
  }
}
