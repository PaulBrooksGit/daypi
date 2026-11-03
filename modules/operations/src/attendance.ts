import type { DbClient, DbPool } from '../../../platform/db/src/pool.js';
import { withTenant } from '../../../platform/db/src/index.js';
import { writeAudit } from '../../../platform/audit/src/index.js';
import {
  notFound,
  conflict,
  forbidden,
  validationError,
} from '../../../platform/http/src/errors.js';


export interface RegisterEntry {
  child_id: string;
  given_name: string;
  family_name: string;
  booking_id: string | null;
  booking_status: string | null;
  status: 'expected' | 'present' | 'collected' | 'absent';
  last_event_type: string | null;
  last_occurred_at: string | null;
  last_event_id: string | null;
}

/**
 * Operational register for a dated session.
 * Derived from confirmed bookings + non-voided attendance events (corrections applied).
 */
export async function getSessionRegister(
  input: { tenantId: string; datedSessionId: string },
  pool: DbPool,
): Promise<{ dated_session_id: string; entries: RegisterEntry[] }> {
  return withTenant(input.tenantId, async (db) => {
    const session = await db.query(`SELECT id FROM dated_sessions WHERE id = $1`, [
      input.datedSessionId,
    ]);
    if (session.rowCount === 0) throw notFound('Dated session not found');

    const r = await db.query<{
      child_id: string;
      given_name: string;
      family_name: string;
      booking_id: string | null;
      booking_status: string | null;
      last_event_type: string | null;
      last_occurred_at: Date | null;
      last_event_id: string | null;
    }>(
      `WITH booked AS (
         SELECT b.id AS booking_id, b.child_id, b.status AS booking_status,
                c.given_name, c.family_name
         FROM bookings b
         JOIN children c ON c.tenant_id = b.tenant_id AND c.id = b.child_id
         WHERE b.dated_session_id = $1
           AND b.status = 'confirmed'
           AND c.deleted_at IS NULL
       ),
       effective_events AS (
         SELECT ae.*
         FROM attendance_events ae
         WHERE ae.dated_session_id = $1
           AND ae.superseded_by_correction_id IS NULL
       ),
       latest AS (
         SELECT DISTINCT ON (child_id)
                child_id, event_type, occurred_at, id
         FROM effective_events
         ORDER BY child_id, occurred_at DESC, created_at DESC
       )
       SELECT b.child_id, b.given_name, b.family_name, b.booking_id, b.booking_status,
              l.event_type AS last_event_type, l.occurred_at AS last_occurred_at,
              l.id AS last_event_id
       FROM booked b
       LEFT JOIN latest l ON l.child_id = b.child_id
       ORDER BY b.family_name, b.given_name`,
      [input.datedSessionId],
    );

    const entries: RegisterEntry[] = r.rows.map((row) => {
      let status: RegisterEntry['status'] = 'expected';
      if (row.last_event_type === 'check_in') status = 'present';
      else if (row.last_event_type === 'check_out') status = 'collected';
      return {
        child_id: row.child_id,
        given_name: row.given_name,
        family_name: row.family_name,
        booking_id: row.booking_id,
        booking_status: row.booking_status,
        status,
        last_event_type: row.last_event_type,
        last_occurred_at: row.last_occurred_at
          ? new Date(row.last_occurred_at).toISOString()
          : null,
        last_event_id: row.last_event_id,
      };
    });

    return { dated_session_id: input.datedSessionId, entries };
  }, pool);
}

export async function checkIn(
  input: {
    tenantId: string;
    actorUserId: string;
    childId: string;
    datedSessionId: string;
    occurredAt?: string;
    notes?: string;
    correlationId?: string;
  },
  pool: DbPool,
) {
  return recordAttendanceEvent({ ...input, eventType: 'check_in' }, pool);
}

export async function checkOut(
  input: {
    tenantId: string;
    actorUserId: string;
    childId: string;
    datedSessionId: string;
    occurredAt?: string;
    collectorGuardianId?: string;
    notes?: string;
    correlationId?: string;
  },
  pool: DbPool,
) {
  return withTenant(input.tenantId, async (db) => {
    if (input.collectorGuardianId) {
      const ok = await db.query(
        `SELECT 1 FROM child_guardian_relationships
         WHERE child_id = $1 AND guardian_id = $2
           AND revoked_at IS NULL
           AND is_authorised_collector = true
           AND access_level IN ('full', 'limited')`,
        [input.childId, input.collectorGuardianId],
      );
      if (ok.rowCount === 0) {
        throw forbidden('Collector is not authorised for this child');
      }
      const restriction = await db.query(
        `SELECT 1 FROM relationship_restrictions
         WHERE child_id = $1 AND subject_guardian_id = $2
           AND effective_from <= now()
           AND (effective_to IS NULL OR effective_to > now())`,
        [input.childId, input.collectorGuardianId],
      );
      if (restriction.rowCount && restriction.rowCount > 0) {
        throw forbidden('Collector is restricted for this child');
      }
    }
    return recordAttendanceEventInTx(db, {
      ...input,
      eventType: 'check_out',
    });
  }, pool);
}

async function recordAttendanceEvent(
  input: {
    tenantId: string;
    actorUserId: string;
    childId: string;
    datedSessionId: string;
    eventType: 'check_in' | 'check_out';
    occurredAt?: string;
    collectorGuardianId?: string;
    notes?: string;
    correlationId?: string;
  },
  pool: DbPool,
) {
  return withTenant(input.tenantId, async (db) => recordAttendanceEventInTx(db, input), pool);
}

