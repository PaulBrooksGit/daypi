import { Router } from 'express';
import { z } from 'zod';
import type { DbPool } from '../../../../platform/db/src/index.js';
import {
  createAuthMiddleware,
  requireActiveTenant,
  requireOperation,
} from '../../../../platform/auth/src/index.js';
import {
  getOrCreateAllergyProfile,
  setAllergyOverallStatus,
  addAllergy,
  listAllergies,
  addCondition,
  createCarePlan,
  addObservation,
} from '../../../../modules/health/src/index.js';

export function healthRecordsRoutes(pool: DbPool): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(pool);

  router.get(
    '/children/:childId/allergies',
    requireAuth,
    requireActiveTenant,
    requireOperation('health.read'),
    async (req, res, next) => {
      try {
        const data = await listAllergies(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            childId: req.params.childId!,
            roleTemplate: req.actor!.subject?.roleTemplate,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.json({ data });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/children/:childId/allergy-profile',
    requireAuth,
    requireActiveTenant,
    requireOperation('health.write'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            overall_status: z.enum([
              'unknown',
              'unconfirmed',
              'confirmed_present',
              'confirmed_none',
            ]),
            notes: z.string().max(5000).optional(),
          })
          .parse(req.body);
        const profile = await setAllergyOverallStatus(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            childId: req.params.childId!,
            overallStatus: body.overall_status,
            notes: body.notes,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.json({ data: profile });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/children/:childId/allergies',
    requireAuth,
    requireActiveTenant,
    requireOperation('health.write'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            allergen: z.string().min(1).max(200),
            confirmation_status: z
              .enum(['unknown', 'unconfirmed', 'confirmed_present'])
              .optional(),
            severity: z.enum(['mild', 'moderate', 'severe']).optional(),
            reaction_notes: z.string().max(5000).optional(),
          })
          .parse(req.body);
        // Ensure profile exists first with unknown default
        await getOrCreateAllergyProfile(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            childId: req.params.childId!,
            correlationId: req.correlationId,
          },
          pool,
        );
        const allergy = await addAllergy(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            childId: req.params.childId!,
            allergen: body.allergen,
            confirmationStatus: body.confirmation_status,
            severity: body.severity,
            reactionNotes: body.reaction_notes,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.status(201).json({ data: allergy });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/children/:childId/conditions',
    requireAuth,
    requireActiveTenant,
    requireOperation('health.write'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            name: z.string().min(1).max(200),
            confirmation_status: z
              .enum(['unknown', 'unconfirmed', 'confirmed_present', 'resolved'])
              .optional(),
            care_notes: z.string().max(5000).optional(),
          })
          .parse(req.body);
        const condition = await addCondition(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            childId: req.params.childId!,
            name: body.name,
            confirmationStatus: body.confirmation_status,
            careNotes: body.care_notes,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.status(201).json({ data: condition });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/children/:childId/care-plans',
    requireAuth,
    requireActiveTenant,
    requireOperation('health.write'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            title: z.string().min(1).max(300),
            body_markdown: z.string().max(100_000).optional(),
          })
          .parse(req.body);
        const plan = await createCarePlan(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            childId: req.params.childId!,
            title: body.title,
            bodyMarkdown: body.body_markdown,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.status(201).json({ data: plan });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/children/:childId/observations',
    requireAuth,
    requireActiveTenant,
    requireOperation('health.write'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            body_markdown: z.string().min(1).max(50_000),
            category: z.string().max(100).optional(),
            observed_at: z.string().datetime().optional(),
          })
          .parse(req.body);
        const observation = await addObservation(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            childId: req.params.childId!,
            bodyMarkdown: body.body_markdown,
            category: body.category,
            observedAt: body.observed_at,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.status(201).json({ data: observation });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
