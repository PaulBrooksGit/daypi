import pg from 'pg';

const { Pool } = pg;

export type DbPool = pg.Pool;
/** Pool client or standalone Client — anything with query/release-compatible surface for tx work. */
export type DbClient = Pick<pg.PoolClient, 'query'>;

let pool: DbPool | null = null;

export function createPool(databaseUrl: string, options?: pg.PoolConfig): DbPool {
  return new Pool({
    connectionString: databaseUrl,
    max: options?.max ?? 10,
    idleTimeoutMillis: options?.idleTimeoutMillis ?? 10_000,
    connectionTimeoutMillis: options?.connectionTimeoutMillis ?? 5_000,
    ...options,
  });
}

export function getPool(databaseUrl?: string): DbPool {
  if (pool) return pool;
  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  pool = createPool(url);
  return pool;
}

export function setPool(next: DbPool | null): void {
  pool = next;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