async function recordAttendanceEventInTx(
  db: DbClient,
  input: {
    tenantId: string;
    actorUserId: string;
    childId: string;
    datedSessionId: string;
    eventType: 'check_in' | 'check_out';
    occurredAt?: string;
    collectorGuardianId?: string;
    notes?: string;
    correlationId?: string;
  },
) {
  const booking = await db.query<{ id: string }>(
    `SELECT id FROM bookings
     WHERE child_id = $1 AND dated_session_id = $2 AND status = 'confirmed'`,
    [input.childId, input.datedSessionId],
  );
  if (booking.rowCount === 0) {
    throw conflict('Child does not have a confirmed booking for this session');
  }

  const latest = await db.query<{ event_type: string }>(
    `SELECT event_type FROM attendance_events
     WHERE child_id = $1 AND dated_session_id = $2
       AND superseded_by_correction_id IS NULL
     ORDER BY occurred_at DESC, created_at DESC
     LIMIT 1`,
    [input.childId, input.datedSessionId],
  );
  const last = latest.rows[0]?.event_type;
  if (input.eventType === 'check_in' && last === 'check_in') {
    throw conflict('Child is already checked in');
  }
  if (input.eventType === 'check_out' && last !== 'check_in') {
    throw conflict('Child must be checked in before check-out');
  }

  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  if (Number.isNaN(occurredAt.getTime())) {
    throw validationError('Invalid occurred_at');
  }

  const r = await db.query(
    `INSERT INTO attendance_events (
       tenant_id, child_id, dated_session_id, booking_id, event_type,
       occurred_at, recorded_by_user_id, collector_guardian_id, notes
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      input.tenantId,
      input.childId,
      input.datedSessionId,
      booking.rows[0]!.id,
      input.eventType,
      occurredAt.toISOString(),
      input.actorUserId,
      input.collectorGuardianId ?? null,
      input.notes ?? null,
    ],
  );

  await writeAudit(db, {
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    action: `attendance.${input.eventType}`,
    entityType: 'attendance_event',
    entityId: r.rows[0]!.id as string,
    correlationId: input.correlationId,
  });
  return r.rows[0];
}

/**
 * Manager correction workflow: never silently rewrite history.
 * Creates an append-only correction and optionally a replacement event; voids mark superseded.
 */
export async function correctAttendance(
  input: {
    tenantId: string;
    actorUserId: string;
    attendanceEventId: string;
    correctionType: 'amend_time' | 'amend_type' | 'void_event' | 'add_missing';
    reason: string;
    newEventType?: 'check_in' | 'check_out';
    newOccurredAt?: string;
    correlationId?: string;
  },
  pool: DbPool,
) {
  if (!input.reason.trim()) throw validationError('Correction reason is required');

  return withTenant(input.tenantId, async (db) => {
    const event = await db.query<{
      id: string;
      child_id: string;
      dated_session_id: string;
      event_type: string;
      occurred_at: Date;
      superseded_by_correction_id: string | null;
    }>(`SELECT * FROM attendance_events WHERE id = $1 FOR UPDATE`, [input.attendanceEventId]);
    const original = event.rows[0];
    if (!original) throw notFound('Attendance event not found');
    if (original.superseded_by_correction_id) {
      throw conflict('Attendance event already corrected');
    }

    const correction = await db.query<{ id: string }>(
      `INSERT INTO attendance_corrections (
         tenant_id, attendance_event_id, child_id, dated_session_id,
         correction_type, previous_event_type, previous_occurred_at,
         new_event_type, new_occurred_at, reason, applied_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        input.tenantId,
        original.id,
        original.child_id,
        original.dated_session_id,
        input.correctionType,
        original.event_type,
        original.occurred_at,
        input.newEventType ?? null,
        input.newOccurredAt ?? null,
        input.reason,
        input.actorUserId,
      ],
    );

    await db.query(
      `UPDATE attendance_events
       SET superseded_by_correction_id = $2
       WHERE id = $1`,
      [original.id, correction.rows[0]!.id],
    );

    let replacement = null;
    if (input.correctionType === 'amend_time' || input.correctionType === 'amend_type') {
      const newType = input.newEventType ?? (original.event_type as 'check_in' | 'check_out');
      const newTime = input.newOccurredAt
        ? new Date(input.newOccurredAt)
        : new Date(original.occurred_at);
      const rep = await db.query(
        `INSERT INTO attendance_events (
           tenant_id, child_id, dated_session_id, event_type, occurred_at, recorded_by_user_id, notes
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [
          input.tenantId,
          original.child_id,
          original.dated_session_id,
          newType,
          newTime.toISOString(),
          input.actorUserId,
          `Correction of ${original.id}: ${input.reason}`,
        ],
      );
      replacement = rep.rows[0];
    }

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'attendance.correct',
      entityType: 'attendance_correction',
      entityId: correction.rows[0]!.id,
      reason: input.reason,
      correlationId: input.correlationId,
      metadata: { correction_type: input.correctionType, original_event_id: original.id },
    });

    return {
      correction_id: correction.rows[0]!.id,
      original_event_id: original.id,
      replacement_event: replacement,
    };
  }, pool);
}
