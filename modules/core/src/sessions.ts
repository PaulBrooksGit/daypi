import type { DbPool } from '../../../platform/db/src/pool.js';
import { withTenant } from '../../../platform/db/src/index.js';
import { writeAudit } from '../../../platform/audit/src/index.js';
import { notFound, validationError } from '../../../platform/http/src/errors.js';

export async function createSessionDefinition(
  input: {
    tenantId: string;
    actorUserId: string;
    siteId: string;
    name: string;
    localStartTime: string;
    localEndTime: string;
    defaultCapacity: number;
    timezone?: string;
    roomId?: string;
    correlationId?: string;
  },
  pool: DbPool,
) {
  if (input.defaultCapacity < 1) {
    throw validationError('default_capacity must be >= 1');
  }
  return withTenant(input.tenantId, async (db) => {
    const r = await db.query(
      `INSERT INTO session_definitions (
         tenant_id, site_id, room_id, name, local_start_time, local_end_time,
         default_capacity, timezone
       ) VALUES ($1,$2,$3,$4,$5::time,$6::time,$7,$8)
       RETURNING *`,
      [
        input.tenantId,
        input.siteId,
        input.roomId ?? null,
        input.name,
        input.localStartTime,
        input.localEndTime,
        input.defaultCapacity,
        input.timezone ?? 'Europe/London',
      ],
    );
    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'sessions.define',
      entityType: 'session_definition',
      entityId: r.rows[0]!.id as string,
      correlationId: input.correlationId,
    });
    return r.rows[0];
  }, pool);
}

export async function listSessionDefinitions(
  input: { tenantId: string; siteId?: string; limit?: number },
  pool: DbPool,
) {
  const limit = Math.min(input.limit ?? 50, 100);
  return withTenant(input.tenantId, async (db) => {
    if (input.siteId) {
      const r = await db.query(
        `SELECT * FROM session_definitions
         WHERE site_id = $1 AND active = true
         ORDER BY local_start_time LIMIT $2`,
        [input.siteId, limit],
      );
      return r.rows;
    }
    const r = await db.query(
      `SELECT * FROM session_definitions WHERE active = true
       ORDER BY local_start_time LIMIT $1`,
      [limit],
    );
    return r.rows;
  }, pool);
}

/**
 * Materialise a dated session occurrence from a definition.
 * Local wall times are interpreted in the definition timezone via AT TIME ZONE.
 */
export async function materialiseDatedSession(
  input: {
    tenantId: string;
    actorUserId: string;
    sessionDefinitionId: string;
    sessionDate: string;
    capacity?: number;
    correlationId?: string;
  },
  pool: DbPool,
) {
  return withTenant(input.tenantId, async (db) => {
    const def = await db.query<{
      id: string;
      site_id: string;
      room_id: string | null;
      local_start_time: string;
      local_end_time: string;
      default_capacity: number;
      timezone: string;
    }>(`SELECT * FROM session_definitions WHERE id = $1 AND active = true`, [
      input.sessionDefinitionId,
    ]);
    const sessionDef = def.rows[0];
    if (!sessionDef) throw notFound('Session definition not found');

    const capacity = input.capacity ?? sessionDef.default_capacity;
    const r = await db.query(
      `INSERT INTO dated_sessions (
         tenant_id, site_id, session_definition_id, room_id, session_date,
         starts_at, ends_at, capacity
       ) VALUES (
         $1, $2, $3, $4, $5::date,
         (($5::date + $6::time) AT TIME ZONE $8),
         (($5::date + $7::time) AT TIME ZONE $8),
         $9
       )
       ON CONFLICT (tenant_id, session_definition_id, session_date) DO UPDATE
         SET capacity = EXCLUDED.capacity,
             version = dated_sessions.version + 1
       RETURNING *`,
      [
        input.tenantId,
        sessionDef.site_id,
        sessionDef.id,
        sessionDef.room_id,
        input.sessionDate,
        sessionDef.local_start_time,
        sessionDef.local_end_time,
        sessionDef.timezone,
        capacity,
      ],
    );
    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'sessions.materialise',
      entityType: 'dated_session',
      entityId: r.rows[0]!.id as string,
      correlationId: input.correlationId,
    });
    return r.rows[0];
  }, pool);
}

export async function listDatedSessions(
  input: { tenantId: string; siteId?: string; fromDate?: string; toDate?: string; limit?: number },
  pool: DbPool,
) {
  const limit = Math.min(input.limit ?? 50, 100);
  return withTenant(input.tenantId, async (db) => {
    const r = await db.query(
      `SELECT ds.*,
              (
                SELECT count(*)::int FROM bookings b
                WHERE b.tenant_id = ds.tenant_id
                  AND b.dated_session_id = ds.id
                  AND b.status = 'confirmed'
              ) AS confirmed_count,
              (
                SELECT count(*)::int FROM reservations rv
                WHERE rv.tenant_id = ds.tenant_id
                  AND rv.dated_session_id = ds.id
                  AND rv.status = 'holding'
                  AND rv.expires_at > now()
              ) AS holding_count
       FROM dated_sessions ds
       WHERE ($1::uuid IS NULL OR ds.site_id = $1)
         AND ($2::date IS NULL OR ds.session_date >= $2::date)
         AND ($3::date IS NULL OR ds.session_date <= $3::date)
       ORDER BY ds.session_date, ds.starts_at
       LIMIT $4`,
      [input.siteId ?? null, input.fromDate ?? null, input.toDate ?? null, limit],
    );
    return r.rows;
  }, pool);
}

export async function getDatedSession(tenantId: string, datedSessionId: string, pool: DbPool) {
  return withTenant(tenantId, async (db) => {
    const r = await db.query(`SELECT * FROM dated_sessions WHERE id = $1`, [datedSessionId]);
    const row = r.rows[0];
    if (!row) throw notFound('Dated session not found');
    return row;
  }, pool);
}
