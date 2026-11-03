import { Router } from 'express';
import { z } from 'zod';
import type { DbPool } from '../../../../platform/db/src/index.js';
import {
  createAuthMiddleware,
  requireActiveTenant,
  requireOperation,
} from '../../../../platform/auth/src/index.js';
import {
  createBillingAccount,
  draftInvoice,
  issueInvoice,
  getInvoice,
  creditInvoice,
  reconcileBillingAccount,
} from '../../../../modules/finance/src/index.js';

export function invoicesRoutes(pool: DbPool): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(pool);

  router.post(
    '/billing-accounts',
    requireAuth,
    requireActiveTenant,
    requireOperation('invoices.draft'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            display_name: z.string().min(1).max(200),
            guardian_id: z.string().uuid().optional(),
            child_id: z.string().uuid().optional(),
            currency: z.string().length(3).optional(),
          })
          .parse(req.body);
        const created = await createBillingAccount(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            displayName: body.display_name,
            guardianId: body.guardian_id,
            childId: body.child_id,
            currency: body.currency,
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
    '/billing-accounts/:billingAccountId/reconciliation',
    requireAuth,
    requireActiveTenant,
    requireOperation('invoices.read'),
    async (req, res, next) => {
      try {
        const data = await reconcileBillingAccount(
          req.actor!.activeTenantId!,
          req.params.billingAccountId!,
          pool,
        );
        res.json({ data });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/invoices',
    requireAuth,
    requireActiveTenant,
    requireOperation('invoices.draft'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            billing_account_id: z.string().uuid(),
            tax_minor: z.number().int().min(0).optional(),
            due_at: z.string().datetime().optional(),
            lines: z
              .array(
                z.object({
                  description: z.string().min(1),
                  quantity: z.number().int().positive().optional(),
                  unit_amount_minor: z.number().int(),
                  child_id: z.string().uuid().optional(),
                }),
              )
              .min(1),
          })
          .parse(req.body);
        const idempotencyKey = req.header('idempotency-key') ?? undefined;
        const created = await draftInvoice(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            billingAccountId: body.billing_account_id,
            taxMinor: body.tax_minor,
            dueAt: body.due_at,
            idempotencyKey,
            lines: body.lines.map((l) => ({
              description: l.description,
              quantity: l.quantity,
              unitAmountMinor: l.unit_amount_minor,
              childId: l.child_id,
            })),
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
    '/invoices/:invoiceId/issue',
    requireAuth,
    requireActiveTenant,
    requireOperation('invoices.issue'),
    async (req, res, next) => {
      try {
        const issued = await issueInvoice(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            invoiceId: req.params.invoiceId!,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.json({ data: issued });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/invoices/:invoiceId',
    requireAuth,
    requireActiveTenant,
    requireOperation('invoices.read'),
    async (req, res, next) => {
      try {
        const data = await getInvoice(
          req.actor!.activeTenantId!,
          req.params.invoiceId!,
          pool,
        );
        res.json({ data });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/invoices/:invoiceId/credits',
    requireAuth,
    requireActiveTenant,
    requireOperation('invoices.issue'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            amount_minor: z.number().int().positive(),
            reason: z.string().min(1).max(500),
          })
          .parse(req.body);
        const credited = await creditInvoice(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            invoiceId: req.params.invoiceId!,
            amountMinor: body.amount_minor,
            reason: body.reason,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.status(201).json({ data: credited });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
