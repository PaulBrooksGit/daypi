import type { DbClient, DbPool } from '../../../platform/db/src/pool.js';
import { withTenant } from '../../../platform/db/src/index.js';
import { writeAudit } from '../../../platform/audit/src/index.js';
import { notFound, forbidden } from '../../../platform/http/src/errors.js';
import { assertParentChildAccess } from '../../../platform/tenancy/src/index.js';

export interface GuardianRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  given_name: string;
  family_name: string;
  email: string | null;
  phone_e164: string | null;
}

export async function listGuardians(
  input: { tenantId: string; actorUserId: string; roleTemplate?: string; limit?: number },
  pool: DbPool,
): Promise<GuardianRow[]> {
  const limit = Math.min(input.limit ?? 25, 100);
  return withTenant(input.tenantId, async (db) => {
    if (input.roleTemplate === 'parent') {
      const r = await db.query<GuardianRow>(
        `SELECT id, tenant_id, user_id, given_name, family_name, email, phone_e164
         FROM guardians
         WHERE user_id = $1 AND deleted_at IS NULL
         ORDER BY family_name, given_name
         LIMIT $2`,
        [input.actorUserId, limit],
      );
      return r.rows;
    }
    const r = await db.query<GuardianRow>(
      `SELECT id, tenant_id, user_id, given_name, family_name, email, phone_e164
       FROM guardians
       WHERE deleted_at IS NULL
       ORDER BY family_name, given_name
       LIMIT $1`,
      [limit],
    );
    return r.rows;
  }, pool);
}

export async function createGuardian(
  input: {
    tenantId: string;
    actorUserId: string;
    givenName: string;
    familyName: string;
    email?: string;
    phoneE164?: string;
    userId?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<GuardianRow> {
  return withTenant(input.tenantId, async (db) => {
    const r = await db.query<GuardianRow>(
      `INSERT INTO guardians (
         tenant_id, user_id, given_name, family_name, email, phone_e164
       ) VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, tenant_id, user_id, given_name, family_name, email, phone_e164`,
      [
        input.tenantId,
        input.userId ?? null,
        input.givenName,
        input.familyName,
        input.email ?? null,
        input.phoneE164 ?? null,
      ],
    );
    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'guardians.create',
      entityType: 'guardian',
      entityId: r.rows[0]!.id,
      correlationId: input.correlationId,
    });
    return r.rows[0]!;
  }, pool);
}

export async function getGuardian(
  input: { tenantId: string; guardianId: string; actorUserId: string; roleTemplate?: string },
  pool: DbPool,
): Promise<GuardianRow> {
  return withTenant(input.tenantId, async (db) => {
    const r = await db.query<GuardianRow>(
      `SELECT id, tenant_id, user_id, given_name, family_name, email, phone_e164
       FROM guardians WHERE id = $1 AND deleted_at IS NULL`,
      [input.guardianId],
    );
    const row = r.rows[0];
    if (!row) throw notFound('Guardian not found');
    if (input.roleTemplate === 'parent' && row.user_id !== input.actorUserId) {
      throw forbidden('No access to this guardian');
    }
    return row;
  }, pool);
}

export async function upsertChildGuardianRelationship(
  input: {
    tenantId: string;
    actorUserId: string;
    childId: string;
    guardianId: string;
    relationship?: string;
    hasParentalResponsibility?: boolean;
    isBillingContact?: boolean;
    isEmergencyContact?: boolean;
    isAuthorisedCollector?: boolean;
    accessLevel?: 'full' | 'limited' | 'none';
    correlationId?: string;
  },
  pool: DbPool,
) {
  return withTenant(input.tenantId, async (db) => {
    const r = await db.query(
      `INSERT INTO child_guardian_relationships (
         tenant_id, child_id, guardian_id, relationship,
         has_parental_responsibility, is_billing_contact, is_emergency_contact,
         is_authorised_collector, access_level, revoked_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NULL)
       ON CONFLICT (tenant_id, child_id, guardian_id) DO UPDATE SET
         relationship = EXCLUDED.relationship,
         has_parental_responsibility = EXCLUDED.has_parental_responsibility,
         is_billing_contact = EXCLUDED.is_billing_contact,
         is_emergency_contact = EXCLUDED.is_emergency_contact,
         is_authorised_collector = EXCLUDED.is_authorised_collector,
         access_level = EXCLUDED.access_level,
         revoked_at = NULL
       RETURNING *`,
      [
        input.tenantId,
        input.childId,
        input.guardianId,
        input.relationship ?? 'guardian',
        input.hasParentalResponsibility ?? false,
        input.isBillingContact ?? false,
        input.isEmergencyContact ?? false,
        input.isAuthorisedCollector ?? false,
        input.accessLevel ?? 'full',
      ],
    );
    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'relationships.manage',
      entityType: 'child_guardian_relationship',
      entityId: r.rows[0]!.id as string,
      correlationId: input.correlationId,
    });
    return r.rows[0];
  }, pool);
}

export async function revokeChildGuardianRelationship(
  input: {
    tenantId: string;
    actorUserId: string;
    childId: string;
    guardianId: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<void> {
  await withTenant(input.tenantId, async (db) => {
    const r = await db.query(
      `UPDATE child_guardian_relationships
       SET revoked_at = now(), access_level = 'none'
       WHERE child_id = $1 AND guardian_id = $2 AND revoked_at IS NULL
       RETURNING id`,
      [input.childId, input.guardianId],
    );
    if (r.rowCount === 0) throw notFound('Relationship not found');
    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'relationships.revoke',
      entityType: 'child_guardian_relationship',
      entityId: r.rows[0]!.id as string,
      correlationId: input.correlationId,
    });
  }, pool);
}

export async function assertGuardianCanAccessChild(
  db: DbClient,
  input: { tenantId: string; guardianUserId: string; childId: string },
): Promise<void> {
  await assertParentChildAccess(db, input);
}
