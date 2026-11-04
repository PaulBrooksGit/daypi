import type { DbPool } from '../../../platform/db/src/pool.js';
import { withTenant } from '../../../platform/db/src/index.js';
import { writeAudit } from '../../../platform/audit/src/index.js';
import {
  featureDisabled,
  notFound,
  validationError,
  conflict,
} from '../../../platform/http/src/errors.js';

const DRAFT_TYPES = [
  'activity_plan',
  'label',
  'template',
  'reward_sheet',
  'website_page',
] as const;

const CONSEQUENTIAL_ACTIONS = new Set([
  'publish_content',
  'financial_adjustment',
  'booking_change',
  'health_record_change',
  'broadcast_message',
]);

export interface AiDraftRow {
  id: string;
  tenant_id: string;
  draft_type: string;
  title: string;
  body_markdown: string;
  status: string;
  provider: string;
  model_version: string;
  prompt_version: string;
  provenance: Record<string, unknown>;
  source_refs: unknown;
  edited_body_markdown: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AiProposalRow {
  id: string;
  tenant_id: string;
  draft_id: string | null;
  action_type: string;
  is_consequential: boolean;
  status: string;
  proposed_payload: Record<string, unknown>;
  created_at: Date;
}

function syntheticBody(draftType: string, title: string): string {
  return [
    `# ${title}`,
    '',
    `_Synthetic DayMake draft (${draftType}). Review and edit before any publish or distribution._`,
    '',
    '## Outline',
    '1. Introduction',
    '2. Main activity',
    '3. Closing reflection',
    '',
    'Framework references must be versioned; this draft does not claim inspection compliance.',
  ].join('\n');
}

/** Create a constrained unpublished AI draft (automatic draft path — Brief §12). */
export async function createAiDraft(
  input: {
    tenantId: string;
    actorUserId: string;
    draftType: (typeof DRAFT_TYPES)[number];
    title: string;
    brief?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<AiDraftRow> {
  return withTenant(input.tenantId, async (db) => {
    if (!DRAFT_TYPES.includes(input.draftType)) {
      throw validationError('Unsupported draft type');
    }
    if (!input.title.trim()) throw validationError('title required');

    const body = syntheticBody(input.draftType, input.title.trim());
    const provenance = {
      generator: 'synthetic',
      brief: input.brief ?? null,
      generated_at: new Date().toISOString(),
      note: 'No live model call; consequential apply disabled (D07)',
    };

    const row = await db.query<AiDraftRow>(
      `INSERT INTO ai_drafts (
         tenant_id, draft_type, title, body_markdown, status,
         provider, model_version, prompt_version, provenance, created_by_user_id
       ) VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8::jsonb,$9)
       RETURNING id, tenant_id, draft_type, title, body_markdown, status,
                 provider, model_version, prompt_version, provenance, source_refs,
                 edited_body_markdown, created_at, updated_at`,
      [
        input.tenantId,
        input.draftType,
        input.title.trim(),
        body,
        'synthetic',
        'daypi-synthetic-v1',
        'daymake-v1',
        JSON.stringify(provenance),
        input.actorUserId,
      ],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'ai.draft.create',
      entityType: 'ai_draft',
      entityId: row.rows[0]!.id,
      correlationId: input.correlationId,
      metadata: { draft_type: input.draftType },
    });

    return row.rows[0]!;
  }, pool);
}

export async function editAiDraft(
  input: {
    tenantId: string;
    actorUserId: string;
    draftId: string;
    title?: string;
    bodyMarkdown?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<AiDraftRow> {
  return withTenant(input.tenantId, async (db) => {
    const existing = await db.query(`SELECT id, status FROM ai_drafts WHERE id = $1 FOR UPDATE`, [
      input.draftId,
    ]);
    if (existing.rowCount === 0) throw notFound('AI draft not found');
    if (existing.rows[0]!.status === 'archived' || existing.rows[0]!.status === 'rejected') {
      throw conflict('Cannot edit archived or rejected draft');
    }

    const row = await db.query<AiDraftRow>(
      `UPDATE ai_drafts
       SET title = COALESCE($2, title),
           body_markdown = COALESCE($3, body_markdown),
           edited_body_markdown = COALESCE($3, edited_body_markdown),
           status = 'ready_for_review',
           updated_at = now()
       WHERE id = $1
       RETURNING id, tenant_id, draft_type, title, body_markdown, status,
                 provider, model_version, prompt_version, provenance, source_refs,
                 edited_body_markdown, created_at, updated_at`,
      [input.draftId, input.title?.trim() ?? null, input.bodyMarkdown ?? null],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'ai.draft.edit',
      entityType: 'ai_draft',
      entityId: input.draftId,
      correlationId: input.correlationId,
    });

    return row.rows[0]!;
  }, pool);
}

export async function approveAiDraftUnpublished(
  input: {
    tenantId: string;
    actorUserId: string;
    draftId: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<AiDraftRow> {
  return withTenant(input.tenantId, async (db) => {
    const existing = await db.query(`SELECT id, status FROM ai_drafts WHERE id = $1 FOR UPDATE`, [
      input.draftId,
    ]);
    if (existing.rowCount === 0) throw notFound('AI draft not found');

    const row = await db.query<AiDraftRow>(
      `UPDATE ai_drafts
       SET status = 'approved_unpublished',
           reviewed_by_user_id = $2,
           reviewed_at = now(),
           updated_at = now()
       WHERE id = $1
       RETURNING id, tenant_id, draft_type, title, body_markdown, status,
                 provider, model_version, prompt_version, provenance, source_refs,
                 edited_body_markdown, created_at, updated_at`,
      [input.draftId, input.actorUserId],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'ai.draft.approve_unpublished',
      entityType: 'ai_draft',
      entityId: input.draftId,
      correlationId: input.correlationId,
    });

    return row.rows[0]!;
  }, pool);
}

export async function rejectAiDraft(
  input: {
    tenantId: string;
    actorUserId: string;
    draftId: string;
    reason?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<AiDraftRow> {
  return withTenant(input.tenantId, async (db) => {
    const existing = await db.query(`SELECT id FROM ai_drafts WHERE id = $1 FOR UPDATE`, [
      input.draftId,
    ]);
    if (existing.rowCount === 0) throw notFound('AI draft not found');

    const row = await db.query<AiDraftRow>(
      `UPDATE ai_drafts
       SET status = 'rejected',
           rejection_reason = $3,
           reviewed_by_user_id = $2,
           reviewed_at = now(),
           updated_at = now()
       WHERE id = $1
       RETURNING id, tenant_id, draft_type, title, body_markdown, status,
                 provider, model_version, prompt_version, provenance, source_refs,
                 edited_body_markdown, created_at, updated_at`,
      [input.draftId, input.actorUserId, input.reason ?? null],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'ai.draft.reject',
      entityType: 'ai_draft',
      entityId: input.draftId,
      correlationId: input.correlationId,
    });

    return row.rows[0]!;
  }, pool);
}

export async function getAiDraft(
  tenantId: string,
  draftId: string,
  pool: DbPool,
): Promise<AiDraftRow> {
  return withTenant(tenantId, async (db) => {
    const row = await db.query<AiDraftRow>(
      `SELECT id, tenant_id, draft_type, title, body_markdown, status,
              provider, model_version, prompt_version, provenance, source_refs,
              edited_body_markdown, created_at, updated_at
       FROM ai_drafts WHERE id = $1`,
      [draftId],
    );
    if (row.rowCount === 0) throw notFound('AI draft not found');
    return row.rows[0]!;
  }, pool);
}

export async function listAiDrafts(
  tenantId: string,
  limit: number,
  pool: DbPool,
): Promise<AiDraftRow[]> {
  return withTenant(tenantId, async (db) => {
    const result = await db.query<AiDraftRow>(
      `SELECT id, tenant_id, draft_type, title, body_markdown, status,
              provider, model_version, prompt_version, provenance, source_refs,
              edited_body_markdown, created_at, updated_at
       FROM ai_drafts
       ORDER BY created_at DESC
       LIMIT $1`,
      [Math.min(Math.max(limit, 1), 100)],
    );
    return result.rows;
  }, pool);
}

/**
 * Orchestrator: returns a typed proposal. Consequential action types are recorded
 * as execution_blocked — never auto-applied (D07).
 */
export async function createAiProposal(
  input: {
    tenantId: string;
    actorUserId: string;
    actionType: string;
    draftId?: string;
    payload?: Record<string, unknown>;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<AiProposalRow> {
  return withTenant(input.tenantId, async (db) => {
    const isConsequential = CONSEQUENTIAL_ACTIONS.has(input.actionType);
    let status = 'proposed';
    if (isConsequential) {
      status = 'execution_blocked';
    }

    if (input.draftId) {
      const draft = await db.query(`SELECT id FROM ai_drafts WHERE id = $1`, [input.draftId]);
      if (draft.rowCount === 0) throw notFound('AI draft not found');
    }

    const row = await db.query<AiProposalRow>(
      `INSERT INTO ai_proposals (
         tenant_id, draft_id, action_type, is_consequential, status,
         proposed_payload, created_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
       RETURNING id, tenant_id, draft_id, action_type, is_consequential, status,
                 proposed_payload, created_at`,
      [
        input.tenantId,
        input.draftId ?? null,
        input.actionType,
        isConsequential,
        status,
        JSON.stringify(input.payload ?? {}),
        input.actorUserId,
      ],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'ai.propose',
      entityType: 'ai_proposal',
      entityId: row.rows[0]!.id,
      correlationId: input.correlationId,
      metadata: {
        action_type: input.actionType,
        is_consequential: isConsequential,
        status,
      },
    });

    return row.rows[0]!;
  }, pool);
}

export async function approveAiProposalDraftOnly(
  input: {
    tenantId: string;
    actorUserId: string;
    proposalId: string;
    note?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<AiProposalRow> {
  return withTenant(input.tenantId, async (db) => {
    const existing = await db.query<{
      id: string;
      is_consequential: boolean;
      status: string;
      action_type: string;
    }>(`SELECT id, is_consequential, status, action_type FROM ai_proposals WHERE id = $1 FOR UPDATE`, [
      input.proposalId,
    ]);
    if (existing.rowCount === 0) throw notFound('AI proposal not found');
    if (existing.rows[0]!.is_consequential) {
      throw featureDisabled('ai.execute_consequential');
    }
    if (existing.rows[0]!.status === 'execution_blocked') {
      throw featureDisabled('ai.execute_consequential');
    }

    const row = await db.query<AiProposalRow>(
      `UPDATE ai_proposals
       SET status = 'approved_draft_only',
           decided_by_user_id = $2,
           decided_at = now(),
           decision_note = $3,
           updated_at = now()
       WHERE id = $1
       RETURNING id, tenant_id, draft_id, action_type, is_consequential, status,
                 proposed_payload, created_at`,
      [input.proposalId, input.actorUserId, input.note ?? null],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'ai.proposal.approve_draft_only',
      entityType: 'ai_proposal',
      entityId: input.proposalId,
      correlationId: input.correlationId,
    });

    return row.rows[0]!;
  }, pool);
}

export async function rejectAiProposal(
  input: {
    tenantId: string;
    actorUserId: string;
    proposalId: string;
    note?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<AiProposalRow> {
  return withTenant(input.tenantId, async (db) => {
    const existing = await db.query(`SELECT id FROM ai_proposals WHERE id = $1 FOR UPDATE`, [
      input.proposalId,
    ]);
    if (existing.rowCount === 0) throw notFound('AI proposal not found');

    const row = await db.query<AiProposalRow>(
      `UPDATE ai_proposals
       SET status = 'rejected',
           decided_by_user_id = $2,
           decided_at = now(),
           decision_note = $3,
           updated_at = now()
       WHERE id = $1
       RETURNING id, tenant_id, draft_id, action_type, is_consequential, status,
                 proposed_payload, created_at`,
      [input.proposalId, input.actorUserId, input.note ?? null],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'ai.proposal.reject',
      entityType: 'ai_proposal',
      entityId: input.proposalId,
      correlationId: input.correlationId,
    });

    return row.rows[0]!;
  }, pool);
}

export async function getAiProposal(
  tenantId: string,
  proposalId: string,
  pool: DbPool,
): Promise<AiProposalRow> {
  return withTenant(tenantId, async (db) => {
    const row = await db.query<AiProposalRow>(
      `SELECT id, tenant_id, draft_id, action_type, is_consequential, status,
              proposed_payload, created_at
       FROM ai_proposals WHERE id = $1`,
      [proposalId],
    );
    if (row.rowCount === 0) throw notFound('AI proposal not found');
    return row.rows[0]!;
  }, pool);
}

/** Hard gate — never executes consequential AI actions. */
export function blockConsequentialAiExecution(): never {
  throw featureDisabled('ai.execute_consequential');
}
