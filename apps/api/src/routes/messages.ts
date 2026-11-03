import { Router } from 'express';
import { z } from 'zod';
import type { DbPool } from '../../../../platform/db/src/index.js';
import {
  createAuthMiddleware,
  requireActiveTenant,
  requireOperation,
} from '../../../../platform/auth/src/index.js';
import {
  createAndQueueMessage,
  getMessage,
  listMessages,
  processSandboxSend,
} from '../../../../modules/messaging/src/index.js';
import type { Operation } from '../../../../platform/authz/src/index.js';

export function messagesRoutes(pool: DbPool): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(pool);

  router.get(
    '/messages',
    requireAuth,
    requireActiveTenant,
    requireOperation('messages.transactional.send'),
    async (req, res, next) => {
      try {
        const rows = await listMessages(
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
    '/messages',
    requireAuth,
    requireActiveTenant,
    async (req, res, next) => {
      try {
        const body = z
          .object({
            channel: z.enum(['sms', 'email']),
            purpose: z.enum(['transactional', 'marketing']),
            body: z.string().min(1).max(5000),
            subject: z.string().max(200).optional(),
            guardian_ids: z.array(z.string().uuid()).min(1),
          })
          .parse(req.body);

        const operation: Operation =
          body.purpose === 'marketing'
            ? 'messages.marketing.send'
            : 'messages.transactional.send';
        const { assertOperation } = await import('../../../../platform/authz/src/index.js');
        const { withTenant } = await import('../../../../platform/db/src/index.js');
        const { forbidden } = await import('../../../../platform/http/src/errors.js');
        await withTenant(req.actor!.activeTenantId!, async (db) => {
          let subject = req.actor!.subject;
          if (!subject) {
            const mem = await db.query<{ id: string; role_template: string }>(
              `SELECT id, role_template FROM memberships
               WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`,
              [req.actor!.activeTenantId, req.actor!.userId],
            );
            const membership = mem.rows[0];
            if (!membership) throw forbidden('Not a member of this tenant');
            subject = {
              kind: 'membership',
              tenantId: req.actor!.activeTenantId!,
              membershipId: membership.id,
              roleTemplate: membership.role_template,
            };
            req.actor!.subject = subject;
          }
          await assertOperation(db, subject, operation);
        }, pool);

        const idempotencyKey = req.header('idempotency-key');
        if (!idempotencyKey) {
          res.status(400).json({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Idempotency-Key header required for messages',
            },
          });
          return;
        }

        const created = await createAndQueueMessage(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            channel: body.channel,
            purpose: body.purpose,
            body: body.body,
            subject: body.subject,
            guardianIds: body.guardian_ids,
            idempotencyKey,
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
    '/messages/:messageId',
    requireAuth,
    requireActiveTenant,
    requireOperation('messages.transactional.send'),
    async (req, res, next) => {
      try {
        const data = await getMessage(
          req.actor!.activeTenantId!,
          req.params.messageId!,
          pool,
        );
        res.json({ data });
      } catch (err) {
        next(err);
      }
    },
  );

  /** Dev/sandbox helper to process queued send without waiting for worker. */
  router.post(
    '/messages/:messageId/sandbox-send',
    requireAuth,
    requireActiveTenant,
    requireOperation('messages.transactional.send'),
    async (req, res, next) => {
      try {
        const sent = await processSandboxSend(
          {
            tenantId: req.actor!.activeTenantId!,
            messageId: req.params.messageId!,
          },
          pool,
        );
        res.json({ data: sent });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
