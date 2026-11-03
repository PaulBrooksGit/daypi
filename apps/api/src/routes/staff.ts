import { Router } from 'express';
import { z } from 'zod';
import type { DbPool } from '../../../../platform/db/src/index.js';
import {
  createAuthMiddleware,
  requireActiveTenant,
  requireOperation,
} from '../../../../platform/auth/src/index.js';
import {
  createStaffProfile,
  listStaff,
  createRotaShift,
  listRotaShifts,
  recordTimeEvent,
} from '../../../../modules/team/src/index.js';

export function staffRoutes(pool: DbPool): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(pool);

  router.get(
    '/staff',
    requireAuth,
    requireActiveTenant,
    requireOperation('staff.manage'),
    async (req, res, next) => {
      try {
        const rows = await listStaff(
          { tenantId: req.actor!.activeTenantId!, limit: Number(req.query.limit ?? 50) },
          pool,
        );
        res.json({ data: rows, next_cursor: null });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/staff',
    requireAuth,
    requireActiveTenant,
    requireOperation('staff.manage'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            given_name: z.string().min(1).max(100),
            family_name: z.string().min(1).max(100),
            email: z.string().email().optional(),
            phone_e164: z.string().max(32).optional(),
            job_title: z.string().max(100).optional(),
            user_id: z.string().uuid().optional(),
            site_id: z.string().uuid().optional(),
          })
          .parse(req.body);
        const created = await createStaffProfile(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            givenName: body.given_name,
            familyName: body.family_name,
            email: body.email,
            phoneE164: body.phone_e164,
            jobTitle: body.job_title,
            userId: body.user_id,
            siteId: body.site_id,
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

  router.get(
    '/rota/shifts',
    requireAuth,
    requireActiveTenant,
    requireOperation('rota.manage'),
    async (req, res, next) => {
      try {
        const rows = await listRotaShifts(
          {
            tenantId: req.actor!.activeTenantId!,
            siteId: typeof req.query.site_id === 'string' ? req.query.site_id : undefined,
            from: typeof req.query.from === 'string' ? req.query.from : undefined,
            to: typeof req.query.to === 'string' ? req.query.to : undefined,
            limit: Number(req.query.limit ?? 100),
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
    '/rota/shifts',
    requireAuth,
    requireActiveTenant,
    requireOperation('rota.manage'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            staff_profile_id: z.string().uuid(),
            site_id: z.string().uuid(),
            starts_at: z.string().datetime(),
            ends_at: z.string().datetime(),
            room_id: z.string().uuid().optional(),
            notes: z.string().max(1000).optional(),
          })
          .parse(req.body);
        const created = await createRotaShift(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            staffProfileId: body.staff_profile_id,
            siteId: body.site_id,
            startsAt: body.starts_at,
            endsAt: body.ends_at,
            roomId: body.room_id,
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
    '/time-events',
    requireAuth,
    requireActiveTenant,
    requireOperation('time.record'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            staff_profile_id: z.string().uuid(),
            site_id: z.string().uuid(),
            event_type: z.enum(['clock_in', 'clock_out', 'break_start', 'break_end']),
            occurred_at: z.string().datetime().optional(),
            notes: z.string().max(1000).optional(),
          })
          .parse(req.body);
        const created = await recordTimeEvent(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            staffProfileId: body.staff_profile_id,
            siteId: body.site_id,
            eventType: body.event_type,
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

  return router;
}
