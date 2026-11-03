import { Router } from 'express';
import { z } from 'zod';
import type { DbPool } from '../../../../platform/db/src/index.js';
import {
  createAuthMiddleware,
  requireActiveTenant,
  requireOperation,
} from '../../../../platform/auth/src/index.js';
import {
  createSessionDefinition,
  listSessionDefinitions,
  materialiseDatedSession,
  listDatedSessions,
  getDatedSession,
} from '../../../../modules/core/src/index.js';

export function sessionsRoutes(pool: DbPool): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(pool);

  router.get(
    '/session-definitions',
    requireAuth,
    requireActiveTenant,
    requireOperation('sessions.define'),
    async (req, res, next) => {
      try {
        const rows = await listSessionDefinitions(
          {
            tenantId: req.actor!.activeTenantId!,
            siteId: typeof req.query.site_id === 'string' ? req.query.site_id : undefined,
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
    '/session-definitions',
    requireAuth,
    requireActiveTenant,
    requireOperation('sessions.define'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            site_id: z.string().uuid(),
            name: z.string().min(1).max(100),
            local_start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
            local_end_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
            default_capacity: z.number().int().positive(),
            timezone: z.string().max(100).optional(),
            room_id: z.string().uuid().optional(),
          })
          .parse(req.body);
        const created = await createSessionDefinition(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            siteId: body.site_id,
            name: body.name,
            localStartTime: body.local_start_time,
            localEndTime: body.local_end_time,
            defaultCapacity: body.default_capacity,
            timezone: body.timezone,
            roomId: body.room_id,
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
    '/dated-sessions',
    requireAuth,
    requireActiveTenant,
    requireOperation('bookings.create'),
    async (req, res, next) => {
      try {
        const rows = await listDatedSessions(
          {
            tenantId: req.actor!.activeTenantId!,
            siteId: typeof req.query.site_id === 'string' ? req.query.site_id : undefined,
            fromDate: typeof req.query.from === 'string' ? req.query.from : undefined,
            toDate: typeof req.query.to === 'string' ? req.query.to : undefined,
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

  router.get(
    '/dated-sessions/:datedSessionId',
    requireAuth,
    requireActiveTenant,
    requireOperation('bookings.create'),
    async (req, res, next) => {
      try {
        const row = await getDatedSession(
          req.actor!.activeTenantId!,
          req.params.datedSessionId!,
          pool,
        );
        res.json({ data: row });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/dated-sessions',
    requireAuth,
    requireActiveTenant,
    requireOperation('sessions.define'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            session_definition_id: z.string().uuid(),
            session_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            capacity: z.number().int().positive().optional(),
          })
          .parse(req.body);
        const created = await materialiseDatedSession(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            sessionDefinitionId: body.session_definition_id,
            sessionDate: body.session_date,
            capacity: body.capacity,
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
