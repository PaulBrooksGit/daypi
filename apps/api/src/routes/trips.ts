import { Router } from 'express';
import { z } from 'zod';
import type { DbPool } from '../../../../platform/db/src/index.js';
import {
  createAuthMiddleware,
  requireActiveTenant,
  requireOperation,
} from '../../../../platform/auth/src/index.js';
import {
  createTrip,
  listTrips,
  getTrip,
  addTripParticipant,
  requestTripPermission,
  respondTripPermission,
  recordHeadcount,
  recordOnlineLocationSample,
  listTripLocationSamples,
  blockLiveTripLocation,
} from '../../../../modules/trips/src/index.js';

export function tripsRoutes(pool: DbPool): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(pool);

  router.get(
    '/trips',
    requireAuth,
    requireActiveTenant,
    requireOperation('trips.manage'),
    async (req, res, next) => {
      try {
        const rows = await listTrips(
          req.actor!.activeTenantId!,
          Number(req.query.limit ?? 50),
          pool,
        );
        res.json({ data: rows, next_cursor: null });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/trips',
    requireAuth,
    requireActiveTenant,
    requireOperation('trips.manage'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            title: z.string().min(1).max(300),
            starts_at: z.string().datetime(),
            ends_at: z.string().datetime().optional(),
            site_id: z.string().uuid().optional(),
            destination: z.string().max(500).optional(),
            description: z.string().max(5000).optional(),
            risk_summary: z.string().max(5000).optional(),
          })
          .parse(req.body);
        const trip = await createTrip(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            title: body.title,
            startsAt: body.starts_at,
            endsAt: body.ends_at,
            siteId: body.site_id,
            destination: body.destination,
            description: body.description,
            riskSummary: body.risk_summary,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.status(201).json({ data: trip });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/trips/:id',
    requireAuth,
    requireActiveTenant,
    requireOperation('trips.manage'),
    async (req, res, next) => {
      try {
        const trip = await getTrip(req.actor!.activeTenantId!, req.params.id!, pool);
        res.json({ data: trip });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/trips/:id/participants',
    requireAuth,
    requireActiveTenant,
    requireOperation('trips.manage'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            role: z.enum(['child', 'staff', 'volunteer']),
            child_id: z.string().uuid().optional(),
            staff_profile_id: z.string().uuid().optional(),
          })
          .parse(req.body);
        const participant = await addTripParticipant(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            tripId: req.params.id!,
            role: body.role,
            childId: body.child_id,
            staffProfileId: body.staff_profile_id,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.status(201).json({ data: participant });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/trips/:id/permissions',
    requireAuth,
    requireActiveTenant,
    requireOperation('trips.manage'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            child_id: z.string().uuid(),
            guardian_id: z.string().uuid(),
          })
          .parse(req.body);
        const permission = await requestTripPermission(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            tripId: req.params.id!,
            childId: body.child_id,
            guardianId: body.guardian_id,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.status(201).json({ data: permission });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/trip-permissions/:id/respond',
    requireAuth,
    requireActiveTenant,
    requireOperation('trips.permission.respond'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            status: z.enum(['granted', 'declined']),
            note: z.string().max(2000).optional(),
          })
          .parse(req.body);
        const permission = await respondTripPermission(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            permissionId: req.params.id!,
            status: body.status,
            note: body.note,
            roleTemplate: req.actor!.subject?.roleTemplate,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.json({ data: permission });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/trips/:id/headcounts',
    requireAuth,
    requireActiveTenant,
    requireOperation('trips.manage'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            expected_count: z.number().int().min(0),
            actual_count: z.number().int().min(0),
            notes: z.string().max(2000).optional(),
          })
          .parse(req.body);
        const headcount = await recordHeadcount(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            tripId: req.params.id!,
            expectedCount: body.expected_count,
            actualCount: body.actual_count,
            notes: body.notes,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.status(201).json({ data: headcount });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/trips/:id/location-samples',
    requireAuth,
    requireActiveTenant,
    requireOperation('trips.location.record'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            latitude: z.number(),
            longitude: z.number(),
            accuracy_metres: z.number().optional(),
            source: z.enum(['online_manual', 'online_foreground']).optional(),
          })
          .parse(req.body);
        const sample = await recordOnlineLocationSample(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            tripId: req.params.id!,
            latitude: body.latitude,
            longitude: body.longitude,
            accuracyMetres: body.accuracy_metres,
            source: body.source,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.status(201).json({ data: sample });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/trips/:id/location-samples',
    requireAuth,
    requireActiveTenant,
    requireOperation('trips.manage'),
    async (req, res, next) => {
      try {
        const rows = await listTripLocationSamples(
          req.actor!.activeTenantId!,
          req.params.id!,
          pool,
        );
        res.json({ data: rows });
      } catch (err) {
        next(err);
      }
    },
  );

  router.all(
    '/trips/:id/location/live',
    requireAuth,
    requireActiveTenant,
    async (_req, _res, next) => {
      try {
        blockLiveTripLocation();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
