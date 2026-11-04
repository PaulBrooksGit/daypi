import { Router } from 'express';
import { z } from 'zod';
import type { DbPool } from '../../../../platform/db/src/index.js';
import {
  createAuthMiddleware,
  requireActiveTenant,
  requireOperation,
} from '../../../../platform/auth/src/index.js';
import {
  createAsset,
  listAssets,
  createInspectionSchedule,
  recordInspection,
  createMaintenanceAction,
} from '../../../../modules/facilities/src/index.js';

export function facilitiesRoutes(pool: DbPool): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(pool);

  router.get(
    '/facilities/assets',
    requireAuth,
    requireActiveTenant,
    requireOperation('facilities.read'),
    async (req, res, next) => {
      try {
        const rows = await listAssets(
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
    '/facilities/assets',
    requireAuth,
    requireActiveTenant,
    requireOperation('facilities.manage'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            name: z.string().min(1).max(200),
            category: z.enum(['premises', 'equipment', 'vehicle', 'outdoor', 'other']).optional(),
            site_id: z.string().uuid().optional(),
            location_label: z.string().max(300).optional(),
            serial_number: z.string().max(100).optional(),
            notes: z.string().max(5000).optional(),
          })
          .parse(req.body);
        const asset = await createAsset(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            name: body.name,
            category: body.category,
            siteId: body.site_id,
            locationLabel: body.location_label,
            serialNumber: body.serial_number,
            notes: body.notes,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.status(201).json({ data: asset });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/facilities/assets/:id/schedules',
    requireAuth,
    requireActiveTenant,
    requireOperation('facilities.manage'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            title: z.string().min(1).max(300),
            cadence_days: z.number().int().min(1),
            next_due_on: z.string(),
          })
          .parse(req.body);
        const schedule = await createInspectionSchedule(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            assetId: req.params.id!,
            title: body.title,
            cadenceDays: body.cadence_days,
            nextDueOn: body.next_due_on,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.status(201).json({ data: schedule });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/facilities/assets/:id/inspections',
    requireAuth,
    requireActiveTenant,
    requireOperation('facilities.manage'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            outcome: z.enum(['pass', 'pass_with_notes', 'fail']),
            schedule_id: z.string().uuid().optional(),
            notes: z.string().max(5000).optional(),
            evidence_object_id: z.string().uuid().optional(),
            findings: z
              .array(
                z.object({
                  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
                  description: z.string().min(1).max(2000),
                }),
              )
              .optional(),
          })
          .parse(req.body);
        const result = await recordInspection(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            assetId: req.params.id!,
            outcome: body.outcome,
            scheduleId: body.schedule_id,
            notes: body.notes,
            evidenceObjectId: body.evidence_object_id,
            findings: body.findings,
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

  router.post(
    '/facilities/assets/:id/maintenance-actions',
    requireAuth,
    requireActiveTenant,
    requireOperation('facilities.manage'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            title: z.string().min(1).max(300),
            finding_id: z.string().uuid().optional(),
            detail: z.string().max(5000).optional(),
            due_on: z.string().optional(),
          })
          .parse(req.body);
        const action = await createMaintenanceAction(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            assetId: req.params.id!,
            title: body.title,
            findingId: body.finding_id,
            detail: body.detail,
            dueOn: body.due_on,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.status(201).json({ data: action });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
