import { Router } from 'express';
import { z } from 'zod';
import type { DbPool } from '../../../../platform/db/src/index.js';
import {
  createAuthMiddleware,
  requireActiveTenant,
  requireOperation,
} from '../../../../platform/auth/src/index.js';
import {
  listWebsiteTemplates,
  createWebsiteSite,
  listWebsiteSites,
  createWebsitePage,
  updateWebsitePageDraft,
  publishWebsitePage,
  publishWebsiteSite,
  requestCustomDomainVerification,
  completeCustomDomainVerificationStub,
  getWebsitePage,
} from '../../../../modules/websites/src/index.js';

export function websitesRoutes(pool: DbPool): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(pool);

  router.get('/website-templates', requireAuth, requireActiveTenant, async (_req, res, next) => {
    try {
      const rows = await listWebsiteTemplates(pool);
      res.json({ data: rows });
    } catch (err) {
      next(err);
    }
  });

  router.get(
    '/websites',
    requireAuth,
    requireActiveTenant,
    requireOperation('websites.read'),
    async (req, res, next) => {
      try {
        const rows = await listWebsiteSites(
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
    '/websites',
    requireAuth,
    requireActiveTenant,
    requireOperation('websites.manage'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            name: z.string().min(1).max(200),
            template_id: z.string().uuid(),
            site_id: z.string().uuid().optional(),
          })
          .parse(req.body);
        const created = await createWebsiteSite(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            name: body.name,
            templateId: body.template_id,
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

  router.post(
    '/websites/:id/publish',
    requireAuth,
    requireActiveTenant,
    requireOperation('websites.publish'),
    async (req, res, next) => {
      try {
        const published = await publishWebsiteSite(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            websiteSiteId: req.params.id!,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.json({ data: published });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/websites/:id/pages',
    requireAuth,
    requireActiveTenant,
    requireOperation('websites.manage'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            slug: z.string().min(1).max(100),
            title: z.string().min(1).max(300),
            body_markdown: z.string().max(200_000).optional(),
          })
          .parse(req.body);
        const page = await createWebsitePage(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            websiteSiteId: req.params.id!,
            slug: body.slug,
            title: body.title,
            bodyMarkdown: body.body_markdown,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.status(201).json({ data: page });
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    '/website-pages/:id',
    requireAuth,
    requireActiveTenant,
    requireOperation('websites.manage'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            title: z.string().min(1).max(300).optional(),
            body_markdown: z.string().max(200_000).optional(),
          })
          .parse(req.body);
        const page = await updateWebsitePageDraft(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            pageId: req.params.id!,
            title: body.title,
            bodyMarkdown: body.body_markdown,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.json({ data: page });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/website-pages/:id/publish',
    requireAuth,
    requireActiveTenant,
    requireOperation('websites.publish'),
    async (req, res, next) => {
      try {
        const page = await publishWebsitePage(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            pageId: req.params.id!,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.json({ data: page });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/website-pages/:id',
    requireAuth,
    requireActiveTenant,
    requireOperation('websites.read'),
    async (req, res, next) => {
      try {
        const page = await getWebsitePage(req.actor!.activeTenantId!, req.params.id!, pool);
        res.json({ data: page });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/websites/:id/domains',
    requireAuth,
    requireActiveTenant,
    requireOperation('domain.verify'),
    async (req, res, next) => {
      try {
        const body = z.object({ hostname: z.string().min(1).max(253) }).parse(req.body);
        const verification = await requestCustomDomainVerification(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            websiteSiteId: req.params.id!,
            hostname: body.hostname,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.status(201).json({ data: verification });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/website-domain-verifications/:id/complete-stub',
    requireAuth,
    requireActiveTenant,
    requireOperation('domain.verify'),
    async (req, res, next) => {
      try {
        const result = await completeCustomDomainVerificationStub(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            verificationId: req.params.id!,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.json({ data: result });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
