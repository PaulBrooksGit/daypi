import { Router } from 'express';
import { z } from 'zod';
import type { DbPool } from '../../../../platform/db/src/index.js';
import {
  createAuthMiddleware,
  requireActiveTenant,
  requireOperation,
} from '../../../../platform/auth/src/index.js';
import {
  createBooking,
  confirmBooking,
  createReservation,
  listBookings,
  cancelBooking,
} from '../../../../modules/core/src/index.js';


export function bookingsRoutes(pool: DbPool): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(pool);

  router.get(
    '/bookings',
    requireAuth,
    requireActiveTenant,
    requireOperation('bookings.create'),
    async (req, res, next) => {
      try {
        const rows = await listBookings(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            roleTemplate: req.actor!.subject?.roleTemplate,
            datedSessionId:
              typeof req.query.dated_session_id === 'string'
                ? req.query.dated_session_id
                : undefined,
            childId: typeof req.query.child_id === 'string' ? req.query.child_id : undefined,
            limit: Number(req.query.limit ?? 50),
          },
          pool,
        );
        res.json({ data: rows, next_cursor: null });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/bookings',
    requireAuth,
    requireActiveTenant,
    requireOperation('bookings.create'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            child_id: z.string().uuid(),
            dated_session_id: z.string().uuid(),
            reservation_id: z.string().uuid().optional(),
          })
          .parse(req.body);
        const idempotencyKey = req.header('idempotency-key') ?? undefined;
        const created = await createBooking(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            childId: body.child_id,
            datedSessionId: body.dated_session_id,
            reservationId: body.reservation_id,
            idempotencyKey,
            roleTemplate: req.actor!.subject?.roleTemplate,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.status(201).json({ data: created });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/bookings/:bookingId/confirm',
    requireAuth,
    requireActiveTenant,
    requireOperation('bookings.confirm'),
    async (req, res, next) => {
      try {
        const confirmed = await confirmBooking(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            bookingId: req.params.bookingId!,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.json({ data: confirmed });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/reservations',
    requireAuth,
    requireActiveTenant,
    requireOperation('bookings.create'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            child_id: z.string().uuid(),
            dated_session_id: z.string().uuid(),
            hold_seconds: z.number().int().min(30).max(900).optional(),
          })
          .parse(req.body);
        const created = await createReservation(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            childId: body.child_id,
            datedSessionId: body.dated_session_id,
            holdSeconds: body.hold_seconds,
            roleTemplate: req.actor!.subject?.roleTemplate,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.status(201).json({ data: created });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/bookings/:bookingId/cancel',
    requireAuth,
    requireActiveTenant,
    requireOperation('bookings.create'),
    async (req, res, next) => {
      try {
        const updated = await cancelBooking(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            bookingId: req.params.bookingId!,
            roleTemplate: req.actor!.subject?.roleTemplate,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.json({ data: updated });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
