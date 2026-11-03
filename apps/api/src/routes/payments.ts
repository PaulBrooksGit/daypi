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
  createSandboxPayment,
  getPayment,
} from '../../../../modules/finance/src/index.js';

export function paymentsRoutes(pool: DbPool, config: AppConfig): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(pool);

  router.post(
    '/payments',
    requireAuth,
    requireActiveTenant,
    requireOperation('payments.collect'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            invoice_id: z.string().uuid(),
            amount_minor: z.number().int().positive().optional(),
          })
          .parse(req.body);
        const idempotencyKey = req.header('idempotency-key');
        if (!idempotencyKey) {
          res.status(400).json({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Idempotency-Key header required for payments',
            },
          });
          return;
        }
        const created = await createSandboxPayment(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            invoiceId: body.invoice_id,
            amountMinor: body.amount_minor,
            idempotencyKey,
            stripeLiveEnabled: config.FEATURE_STRIPE_LIVE,
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
    '/payments/:paymentId',
    requireAuth,
    requireActiveTenant,
    requireOperation('invoices.read'),
    async (req, res, next) => {
      try {
        const payment = await getPayment(
          req.actor!.activeTenantId!,
          req.params.paymentId!,
          pool,
        );
        res.json({ data: payment });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
