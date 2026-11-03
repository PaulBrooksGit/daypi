import type { DbPool } from '../../../platform/db/src/pool.js';
import { withTenant } from '../../../platform/db/src/index.js';
import { writeAudit } from '../../../platform/audit/src/index.js';
import { notFound, conflict, forbidden } from '../../../platform/http/src/errors.js';
import { assertParentChildAccess } from '../../../platform/tenancy/src/index.js';

export async function updateChild(
  input: {
    tenantId: string;
    actorUserId: string;
    childId: string;
    givenName?: string;
    familyName?: string;
    preferredName?: string | null;
    enrolmentStatus?: string;
    expectedVersion?: number;
    correlationId?: string;
  },
  pool: DbPool,
) {
  return withTenant(input.tenantId, async (db) => {
    const current = await db.query<{ id: string; version: number }>(
      `SELECT id, version FROM children WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [input.childId],
    );
    if (current.rowCount === 0) throw notFound('Child not found');
    if (
      input.expectedVersion !== undefined &&
      current.rows[0]!.version !== input.expectedVersion
    ) {
      throw conflict('Child version mismatch', {
        expected: input.expectedVersion,
        actual: current.rows[0]!.version,
      });
    }

    const r = await db.query(
      `UPDATE children SET
         given_name = COALESCE($2, given_name),
         family_name = COALESCE($3, family_name),
         preferred_name = COALESCE($4, preferred_name),
         enrolment_status = COALESCE($5, enrolment_status),
         version = version + 1
       WHERE id = $1
       RETURNING id, tenant_id, given_name, family_name, preferred_name,
                 date_of_birth, enrolment_status, version`,
      [
        input.childId,
        input.givenName ?? null,
        input.familyName ?? null,
        input.preferredName === undefined ? null : input.preferredName,
        input.enrolmentStatus ?? null,
      ],
    );
    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'children.update',
      entityType: 'child',
      entityId: input.childId,
      correlationId: input.correlationId,
    });
    return r.rows[0];
  }, pool);
}

export async function archiveChild(
  input: {
    tenantId: string;
    actorUserId: string;
    childId: string;
    correlationId?: string;
  },
  pool: DbPool,
) {
  return withTenant(input.tenantId, async (db) => {
    const r = await db.query(
      `UPDATE children SET deleted_at = now(), enrolment_status = 'withdrawn', version = version + 1
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id, tenant_id, given_name, family_name, enrolment_status, deleted_at`,
      [input.childId],
    );
    if (r.rowCount === 0) throw notFound('Child not found');
    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'children.archive',
      entityType: 'child',
      entityId: input.childId,
      correlationId: input.correlationId,
    });
    return r.rows[0];
  }, pool);
}

export async function assertChildReadable(
  input: {
    tenantId: string;
    childId: string;
    actorUserId: string;
    roleTemplate?: string;
  },
  pool: DbPool,
): Promise<void> {
  await withTenant(input.tenantId, async (db) => {
    if (input.roleTemplate === 'parent') {
      await assertParentChildAccess(db, {
        tenantId: input.tenantId,
        guardianUserId: input.actorUserId,
        childId: input.childId,
      });
    } else {
      const r = await db.query(`SELECT id FROM children WHERE id = $1 AND deleted_at IS NULL`, [
        input.childId,
      ]);
      if (r.rowCount === 0) throw notFound('Child not found');
    }
  }, pool);
}

export function denyFinanceFullChildAccess(roleTemplate?: string): void {
  if (roleTemplate === 'finance') {
    throw forbidden('Finance role cannot access full child case records');
  }
}
