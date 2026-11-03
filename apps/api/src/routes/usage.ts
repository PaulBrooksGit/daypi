import { Router } from 'express';
import { z } from 'zod';
import type { DbPool } from '../../../../platform/db/src/index.js';
import type { AppConfig } from '../../../../platform/config/src/index.js';
import {
  createAuthMiddleware,
  requireActiveTenant,
  requireOperation,
} from '../../../../platform/auth/src/index.js';
import {
  getUsageAccount,
  listUsageLedger,
  sandboxPurchaseCredit,
} from '../../../../modules/finance/src/index.js';
import { featureDisabled } from '../../../../platform/http/src/errors.js';

export function usageRoutes(pool: DbPool, config: AppConfig): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(pool);

  router.get(
    '/usage/account',
    requireAuth,
    requireActiveTenant,
    requireOperation('usage_ledger.read'),
    async (req, res, next) => {
      try {
        const account = await getUsageAccount(req.actor!.activeTenantId!, pool);
        res.json({ data: account });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/usage/ledger',
    requireAuth,
    requireActiveTenant,
    requireOperation('usage_ledger.read'),
    async (req, res, next) => {
      try {
        const rows = await listUsageLedger(
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
    '/usage/top-ups',
    requireAuth,
    requireActiveTenant,
    requireOperation('subscription.manage'),
    async (req, res, next) => {
      try {
        // Live commercial top-ups gated; sandbox purchase credit allowed for testing ledger.
        if (config.FEATURE_LIVE_BILLING) {
          throw featureDisabled('usage.top_ups_live');
        }
        if (config.FEATURE_PROMOTIONAL_GRANTS) {
          throw featureDisabled('usage.promotional_grants');
        }
        const body = z
          .object({
            amount_minor: z.number().int().positive(),
          })
          .parse(req.body);
        const idempotencyKey = req.header('idempotency-key');
        if (!idempotencyKey) {
          res.status(400).json({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Idempotency-Key header required',
            },
          });
          return;
        }
        const result = await sandboxPurchaseCredit(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            amountMinor: body.amount_minor,
            idempotencyKey,
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
