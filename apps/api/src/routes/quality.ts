import { Router } from 'express';
import { z } from 'zod';
import type { DbPool } from '../../../../platform/db/src/index.js';
import {
  createAuthMiddleware,
  requireActiveTenant,
  requireOperation,
} from '../../../../platform/auth/src/index.js';
import {
  createAuditTemplate,
  startAuditRun,
  completeAuditRun,
  addAuditAction,
  submitTestimonial,
  moderateTestimonial,
  listTestimonials,
} from '../../../../modules/quality/src/index.js';

export function qualityRoutes(pool: DbPool): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(pool);

  router.post(
    '/quality/templates',
    requireAuth,
    requireActiveTenant,
    requireOperation('quality.manage'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            name: z.string().min(1).max(200),
            description: z.string().max(2000).optional(),
            criteria: z.array(z.record(z.unknown())).optional(),
            scoring_notes: z.string().max(5000).optional(),
          })
          .parse(req.body);
        const created = await createAuditTemplate(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            name: body.name,
            description: body.description,
            criteria: body.criteria,
            scoringNotes: body.scoring_notes,
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
    '/quality/audits',
    requireAuth,
    requireActiveTenant,
    requireOperation('quality.manage'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            template_id: z.string().uuid(),
            title: z.string().min(1).max(300),
          })
          .parse(req.body);
        const run = await startAuditRun(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            templateId: body.template_id,
            title: body.title,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.status(201).json({ data: run });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/quality/audits/:id/complete',
    requireAuth,
    requireActiveTenant,
    requireOperation('quality.manage'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            internal_score: z.number().optional(),
            score_label: z.string().max(100).optional(),
            notes: z.string().max(5000).optional(),
          })
          .parse(req.body ?? {});
        const run = await completeAuditRun(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            runId: req.params.id!,
            internalScore: body.internal_score,
            scoreLabel: body.score_label,
            notes: body.notes,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.json({ data: run });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/quality/audits/:id/actions',
    requireAuth,
    requireActiveTenant,
    requireOperation('quality.manage'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            title: z.string().min(1).max(300),
            detail: z.string().max(5000).optional(),
            due_on: z.string().optional(),
          })
          .parse(req.body);
        const action = await addAuditAction(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            runId: req.params.id!,
            title: body.title,
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

  router.get(
    '/testimonials',
    requireAuth,
    requireActiveTenant,
    requireOperation('testimonials.read'),
    async (req, res, next) => {
      try {
        const rows = await listTestimonials(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            roleTemplate: req.actor!.subject?.roleTemplate,
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
    '/testimonials',
    requireAuth,
    requireActiveTenant,
    requireOperation('testimonials.submit'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            author_display_name: z.string().min(1).max(200),
            body: z.string().min(1).max(5000),
            guardian_id: z.string().uuid().optional(),
          })
          .parse(req.body);
        const row = await submitTestimonial(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            authorDisplayName: body.author_display_name,
            body: body.body,
            guardianId: body.guardian_id,
            roleTemplate: req.actor!.subject?.roleTemplate,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.status(201).json({ data: row });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/testimonials/:id/moderate',
    requireAuth,
    requireActiveTenant,
    requireOperation('testimonials.moderate'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            moderation_status: z.enum(['approved', 'rejected', 'withdrawn']),
            visibility: z.enum(['private', 'staff', 'public']).optional(),
            note: z.string().max(2000).optional(),
          })
          .parse(req.body);
        const row = await moderateTestimonial(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            testimonialId: req.params.id!,
            moderationStatus: body.moderation_status,
            visibility: body.visibility,
            note: body.note,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.json({ data: row });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
