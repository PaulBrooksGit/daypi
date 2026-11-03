import type { DbPool } from '../../../platform/db/src/pool.js';
import { withTenant } from '../../../platform/db/src/index.js';
import { writeAudit } from '../../../platform/audit/src/index.js';
import { notFound, conflict } from '../../../platform/http/src/errors.js';

export async function createStaffProfile(
  input: {
    tenantId: string;
    actorUserId: string;
    givenName: string;
    familyName: string;
    email?: string;
    phoneE164?: string;
    jobTitle?: string;
    userId?: string;
    siteId?: string;
    correlationId?: string;
  },
  pool: DbPool,
) {
  return withTenant(input.tenantId, async (db) => {
    const r = await db.query(
      `INSERT INTO staff_profiles (
         tenant_id, user_id, given_name, family_name, email, phone_e164, job_title
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        input.tenantId,
        input.userId ?? null,
        input.givenName,
        input.familyName,
        input.email ?? null,
        input.phoneE164 ?? null,
        input.jobTitle ?? null,
      ],
    );
    if (input.siteId) {
      await db.query(
        `INSERT INTO staff_assignments (tenant_id, staff_profile_id, site_id, role_label)
         VALUES ($1,$2,$3,$4)`,
        [input.tenantId, r.rows[0]!.id, input.siteId, input.jobTitle ?? 'practitioner'],
      );
    }
    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'staff.manage',
      entityType: 'staff_profile',
      entityId: r.rows[0]!.id as string,
      correlationId: input.correlationId,
    });
    return r.rows[0];
  }, pool);
}

export async function listStaff(
  input: { tenantId: string; limit?: number },
  pool: DbPool,
) {
  const limit = Math.min(input.limit ?? 50, 100);
  return withTenant(input.tenantId, async (db) => {
    const r = await db.query(
      `SELECT * FROM staff_profiles
       WHERE status = 'active'
       ORDER BY family_name, given_name
       LIMIT $1`,
      [limit],
    );
    return r.rows;
  }, pool);
}

export async function createRotaShift(
  input: {
    tenantId: string;
    actorUserId: string;
    staffProfileId: string;
    siteId: string;
    startsAt: string;
    endsAt: string;
    roomId?: string;
    notes?: string;
    correlationId?: string;
  },
  pool: DbPool,
) {
  return withTenant(input.tenantId, async (db) => {
    const staff = await db.query(`SELECT id FROM staff_profiles WHERE id = $1`, [
      input.staffProfileId,
    ]);
    if (staff.rowCount === 0) throw notFound('Staff profile not found');

    const starts = new Date(input.startsAt);
    const ends = new Date(input.endsAt);
    if (!(ends > starts)) throw conflict('Shift end must be after start');

    const r = await db.query(
      `INSERT INTO rota_shifts (
         tenant_id, staff_profile_id, site_id, room_id, starts_at, ends_at, notes
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        input.tenantId,
        input.staffProfileId,
        input.siteId,
        input.roomId ?? null,
        starts.toISOString(),
        ends.toISOString(),
        input.notes ?? null,
      ],
    );
    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'rota.manage',
      entityType: 'rota_shift',
      entityId: r.rows[0]!.id as string,
      correlationId: input.correlationId,
    });
    return r.rows[0];
  }, pool);
}

export async function listRotaShifts(
  input: { tenantId: string; siteId?: string; from?: string; to?: string; limit?: number },
  pool: DbPool,
) {
  const limit = Math.min(input.limit ?? 100, 200);
  return withTenant(input.tenantId, async (db) => {
    const r = await db.query(
      `SELECT * FROM rota_shifts
       WHERE status = 'planned'
         AND ($1::uuid IS NULL OR site_id = $1)
         AND ($2::timestamptz IS NULL OR ends_at >= $2::timestamptz)
         AND ($3::timestamptz IS NULL OR starts_at <= $3::timestamptz)
       ORDER BY starts_at
       LIMIT $4`,
      [input.siteId ?? null, input.from ?? null, input.to ?? null, limit],
    );
    return r.rows;
  }, pool);
}

export async function recordTimeEvent(
  input: {
    tenantId: string;
    actorUserId: string;
    staffProfileId: string;
    siteId: string;
    eventType: 'clock_in' | 'clock_out' | 'break_start' | 'break_end';
    occurredAt?: string;
    notes?: string;
    correlationId?: string;
  },
  pool: DbPool,
) {
  return withTenant(input.tenantId, async (db) => {
    const staff = await db.query(`SELECT id FROM staff_profiles WHERE id = $1`, [
      input.staffProfileId,
    ]);
    if (staff.rowCount === 0) throw notFound('Staff profile not found');

    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
    const r = await db.query(
      `INSERT INTO time_events (
         tenant_id, staff_profile_id, site_id, event_type, occurred_at, recorded_by_user_id, notes
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        input.tenantId,
        input.staffProfileId,
        input.siteId,
        input.eventType,
        occurredAt.toISOString(),
        input.actorUserId,
        input.notes ?? null,
      ],
    );
    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'time.record',
      entityType: 'time_event',
      entityId: r.rows[0]!.id as string,
      correlationId: input.correlationId,
    });
    return r.rows[0];
  }, pool);
}

/** Staff on planned rota overlapping a session window — supports register accuracy context. */
export async function listStaffOnDuty(
  input: { tenantId: string; siteId: string; at: string },
  pool: DbPool,
) {
  return withTenant(input.tenantId, async (db) => {
    const r = await db.query(
      `SELECT sp.id, sp.given_name, sp.family_name, rs.starts_at, rs.ends_at, rs.room_id
       FROM rota_shifts rs
       JOIN staff_profiles sp
         ON sp.tenant_id = rs.tenant_id AND sp.id = rs.staff_profile_id
       WHERE rs.site_id = $1
         AND rs.status = 'planned'
         AND rs.starts_at <= $2::timestamptz
         AND rs.ends_at > $2::timestamptz
       ORDER BY sp.family_name, sp.given_name`,
      [input.siteId, input.at],
    );
    return r.rows;
  }, pool);
}
