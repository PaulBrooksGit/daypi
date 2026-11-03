import { Router } from 'express';
import { z } from 'zod';
import type { DbPool } from '../../../../platform/db/src/index.js';
import {
  createAuthMiddleware,
  requireActiveTenant,
  requireOperation,
} from '../../../../platform/auth/src/index.js';
import {
  exportChildrenBundle,
  importChildrenBundle,
} from '../../../../modules/core/src/index.js';

export function importExportRoutes(pool: DbPool): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(pool);

  router.get(
    '/export/children',
    requireAuth,
    requireActiveTenant,
    requireOperation('export.tenant'),
    async (req, res, next) => {
      try {
        const bundle = await exportChildrenBundle(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.json({ data: bundle });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/import/children',
    requireAuth,
    requireActiveTenant,
    requireOperation('children.create'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            dry_run: z.boolean().optional(),
            children: z.array(z.record(z.unknown())).optional(),
          })
          .passthrough()
          .parse(req.body);

        const result = await importChildrenBundle(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            payload: body,
            dryRun: body.dry_run === true,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.status(body.dry_run ? 200 : 201).json({ data: result });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
