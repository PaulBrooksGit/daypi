import type { DbClient, DbPool } from '../../../platform/db/src/pool.js';
import { withTenant } from '../../../platform/db/src/index.js';
import { writeAudit } from '../../../platform/audit/src/index.js';
import {
  notFound,
  conflict,
  forbidden,
  validationError,
} from '../../../platform/http/src/errors.js';
import { assertParentChildAccess } from '../../../platform/tenancy/src/index.js';

export interface BookingRow {
  id: string;
  tenant_id: string;
  child_id: string;
  dated_session_id: string;
  status: string;
  reservation_id: string | null;
  idempotency_key: string | null;
  confirmed_at: Date | null;
  created_at: Date;
}

async function expireStaleHolds(db: DbClient, datedSessionId: string): Promise<void> {
  await db.query(
    `UPDATE reservations
     SET status = 'expired', released_at = now(), updated_at = now()
     WHERE dated_session_id = $1
       AND status = 'holding'
       AND expires_at <= now()`,
    [datedSessionId],
  );
}

/**
 * Transactional capacity check under row lock.
 * Confirmed bookings + active holds cannot exceed capacity.
 * Two concurrent claims for the final place: at most one succeeds.
 */
export async function occupiedPlaces(
  db: DbClient,
  datedSessionId: string,
): Promise<{ capacity: number; occupied: number; status: string }> {
  const session = await db.query<{ capacity: number; status: string }>(
    `SELECT capacity, status FROM dated_sessions WHERE id = $1 FOR UPDATE`,
    [datedSessionId],
  );
  const row = session.rows[0];
  if (!row) throw notFound('Dated session not found');

  await expireStaleHolds(db, datedSessionId);

  const counts = await db.query<{ occupied: string }>(
    `SELECT (
       (SELECT count(*) FROM bookings
        WHERE dated_session_id = $1 AND status = 'confirmed')
       +
       (SELECT count(*) FROM reservations
        WHERE dated_session_id = $1 AND status = 'holding' AND expires_at > now())
     )::text AS occupied`,
    [datedSessionId],
  );
  return {
    capacity: row.capacity,
    occupied: Number(counts.rows[0]!.occupied),
    status: row.status,
  };
}

