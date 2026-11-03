import type { DbPool } from '../../../platform/db/src/pool.js';
import { withTenant } from '../../../platform/db/src/index.js';
import { writeAudit } from '../../../platform/audit/src/index.js';
import { validationError } from '../../../platform/http/src/errors.js';
import { z } from 'zod';

const importChildSchema = z.object({
  given_name: z.string().min(1).max(100),
  family_name: z.string().min(1).max(100),
  preferred_name: z.string().max(100).optional(),
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  enrolment_status: z
    .enum(['lead', 'waiting', 'active', 'graduated', 'withdrawn'])
    .optional(),
  guardians: z
    .array(
      z.object({
        given_name: z.string().min(1).max(100),
        family_name: z.string().min(1).max(100),
        email: z.string().email().optional(),
        phone_e164: z.string().optional(),
        relationship: z.string().optional(),
        access_level: z.enum(['full', 'limited', 'none']).optional(),
        is_authorised_collector: z.boolean().optional(),
        has_parental_responsibility: z.boolean().optional(),
      }),
    )
    .optional(),
});

const importPayloadSchema = z.object({
  children: z.array(importChildSchema).min(1).max(200),
});

/** Minimal pilot export of children + guardian links for the active tenant. */
export async function exportChildrenBundle(
  input: { tenantId: string; actorUserId: string; correlationId?: string },
  pool: DbPool,
) {
  return withTenant(input.tenantId, async (db) => {
    const children = await db.query(
      `SELECT id, given_name, family_name, preferred_name, date_of_birth,
              enrolment_status, start_date, leave_date
       FROM children WHERE deleted_at IS NULL
       ORDER BY family_name, given_name`,
    );
    const relationships = await db.query(
      `SELECT rel.child_id, rel.guardian_id, rel.relationship, rel.access_level,
              rel.has_parental_responsibility, rel.is_authorised_collector, rel.revoked_at,
              g.given_name AS guardian_given_name, g.family_name AS guardian_family_name,
              g.email AS guardian_email, g.phone_e164 AS guardian_phone_e164
       FROM child_guardian_relationships rel
       JOIN guardians g ON g.tenant_id = rel.tenant_id AND g.id = rel.guardian_id
       WHERE g.deleted_at IS NULL
       ORDER BY rel.child_id`,
    );
    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'export.tenant',
      entityType: 'children_bundle',
      correlationId: input.correlationId,
      metadata: { child_count: children.rowCount },
    });
    return {
      exported_at: new Date().toISOString(),
      tenant_id: input.tenantId,
      children: children.rows,
      relationships: relationships.rows,
    };
  }, pool);
}

/** Minimal pilot import. dry_run validates only; no live child data assumed. */
export async function importChildrenBundle(
  input: {
    tenantId: string;
    actorUserId: string;
    payload: unknown;
    dryRun?: boolean;
    correlationId?: string;
  },
  pool: DbPool,
) {
  const parsed = importPayloadSchema.safeParse(input.payload);
  if (!parsed.success) {
    throw validationError('Invalid import payload', { issues: parsed.error.issues });
  }

  if (input.dryRun) {
    return {
      dry_run: true,
      would_create_children: parsed.data.children.length,
      would_create_guardians: parsed.data.children.reduce(
        (n, c) => n + (c.guardians?.length ?? 0),
        0,
      ),
    };
  }

  return withTenant(input.tenantId, async (db) => {
    const created: Array<{ child_id: string; guardian_ids: string[] }> = [];
    for (const child of parsed.data.children) {
      const childRow = await db.query<{ id: string }>(
        `INSERT INTO children (
           tenant_id, given_name, family_name, preferred_name, date_of_birth, enrolment_status
         ) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [
          input.tenantId,
          child.given_name,
          child.family_name,
          child.preferred_name ?? null,
          child.date_of_birth,
          child.enrolment_status ?? 'lead',
        ],
      );
      const guardianIds: string[] = [];
      for (const g of child.guardians ?? []) {
        const gRow = await db.query<{ id: string }>(
          `INSERT INTO guardians (
             tenant_id, given_name, family_name, email, phone_e164
           ) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [
            input.tenantId,
            g.given_name,
            g.family_name,
            g.email ?? null,
            g.phone_e164 ?? null,
          ],
        );
        guardianIds.push(gRow.rows[0]!.id);
        await db.query(
          `INSERT INTO child_guardian_relationships (
             tenant_id, child_id, guardian_id, relationship, access_level,
             has_parental_responsibility, is_authorised_collector
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            input.tenantId,
            childRow.rows[0]!.id,
            gRow.rows[0]!.id,
            g.relationship ?? 'guardian',
            g.access_level ?? 'full',
            g.has_parental_responsibility ?? false,
            g.is_authorised_collector ?? false,
          ],
        );
      }
      created.push({ child_id: childRow.rows[0]!.id, guardian_ids: guardianIds });
    }

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'import.tenant',
      entityType: 'children_bundle',
      correlationId: input.correlationId,
      metadata: { created_count: created.length },
    });

    return { dry_run: false, created };
  }, pool);
}
