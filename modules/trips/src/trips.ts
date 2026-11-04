import type { DbPool } from '../../../platform/db/src/pool.js';
import { withTenant } from '../../../platform/db/src/index.js';
import { writeAudit } from '../../../platform/audit/src/index.js';
import {
  featureDisabled,
  forbidden,
  notFound,
  validationError,
  conflict,
} from '../../../platform/http/src/errors.js';

export interface TripRow {
  id: string;
  tenant_id: string;
  site_id: string | null;
  title: string;
  description: string;
  destination: string;
  status: string;
  starts_at: Date;
  ends_at: Date | null;
  created_at: Date;
}

export async function createTrip(
  input: {
    tenantId: string;
    actorUserId: string;
    title: string;
    startsAt: string;
    endsAt?: string;
    siteId?: string;
    destination?: string;
    description?: string;
    riskSummary?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<TripRow> {
  return withTenant(input.tenantId, async (db) => {
    if (!input.title.trim()) throw validationError('title required');
    if (!input.startsAt) throw validationError('starts_at required');

    const row = await db.query<TripRow>(
      `INSERT INTO trips (
         tenant_id, site_id, title, description, destination, status,
         starts_at, ends_at, risk_summary, created_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,'planned',$6,$7,$8,$9)
       RETURNING id, tenant_id, site_id, title, description, destination, status,
                 starts_at, ends_at, created_at`,
      [
        input.tenantId,
        input.siteId ?? null,
        input.title.trim(),
        input.description ?? '',
        input.destination ?? '',
        input.startsAt,
        input.endsAt ?? null,
        input.riskSummary ?? '',
        input.actorUserId,
      ],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'trips.create',
      entityType: 'trip',
      entityId: row.rows[0]!.id,
      correlationId: input.correlationId,
    });

    return row.rows[0]!;
  }, pool);
}

export async function listTrips(
  tenantId: string,
  limit: number,
  pool: DbPool,
): Promise<TripRow[]> {
  return withTenant(tenantId, async (db) => {
    const result = await db.query<TripRow>(
      `SELECT id, tenant_id, site_id, title, description, destination, status,
              starts_at, ends_at, created_at
       FROM trips
       ORDER BY starts_at DESC
       LIMIT $1`,
      [Math.min(Math.max(limit, 1), 100)],
    );
    return result.rows;
  }, pool);
}

export async function getTrip(
  tenantId: string,
  tripId: string,
  pool: DbPool,
): Promise<TripRow> {
  return withTenant(tenantId, async (db) => {
    const row = await db.query<TripRow>(
      `SELECT id, tenant_id, site_id, title, description, destination, status,
              starts_at, ends_at, created_at
       FROM trips WHERE id = $1`,
      [tripId],
    );
    if (row.rowCount === 0) throw notFound('Trip not found');
    return row.rows[0]!;
  }, pool);
}

export async function addTripParticipant(
  input: {
    tenantId: string;
    actorUserId: string;
    tripId: string;
    role: 'child' | 'staff' | 'volunteer';
    childId?: string;
    staffProfileId?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<{ id: string; role: string; child_id: string | null }> {
  return withTenant(input.tenantId, async (db) => {
    const trip = await db.query(`SELECT id FROM trips WHERE id = $1`, [input.tripId]);
    if (trip.rowCount === 0) throw notFound('Trip not found');

    if (input.role === 'child') {
      if (!input.childId) throw validationError('child_id required for child participants');
      const child = await db.query(
        `SELECT id FROM children WHERE id = $1 AND deleted_at IS NULL`,
        [input.childId],
      );
      if (!child.rowCount) throw notFound('Child not found');
    } else if (!input.staffProfileId) {
      throw validationError('staff_profile_id required for staff/volunteer participants');
    }

    try {
      const row = await db.query<{ id: string; role: string; child_id: string | null }>(
        `INSERT INTO trip_participants (
           tenant_id, trip_id, child_id, staff_profile_id, role
         ) VALUES ($1,$2,$3,$4,$5)
         RETURNING id, role, child_id`,
        [
          input.tenantId,
          input.tripId,
          input.childId ?? null,
          input.staffProfileId ?? null,
          input.role,
        ],
      );

      if (input.role === 'child') {
        await db.query(
          `UPDATE trips SET status = 'permissions_pending', updated_at = now()
           WHERE id = $1 AND status = 'planned'`,
          [input.tripId],
        );
      }

      await writeAudit(db, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        action: 'trips.participant.add',
        entityType: 'trip_participant',
        entityId: row.rows[0]!.id,
        correlationId: input.correlationId,
      });

      return row.rows[0]!;
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') {
        throw conflict('Participant already on this trip');
      }
      throw err;
    }
  }, pool);
}

export async function requestTripPermission(
  input: {
    tenantId: string;
    actorUserId: string;
    tripId: string;
    childId: string;
    guardianId: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<{ id: string; status: string }> {
  return withTenant(input.tenantId, async (db) => {
    const trip = await db.query(`SELECT id FROM trips WHERE id = $1`, [input.tripId]);
    if (trip.rowCount === 0) throw notFound('Trip not found');

    const rel = await db.query(
      `SELECT id FROM child_guardian_relationships
       WHERE child_id = $1 AND guardian_id = $2 AND revoked_at IS NULL`,
      [input.childId, input.guardianId],
    );
    if (!rel.rowCount) throw validationError('Guardian is not linked to child');

    try {
      const row = await db.query<{ id: string; status: string }>(
        `INSERT INTO trip_permissions (
           tenant_id, trip_id, child_id, guardian_id, status
         ) VALUES ($1,$2,$3,$4,'pending')
         RETURNING id, status`,
        [input.tenantId, input.tripId, input.childId, input.guardianId],
      );

      await writeAudit(db, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        action: 'trips.permission.request',
        entityType: 'trip_permission',
        entityId: row.rows[0]!.id,
        correlationId: input.correlationId,
      });

      return row.rows[0]!;
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') {
        throw conflict('Permission request already exists');
      }
      throw err;
    }
  }, pool);
}

export async function respondTripPermission(
  input: {
    tenantId: string;
    actorUserId: string;
    permissionId: string;
    status: 'granted' | 'declined';
    note?: string;
    roleTemplate?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<{ id: string; status: string }> {
  return withTenant(input.tenantId, async (db) => {
    const existing = await db.query<{
      id: string;
      guardian_id: string;
      status: string;
      trip_id: string;
    }>(
      `SELECT id, guardian_id, status, trip_id FROM trip_permissions WHERE id = $1 FOR UPDATE`,
      [input.permissionId],
    );
    if (existing.rowCount === 0) throw notFound('Trip permission not found');
    if (existing.rows[0]!.status !== 'pending') {
      throw conflict('Permission already responded');
    }

    if (input.roleTemplate === 'parent') {
      const link = await db.query(
        `SELECT id FROM guardians WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [existing.rows[0]!.guardian_id, input.actorUserId],
      );
      if (!link.rowCount) throw forbidden('Not authorised to respond to this permission');
    }

    const row = await db.query<{ id: string; status: string }>(
      `UPDATE trip_permissions
       SET status = $2,
           responded_at = now(),
           response_note = $3,
           updated_at = now()
       WHERE id = $1
       RETURNING id, status`,
      [input.permissionId, input.status, input.note ?? null],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'trips.permission.respond',
      entityType: 'trip_permission',
      entityId: input.permissionId,
      correlationId: input.correlationId,
      metadata: { status: input.status },
    });

    return row.rows[0]!;
  }, pool);
}

export async function recordHeadcount(
  input: {
    tenantId: string;
    actorUserId: string;
    tripId: string;
    expectedCount: number;
    actualCount: number;
    notes?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<{ id: string; expected_count: number; actual_count: number; counted_at: Date }> {
  return withTenant(input.tenantId, async (db) => {
    const trip = await db.query(`SELECT id FROM trips WHERE id = $1`, [input.tripId]);
    if (trip.rowCount === 0) throw notFound('Trip not found');
    if (input.expectedCount < 0 || input.actualCount < 0) {
      throw validationError('counts must be non-negative');
    }

    const row = await db.query<{
      id: string;
      expected_count: number;
      actual_count: number;
      counted_at: Date;
    }>(
      `INSERT INTO trip_headcounts (
         tenant_id, trip_id, expected_count, actual_count, notes, recorded_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, expected_count, actual_count, counted_at`,
      [
        input.tenantId,
        input.tripId,
        input.expectedCount,
        input.actualCount,
        input.notes ?? '',
        input.actorUserId,
      ],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'trips.headcount.record',
      entityType: 'trip_headcount',
      entityId: row.rows[0]!.id,
      correlationId: input.correlationId,
    });

    return row.rows[0]!;
  }, pool);
}

/**
 * Online-only location sample. Does not enable live/background GPS (D08).
 * GPS does not replace physical headcounts.
 */
export async function recordOnlineLocationSample(
  input: {
    tenantId: string;
    actorUserId: string;
    tripId: string;
    latitude: number;
    longitude: number;
    accuracyMetres?: number;
    source?: 'online_manual' | 'online_foreground';
    correlationId?: string;
  },
  pool: DbPool,
): Promise<{
  id: string;
  captured_at: Date;
  latitude: string;
  longitude: string;
  accuracy_metres: string | null;
  is_live_stream: boolean;
}> {
  return withTenant(input.tenantId, async (db) => {
    const trip = await db.query(`SELECT id FROM trips WHERE id = $1`, [input.tripId]);
    if (trip.rowCount === 0) throw notFound('Trip not found');
    if (input.latitude < -90 || input.latitude > 90) {
      throw validationError('latitude out of range');
    }
    if (input.longitude < -180 || input.longitude > 180) {
      throw validationError('longitude out of range');
    }

    const row = await db.query<{
      id: string;
      captured_at: Date;
      latitude: string;
      longitude: string;
      accuracy_metres: string | null;
      is_live_stream: boolean;
    }>(
      `INSERT INTO trip_location_samples (
         tenant_id, trip_id, latitude, longitude, accuracy_metres,
         source, is_live_stream, recorded_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6,false,$7)
       RETURNING id, captured_at, latitude, longitude, accuracy_metres, is_live_stream`,
      [
        input.tenantId,
        input.tripId,
        input.latitude,
        input.longitude,
        input.accuracyMetres ?? null,
        input.source ?? 'online_manual',
        input.actorUserId,
      ],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'trips.location.record',
      entityType: 'trip_location_sample',
      entityId: row.rows[0]!.id,
      correlationId: input.correlationId,
      metadata: { note: 'online_only_point_in_time' },
    });

    return row.rows[0]!;
  }, pool);
}

export function blockLiveTripLocation(): never {
  throw featureDisabled('trips.location.live');
}

export async function listTripLocationSamples(
  tenantId: string,
  tripId: string,
  pool: DbPool,
): Promise<
  Array<{
    id: string;
    captured_at: Date;
    latitude: string;
    longitude: string;
    accuracy_metres: string | null;
  }>
> {
  return withTenant(tenantId, async (db) => {
    const result = await db.query<{
      id: string;
      captured_at: Date;
      latitude: string;
      longitude: string;
      accuracy_metres: string | null;
    }>(
      `SELECT id, captured_at, latitude, longitude, accuracy_metres
       FROM trip_location_samples
       WHERE trip_id = $1
       ORDER BY captured_at DESC
       LIMIT 100`,
      [tripId],
    );
    return result.rows;
  }, pool);
}