export async function createBooking(
  input: {
    tenantId: string;
    actorUserId: string;
    childId: string;
    datedSessionId: string;
    idempotencyKey?: string;
    roleTemplate?: string;
    reservationId?: string;
    /** Staff may confirm immediately; parents create advisory requests only. */
    confirmImmediately?: boolean;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<BookingRow> {
  const confirmImmediately =
    input.confirmImmediately ?? input.roleTemplate !== 'parent';

  return withTenant(input.tenantId, async (db) => {
    if (input.idempotencyKey) {
      const existing = await db.query<BookingRow>(
        `SELECT id, tenant_id, child_id, dated_session_id, status, reservation_id,
                idempotency_key, confirmed_at, created_at
         FROM bookings WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      if (existing.rows[0]) return existing.rows[0];
    }

    if (input.roleTemplate === 'parent') {
      await assertParentChildAccess(db, {
        tenantId: input.tenantId,
        guardianUserId: input.actorUserId,
        childId: input.childId,
      });
    }

    const child = await db.query(
      `SELECT id FROM children WHERE id = $1 AND deleted_at IS NULL`,
      [input.childId],
    );
    if (child.rowCount === 0) throw notFound('Child not found');

    if (!confirmImmediately) {
      try {
        const r = await db.query<BookingRow>(
          `INSERT INTO bookings (
             tenant_id, child_id, dated_session_id, status,
             idempotency_key, requested_by_user_id
           ) VALUES ($1,$2,$3,'requested',$4,$5)
           RETURNING id, tenant_id, child_id, dated_session_id, status, reservation_id,
                     idempotency_key, confirmed_at, created_at`,
          [
            input.tenantId,
            input.childId,
            input.datedSessionId,
            input.idempotencyKey ?? null,
            input.actorUserId,
          ],
        );
        await writeAudit(db, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: 'bookings.request',
          entityType: 'booking',
          entityId: r.rows[0]!.id,
          correlationId: input.correlationId,
        });
        return r.rows[0]!;
      } catch (err) {
        const pgCode = (err as { code?: string }).code;
        if (pgCode === '23505') {
          throw conflict('Child already has an active booking for this session');
        }
        throw err;
      }
    }

    return confirmBookingInTx(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      childId: input.childId,
      datedSessionId: input.datedSessionId,
      idempotencyKey: input.idempotencyKey,
      reservationId: input.reservationId,
      correlationId: input.correlationId,
    });
  }, pool);
}

/** @deprecated Prefer createBooking; kept for call-site clarity in tests. */
export async function createConfirmedBooking(
  input: Parameters<typeof createBooking>[0],
  pool: DbPool,
): Promise<BookingRow> {
  return createBooking({ ...input, confirmImmediately: true }, pool);
}

async function confirmBookingInTx(
  db: DbClient,
  input: {
    tenantId: string;
    actorUserId: string;
    childId: string;
    datedSessionId: string;
    bookingId?: string;
    idempotencyKey?: string;
    reservationId?: string;
    correlationId?: string;
  },
): Promise<BookingRow> {
  const places = await occupiedPlaces(db, input.datedSessionId);
  if (places.status !== 'open') {
    throw conflict('Session is not open for booking');
  }

  let reservationConsumed = false;
  if (input.reservationId) {
    const hold = await db.query<{ id: string; child_id: string; status: string }>(
      `SELECT id, child_id, status FROM reservations
       WHERE id = $1 AND dated_session_id = $2 FOR UPDATE`,
      [input.reservationId, input.datedSessionId],
    );
    const res = hold.rows[0];
    if (!res || res.status !== 'holding') {
      throw conflict('Reservation is not active');
    }
    if (res.child_id !== input.childId) {
      throw forbidden('Reservation belongs to a different child');
    }
    await db.query(
      `UPDATE reservations SET status = 'converted', updated_at = now() WHERE id = $1`,
      [input.reservationId],
    );
    reservationConsumed = true;
  }

  // Hold already counted in occupied; converting it frees the hold slot for this confirm.
  const effectiveOccupied = reservationConsumed
    ? Math.max(0, places.occupied - 1)
    : places.occupied;
  if (effectiveOccupied >= places.capacity) {
    throw conflict('No capacity remaining for this session', {
      capacity: places.capacity,
      occupied: places.occupied,
    });
  }

  try {
    if (input.bookingId) {
      const r = await db.query<BookingRow>(
        `UPDATE bookings SET
           status = 'confirmed',
           confirmed_at = now(),
           reservation_id = COALESCE($2, reservation_id),
           version = version + 1
         WHERE id = $1 AND status = 'requested'
         RETURNING id, tenant_id, child_id, dated_session_id, status, reservation_id,
                   idempotency_key, confirmed_at, created_at`,
        [input.bookingId, input.reservationId ?? null],
      );
      if (r.rowCount === 0) throw conflict('Booking is not in requested status');
      await db.query(`UPDATE dated_sessions SET version = version + 1 WHERE id = $1`, [
        input.datedSessionId,
      ]);
      await writeAudit(db, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        action: 'bookings.confirm',
        entityType: 'booking',
        entityId: r.rows[0]!.id,
        correlationId: input.correlationId,
      });
      return r.rows[0]!;
    }

    const r = await db.query<BookingRow>(
      `INSERT INTO bookings (
         tenant_id, child_id, dated_session_id, status, reservation_id,
         idempotency_key, requested_by_user_id, confirmed_at
       ) VALUES ($1,$2,$3,'confirmed',$4,$5,$6, now())
       RETURNING id, tenant_id, child_id, dated_session_id, status, reservation_id,
                 idempotency_key, confirmed_at, created_at`,
      [
        input.tenantId,
        input.childId,
        input.datedSessionId,
        input.reservationId ?? null,
        input.idempotencyKey ?? null,
        input.actorUserId,
      ],
    );

    await db.query(`UPDATE dated_sessions SET version = version + 1 WHERE id = $1`, [
      input.datedSessionId,
    ]);

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'bookings.confirm',
      entityType: 'booking',
      entityId: r.rows[0]!.id,
      correlationId: input.correlationId,
      metadata: { dated_session_id: input.datedSessionId, child_id: input.childId },
    });
    return r.rows[0]!;
  } catch (err) {
    if (err instanceof Error && 'code' in err === false && err.message.includes('not in requested')) {
      throw err;
    }
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '23505') {
      throw conflict('Child already has an active booking for this session');
    }
    throw err;
  }
}

export async function confirmBooking(
  input: {
    tenantId: string;
    actorUserId: string;
    bookingId: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<BookingRow> {
  return withTenant(input.tenantId, async (db) => {
    const existing = await db.query<BookingRow>(
      `SELECT id, tenant_id, child_id, dated_session_id, status, reservation_id,
              idempotency_key, confirmed_at, created_at
       FROM bookings WHERE id = $1 FOR UPDATE`,
      [input.bookingId],
    );
    const booking = existing.rows[0];
    if (!booking) throw notFound('Booking not found');
    if (booking.status === 'confirmed') return booking;
    if (booking.status !== 'requested') {
      throw conflict(`Cannot confirm booking in status ${booking.status}`);
    }
    return confirmBookingInTx(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      childId: booking.child_id,
      datedSessionId: booking.dated_session_id,
      bookingId: booking.id,
      correlationId: input.correlationId,
    });
  }, pool);
}

export async function createReservation(
  input: {
    tenantId: string;
    actorUserId: string;
    childId: string;
    datedSessionId: string;
    holdSeconds?: number;
    roleTemplate?: string;
    correlationId?: string;
  },
  pool: DbPool,
) {
  const holdSeconds = Math.min(Math.max(input.holdSeconds ?? 120, 30), 900);
  return withTenant(input.tenantId, async (db) => {
    if (input.roleTemplate === 'parent') {
      await assertParentChildAccess(db, {
        tenantId: input.tenantId,
        guardianUserId: input.actorUserId,
        childId: input.childId,
      });
    }

    const places = await occupiedPlaces(db, input.datedSessionId);
    if (places.status !== 'open') throw conflict('Session is not open');
    if (places.occupied >= places.capacity) {
      throw conflict('No capacity remaining for this session', {
        capacity: places.capacity,
        occupied: places.occupied,
      });
    }

    const r = await db.query(
      `INSERT INTO reservations (
         tenant_id, child_id, dated_session_id, status, expires_at, held_by_user_id
       ) VALUES ($1,$2,$3,'holding', now() + ($4::text || ' seconds')::interval, $5)
       RETURNING *`,
      [
        input.tenantId,
        input.childId,
        input.datedSessionId,
        String(holdSeconds),
        input.actorUserId,
      ],
    );
    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'reservations.create',
      entityType: 'reservation',
      entityId: r.rows[0]!.id as string,
      correlationId: input.correlationId,
    });
    return r.rows[0];
  }, pool);
}

export async function listBookings(
  input: {
    tenantId: string;
    datedSessionId?: string;
    childId?: string;
    actorUserId: string;
    roleTemplate?: string;
    limit?: number;
  },
  pool: DbPool,
) {
  const limit = Math.min(input.limit ?? 50, 100);
  return withTenant(input.tenantId, async (db) => {
    if (input.roleTemplate === 'parent') {
      const r = await db.query(
        `SELECT b.*
         FROM bookings b
         JOIN child_guardian_relationships rel
           ON rel.tenant_id = b.tenant_id AND rel.child_id = b.child_id
         JOIN guardians g
           ON g.tenant_id = rel.tenant_id AND g.id = rel.guardian_id
         WHERE g.user_id = $1
           AND rel.revoked_at IS NULL
           AND rel.access_level IN ('full', 'limited')
           AND ($2::uuid IS NULL OR b.dated_session_id = $2)
           AND ($3::uuid IS NULL OR b.child_id = $3)
         ORDER BY b.created_at DESC
         LIMIT $4`,
        [input.actorUserId, input.datedSessionId ?? null, input.childId ?? null, limit],
      );
      return r.rows;
    }
    const r = await db.query(
      `SELECT * FROM bookings
       WHERE ($1::uuid IS NULL OR dated_session_id = $1)
         AND ($2::uuid IS NULL OR child_id = $2)
       ORDER BY created_at DESC
       LIMIT $3`,
      [input.datedSessionId ?? null, input.childId ?? null, limit],
    );
    return r.rows;
  }, pool);
}

export async function cancelBooking(
  input: {
    tenantId: string;
    actorUserId: string;
    bookingId: string;
    roleTemplate?: string;
    correlationId?: string;
  },
  pool: DbPool,
) {
  return withTenant(input.tenantId, async (db) => {
    const existing = await db.query<BookingRow>(
      `SELECT id, tenant_id, child_id, dated_session_id, status, reservation_id,
              idempotency_key, confirmed_at, created_at
       FROM bookings WHERE id = $1 FOR UPDATE`,
      [input.bookingId],
    );
    const booking = existing.rows[0];
    if (!booking) throw notFound('Booking not found');
    if (booking.status === 'cancelled') return booking;

    if (input.roleTemplate === 'parent') {
      await assertParentChildAccess(db, {
        tenantId: input.tenantId,
        guardianUserId: input.actorUserId,
        childId: booking.child_id,
      });
    }

    const r = await db.query<BookingRow>(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = now(), version = version + 1
       WHERE id = $1
       RETURNING id, tenant_id, child_id, dated_session_id, status, reservation_id,
                 idempotency_key, confirmed_at, created_at`,
      [input.bookingId],
    );
    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'bookings.cancel',
      entityType: 'booking',
      entityId: input.bookingId,
      correlationId: input.correlationId,
    });
    return r.rows[0]!;
  }, pool);
}

export function assertCapacityPositive(capacity: number): void {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw validationError('capacity must be a positive integer');
  }
}
