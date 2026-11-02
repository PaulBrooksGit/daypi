import { createHash, randomBytes } from 'node:crypto';
import type { DbClient, DbPool } from '../../db/src/pool.js';
import { getPool } from '../../db/src/pool.js';

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface SessionRow {
  id: string;
  user_id: string;
  active_tenant_id: string | null;
  expires_at: Date;
  revoked_at: Date | null;
  email: string;
  user_status: string;
}

export async function createSession(
  db: DbClient,
  input: { userId: string; activeTenantId?: string | null; userAgent?: string; ip?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.query(
    `INSERT INTO sessions (user_id, token_hash, active_tenant_id, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.userId,
      hashToken(token),
      input.activeTenantId ?? null,
      expiresAt,
      input.userAgent ?? null,
      input.ip ?? null,
    ],
  );
  return { token, expiresAt };
}

export async function revokeSession(db: DbClient, token: string): Promise<void> {
  await db.query(
    `UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(token)],
  );
}

export async function findSessionByToken(
  token: string,
  pool: DbPool = getPool(),
): Promise<SessionRow | null> {
  const res = await pool.query<SessionRow>(
    `SELECT s.id, s.user_id, s.active_tenant_id, s.expires_at, s.revoked_at,
            u.email, u.status AS user_status
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [hashToken(token)],
  );
  const row = res.rows[0];
  if (!row) return null;
  if (row.revoked_at || row.expires_at.getTime() < Date.now()) return null;
  if (row.user_status !== 'active') return null;
  return row;
}

export async function setActiveTenant(
  db: DbClient,
  sessionId: string,
  tenantId: string,
): Promise<void> {
  await db.query(`UPDATE sessions SET active_tenant_id = $2, last_seen_at = now() WHERE id = $1`, [
    sessionId,
    tenantId,
  ]);
}
