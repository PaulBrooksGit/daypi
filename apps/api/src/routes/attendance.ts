import { Router } from 'express';
import { z } from 'zod';
import type { DbPool } from '../../../../platform/db/src/index.js';
import {
  createAuthMiddleware,
  requireActiveTenant,
  requireOperation,
} from '../../../../platform/auth/src/index.js';
import {
  getSessionRegister,
  checkIn,
  checkOut,
  correctAttendance,
} from '../../../../modules/operations/src/index.js';
import { listStaffOnDuty } from '../../../../modules/team/src/index.js';
import { getDatedSession } from '../../../../modules/core/src/index.js';

export function attendanceRoutes(pool: DbPool): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(pool);

  router.get(
    '/registers/:datedSessionId',
    requireAuth,
    requireActiveTenant,
    requireOperation('attendance.check_in_out'),
    async (req, res, next) => {
      try {
        const register = await getSessionRegister(
          {
            tenantId: req.actor!.activeTenantId!,
            datedSessionId: req.params.datedSessionId!,
          },
          pool,
        );
        const session = await getDatedSession(
          req.actor!.activeTenantId!,
          req.params.datedSessionId!,
          pool,
        );
        const onDuty = await listStaffOnDuty(
          {
            tenantId: req.actor!.activeTenantId!,
            siteId: session.site_id as string,
            at: (session.starts_at as Date).toISOString?.() ?? String(session.starts_at),
          },
          pool,
        );
        res.json({
          data: {
            ...register,
            staff_on_duty: onDuty,
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/attendance/check-in',
    requireAuth,
    requireActiveTenant,
    requireOperation('attendance.check_in_out'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            child_id: z.string().uuid(),
            dated_session_id: z.string().uuid(),
            occurred_at: z.string().datetime().optional(),
            notes: z.string().max(1000).optional(),
          })
          .parse(req.body);
        const created = await checkIn(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            childId: body.child_id,
            datedSessionId: body.dated_session_id,
            occurredAt: body.occurred_at,
            notes: body.notes,
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
    '/attendance/check-out',
    requireAuth,
    requireActiveTenant,
    requireOperation('attendance.check_in_out'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            child_id: z.string().uuid(),
            dated_session_id: z.string().uuid(),
            occurred_at: z.string().datetime().optional(),
            collector_guardian_id: z.string().uuid().optional(),
            notes: z.string().max(1000).optional(),
          })
          .parse(req.body);
        const created = await checkOut(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            childId: body.child_id,
            datedSessionId: body.dated_session_id,
            occurredAt: body.occurred_at,
            collectorGuardianId: body.collector_guardian_id,
            notes: body.notes,
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
    '/attendance/:attendanceEventId/corrections',
    requireAuth,
    requireActiveTenant,
    requireOperation('attendance.correct'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            correction_type: z.enum(['amend_time', 'amend_type', 'void_event', 'add_missing']),
            reason: z.string().min(1).max(2000),
            new_event_type: z.enum(['check_in', 'check_out']).optional(),
            new_occurred_at: z.string().datetime().optional(),
          })
          .parse(req.body);
        const result = await correctAttendance(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            attendanceEventId: req.params.attendanceEventId!,
            correctionType: body.correction_type,
            reason: body.reason,
            newEventType: body.new_event_type,
            newOccurredAt: body.new_occurred_at,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.status(201).json({ data: result });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
