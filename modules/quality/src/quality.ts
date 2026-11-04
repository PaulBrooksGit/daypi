import type { DbPool } from '../../../platform/db/src/pool.js';
import { withTenant } from '../../../platform/db/src/index.js';
import { writeAudit } from '../../../platform/audit/src/index.js';
import { forbidden, notFound, validationError, conflict } from '../../../platform/http/src/errors.js';

export interface QualityTemplateRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  current_version_id: string | null;
  status: string;
  created_at: Date;
}

export interface QualityTemplateVersionRow {
  id: string;
  tenant_id: string;
  template_id: string;
  version_number: number;
  criteria: unknown;
  scoring_notes: string;
  created_at: Date;
}

export interface QualityAuditRunRow {
  id: string;
  tenant_id: string;
  template_id: string;
  template_version_id: string;
  title: string;
  status: string;
  internal_score: string | null;
  score_label: string | null;
  compliance_claim: string;
  created_at: Date;
}

export interface QualityTestimonialRow {
  id: string;
  tenant_id: string;
  author_display_name: string;
  body: string;
  guardian_id: string | null;
  visibility: string;
  moderation_status: string;
  created_at: Date;
}

export async function createAuditTemplate(
  input: {
    tenantId: string;
    actorUserId: string;
    name: string;
    description?: string;
    criteria?: unknown[];
    scoringNotes?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<{ template: QualityTemplateRow; version: QualityTemplateVersionRow }> {
  return withTenant(input.tenantId, async (db) => {
    if (!input.name.trim()) throw validationError('name required');

    const template = await db.query<QualityTemplateRow>(
      `INSERT INTO quality_audit_templates (
         tenant_id, name, description, status, created_by_user_id
       ) VALUES ($1,$2,$3,'active',$4)
       RETURNING id, tenant_id, name, description, current_version_id, status, created_at`,
      [input.tenantId, input.name.trim(), input.description ?? '', input.actorUserId],
    );

    const version = await db.query<QualityTemplateVersionRow>(
      `INSERT INTO quality_audit_template_versions (
         tenant_id, template_id, version_number, criteria, scoring_notes, created_by_user_id
       ) VALUES ($1,$2,1,$3::jsonb,$4,$5)
       RETURNING id, tenant_id, template_id, version_number, criteria, scoring_notes, created_at`,
      [
        input.tenantId,
        template.rows[0]!.id,
        JSON.stringify(input.criteria ?? [{ id: 'general', label: 'General quality' }]),
        input.scoringNotes ?? 'Internal score only — not official inspection compliance',
        input.actorUserId,
      ],
    );

    const updated = await db.query<QualityTemplateRow>(
      `UPDATE quality_audit_templates
       SET current_version_id = $2, updated_at = now()
       WHERE id = $1
       RETURNING id, tenant_id, name, description, current_version_id, status, created_at`,
      [template.rows[0]!.id, version.rows[0]!.id],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'quality.template.create',
      entityType: 'quality_audit_template',
      entityId: updated.rows[0]!.id,
      correlationId: input.correlationId,
    });

    return { template: updated.rows[0]!, version: version.rows[0]! };
  }, pool);
}

export async function startAuditRun(
  input: {
    tenantId: string;
    actorUserId: string;
    templateId: string;
    title: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<QualityAuditRunRow> {
  return withTenant(input.tenantId, async (db) => {
    if (!input.title.trim()) throw validationError('title required');
    const template = await db.query<{ id: string; current_version_id: string | null }>(
      `SELECT id, current_version_id FROM quality_audit_templates WHERE id = $1`,
      [input.templateId],
    );
    if (template.rowCount === 0) throw notFound('Audit template not found');
    if (!template.rows[0]!.current_version_id) {
      throw validationError('Template has no version');
    }

    const row = await db.query<QualityAuditRunRow>(
      `INSERT INTO quality_audit_runs (
         tenant_id, template_id, template_version_id, title, status,
         compliance_claim, conducted_by_user_id
       ) VALUES ($1,$2,$3,$4,'in_progress','internal_only',$5)
       RETURNING id, tenant_id, template_id, template_version_id, title, status,
                 internal_score, score_label, compliance_claim, created_at`,
      [
        input.tenantId,
        input.templateId,
        template.rows[0]!.current_version_id,
        input.title.trim(),
        input.actorUserId,
      ],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'quality.audit.start',
      entityType: 'quality_audit_run',
      entityId: row.rows[0]!.id,
      correlationId: input.correlationId,
    });

    return row.rows[0]!;
  }, pool);
}

export async function completeAuditRun(
  input: {
    tenantId: string;
    actorUserId: string;
    runId: string;
    internalScore?: number;
    scoreLabel?: string;
    notes?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<QualityAuditRunRow> {
  return withTenant(input.tenantId, async (db) => {
    const existing = await db.query(`SELECT id, status FROM quality_audit_runs WHERE id = $1 FOR UPDATE`, [
      input.runId,
    ]);
    if (existing.rowCount === 0) throw notFound('Audit run not found');
    if (existing.rows[0]!.status !== 'in_progress') {
      throw conflict('Audit run is not in progress');
    }

    const row = await db.query<QualityAuditRunRow>(
      `UPDATE quality_audit_runs
       SET status = 'completed',
           internal_score = $2,
           score_label = $3,
           notes = COALESCE($4, notes),
           completed_at = now(),
           updated_at = now()
       WHERE id = $1
       RETURNING id, tenant_id, template_id, template_version_id, title, status,
                 internal_score, score_label, compliance_claim, created_at`,
      [
        input.runId,
        input.internalScore ?? null,
        input.scoreLabel ?? null,
        input.notes ?? null,
      ],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'quality.audit.complete',
      entityType: 'quality_audit_run',
      entityId: input.runId,
      correlationId: input.correlationId,
      metadata: { compliance_claim: 'internal_only' },
    });

    return row.rows[0]!;
  }, pool);
}

export async function addAuditAction(
  input: {
    tenantId: string;
    actorUserId: string;
    runId: string;
    title: string;
    detail?: string;
    dueOn?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<{ id: string; title: string; status: string }> {
  return withTenant(input.tenantId, async (db) => {
    if (!input.title.trim()) throw validationError('title required');
    const run = await db.query(`SELECT id FROM quality_audit_runs WHERE id = $1`, [input.runId]);
    if (run.rowCount === 0) throw notFound('Audit run not found');

    const row = await db.query<{ id: string; title: string; status: string }>(
      `INSERT INTO quality_audit_actions (
         tenant_id, audit_run_id, title, detail, due_on, created_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, title, status`,
      [
        input.tenantId,
        input.runId,
        input.title.trim(),
        input.detail ?? '',
        input.dueOn ?? null,
        input.actorUserId,
      ],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'quality.action.create',
      entityType: 'quality_audit_action',
      entityId: row.rows[0]!.id,
      correlationId: input.correlationId,
    });

    return row.rows[0]!;
  }, pool);
}

export async function submitTestimonial(
  input: {
    tenantId: string;
    actorUserId: string;
    authorDisplayName: string;
    body: string;
    guardianId?: string;
    roleTemplate?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<QualityTestimonialRow> {
  return withTenant(input.tenantId, async (db) => {
    if (!input.authorDisplayName.trim() || !input.body.trim()) {
      throw validationError('author_display_name and body required');
    }

    if (input.roleTemplate === 'parent') {
      if (!input.guardianId) throw validationError('guardian_id required for parent submissions');
      const link = await db.query(
        `SELECT g.id FROM guardians g
         WHERE g.user_id = $1 AND g.id = $2 AND g.deleted_at IS NULL`,
        [input.actorUserId, input.guardianId],
      );
      if (link.rowCount === 0) throw forbidden('Not authorised for this guardian');
    }

    const row = await db.query<QualityTestimonialRow>(
      `INSERT INTO quality_testimonials (
         tenant_id, author_display_name, body, guardian_id,
         visibility, moderation_status, submitted_by_user_id
       ) VALUES ($1,$2,$3,$4,'private','pending',$5)
       RETURNING id, tenant_id, author_display_name, body, guardian_id,
                 visibility, moderation_status, created_at`,
      [
        input.tenantId,
        input.authorDisplayName.trim(),
        input.body.trim(),
        input.guardianId ?? null,
        input.actorUserId,
      ],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'testimonials.submit',
      entityType: 'quality_testimonial',
      entityId: row.rows[0]!.id,
      correlationId: input.correlationId,
    });

    return row.rows[0]!;
  }, pool);
}

export async function moderateTestimonial(
  input: {
    tenantId: string;
    actorUserId: string;
    testimonialId: string;
    moderationStatus: 'approved' | 'rejected' | 'withdrawn';
    visibility?: 'private' | 'staff' | 'public';
    note?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<QualityTestimonialRow> {
  return withTenant(input.tenantId, async (db) => {
    const existing = await db.query(`SELECT id FROM quality_testimonials WHERE id = $1 FOR UPDATE`, [
      input.testimonialId,
    ]);
    if (existing.rowCount === 0) throw notFound('Testimonial not found');

    const visibility =
      input.moderationStatus === 'approved' ? (input.visibility ?? 'staff') : 'private';

    const row = await db.query<QualityTestimonialRow>(
      `UPDATE quality_testimonials
       SET moderation_status = $2,
           visibility = $3,
           moderated_by_user_id = $4,
           moderated_at = now(),
           moderation_note = $5,
           updated_at = now()
       WHERE id = $1
       RETURNING id, tenant_id, author_display_name, body, guardian_id,
                 visibility, moderation_status, created_at`,
      [
        input.testimonialId,
        input.moderationStatus,
        visibility,
        input.actorUserId,
        input.note ?? null,
      ],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'testimonials.moderate',
      entityType: 'quality_testimonial',
      entityId: input.testimonialId,
      correlationId: input.correlationId,
      metadata: { moderation_status: input.moderationStatus, visibility },
    });

    return row.rows[0]!;
  }, pool);
}

export async function listTestimonials(
  input: {
    tenantId: string;
    actorUserId: string;
    roleTemplate?: string;
    limit?: number;
  },
  pool: DbPool,
): Promise<QualityTestimonialRow[]> {
  return withTenant(input.tenantId, async (db) => {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);

    if (input.roleTemplate === 'parent') {
      const result = await db.query<QualityTestimonialRow>(
        `SELECT t.id, t.tenant_id, t.author_display_name, t.body, t.guardian_id,
                t.visibility, t.moderation_status, t.created_at
         FROM quality_testimonials t
         LEFT JOIN guardians g ON g.tenant_id = t.tenant_id AND g.id = t.guardian_id
         WHERE t.moderation_status = 'approved' AND t.visibility = 'public'
            OR (g.user_id = $1 AND t.submitted_by_user_id = $1)
         ORDER BY t.created_at DESC
         LIMIT $2`,
        [input.actorUserId, limit],
      );
      return result.rows;
    }

    const result = await db.query<QualityTestimonialRow>(
      `SELECT id, tenant_id, author_display_name, body, guardian_id,
              visibility, moderation_status, created_at
       FROM quality_testimonials
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows;
  }, pool);
}
