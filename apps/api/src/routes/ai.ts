import { Router } from 'express';
import { z } from 'zod';
import type { DbPool } from '../../../../platform/db/src/index.js';
import {
  createAuthMiddleware,
  requireActiveTenant,
  requireOperation,
} from '../../../../platform/auth/src/index.js';
import {
  createAiDraft,
  editAiDraft,
  approveAiDraftUnpublished,
  rejectAiDraft,
  getAiDraft,
  listAiDrafts,
  createAiProposal,
  approveAiProposalDraftOnly,
  rejectAiProposal,
  getAiProposal,
  blockConsequentialAiExecution,
} from '../../../../modules/ai/src/index.js';

export function aiRoutes(pool: DbPool): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(pool);

  router.get(
    '/ai/drafts',
    requireAuth,
    requireActiveTenant,
    requireOperation('ai.propose'),
    async (req, res, next) => {
      try {
        const rows = await listAiDrafts(
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
    '/ai/drafts',
    requireAuth,
    requireActiveTenant,
    requireOperation('ai.execute_draft'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            draft_type: z.enum([
              'activity_plan',
              'label',
              'template',
              'reward_sheet',
              'website_page',
            ]),
            title: z.string().min(1).max(300),
            brief: z.string().max(5000).optional(),
          })
          .parse(req.body);
        const draft = await createAiDraft(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            draftType: body.draft_type,
            title: body.title,
            brief: body.brief,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.status(201).json({ data: draft });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/ai/drafts/:id',
    requireAuth,
    requireActiveTenant,
    requireOperation('ai.propose'),
    async (req, res, next) => {
      try {
        const draft = await getAiDraft(req.actor!.activeTenantId!, req.params.id!, pool);
        res.json({ data: draft });
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    '/ai/drafts/:id',
    requireAuth,
    requireActiveTenant,
    requireOperation('ai.execute_draft'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            title: z.string().min(1).max(300).optional(),
            body_markdown: z.string().max(200_000).optional(),
          })
          .parse(req.body);
        const draft = await editAiDraft(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            draftId: req.params.id!,
            title: body.title,
            bodyMarkdown: body.body_markdown,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.json({ data: draft });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/ai/drafts/:id/approve',
    requireAuth,
    requireActiveTenant,
    requireOperation('ai.execute_draft'),
    async (req, res, next) => {
      try {
        const draft = await approveAiDraftUnpublished(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            draftId: req.params.id!,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.json({ data: draft });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/ai/drafts/:id/reject',
    requireAuth,
    requireActiveTenant,
    requireOperation('ai.execute_draft'),
    async (req, res, next) => {
      try {
        const body = z.object({ reason: z.string().max(2000).optional() }).parse(req.body ?? {});
        const draft = await rejectAiDraft(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            draftId: req.params.id!,
            reason: body.reason,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.json({ data: draft });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/ai/orchestrator',
    requireAuth,
    requireActiveTenant,
    requireOperation('ai.propose'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            action_type: z.enum([
              'create_unpublished_draft',
              'update_draft_content',
              'publish_content',
              'financial_adjustment',
              'booking_change',
              'health_record_change',
              'broadcast_message',
            ]),
            draft_id: z.string().uuid().optional(),
            payload: z.record(z.unknown()).optional(),
          })
          .parse(req.body);
        const proposal = await createAiProposal(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            actionType: body.action_type,
            draftId: body.draft_id,
            payload: body.payload,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.status(201).json({ data: proposal });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/ai/proposals/:id',
    requireAuth,
    requireActiveTenant,
    requireOperation('ai.propose'),
    async (req, res, next) => {
      try {
        const proposal = await getAiProposal(req.actor!.activeTenantId!, req.params.id!, pool);
        res.json({ data: proposal });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/ai/proposals/:id/approve',
    requireAuth,
    requireActiveTenant,
    requireOperation('ai.execute_draft'),
    async (req, res, next) => {
      try {
        const body = z.object({ note: z.string().max(2000).optional() }).parse(req.body ?? {});
        const proposal = await approveAiProposalDraftOnly(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            proposalId: req.params.id!,
            note: body.note,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.json({ data: proposal });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/ai/proposals/:id/reject',
    requireAuth,
    requireActiveTenant,
    requireOperation('ai.propose'),
    async (req, res, next) => {
      try {
        const body = z.object({ note: z.string().max(2000).optional() }).parse(req.body ?? {});
        const proposal = await rejectAiProposal(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            proposalId: req.params.id!,
            note: body.note,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.json({ data: proposal });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/ai/proposals/:id/execute',
    requireAuth,
    requireActiveTenant,
    async (_req, _res, next) => {
      try {
        blockConsequentialAiExecution();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
