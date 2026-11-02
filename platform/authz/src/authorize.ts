import type { DbClient } from '../../db/src/pool.js';
import { forbidden, featureDisabled } from '../../http/src/errors.js';
import {
  DISABLED_OPERATIONS,
  ROLE_TEMPLATE_OPERATIONS,
  type Operation,
  type RoleTemplate,
} from './operations.js';

export interface AuthzSubject {
  kind: 'membership' | 'integration_client';
  tenantId: string;
  membershipId?: string;
  integrationClientId?: string;
  roleTemplate?: string;
  scopes?: string[];
}

export async function assertOperation(
  db: DbClient,
  subject: AuthzSubject,
  operation: Operation,
): Promise<void> {
  if (DISABLED_OPERATIONS.has(operation)) {
    throw featureDisabled(operation);
  }

  if (subject.kind === 'integration_client') {
    const scopes = subject.scopes ?? [];
    if (!scopes.includes(operation) && !scopes.includes('*')) {
      throw forbidden(`Missing scope for ${operation}`);
    }
    return;
  }

  if (!subject.membershipId) {
    throw forbidden('No membership in active tenant');
  }

  const grant = await db.query(
    `SELECT 1 FROM permission_grants
     WHERE membership_id = $1 AND operation = $2
     LIMIT 1`,
    [subject.membershipId, operation],
  );

  if (grant.rowCount === 0) {
    throw forbidden(`Missing permission for ${operation}`);
  }
}

export async function seedMembershipGrants(
  db: DbClient,
  tenantId: string,
  membershipId: string,
  roleTemplate: RoleTemplate,
): Promise<void> {
  const ops = ROLE_TEMPLATE_OPERATIONS[roleTemplate] ?? [];
  for (const operation of ops) {
    if (DISABLED_OPERATIONS.has(operation)) continue;
    await db.query(
      `INSERT INTO permission_grants (tenant_id, membership_id, operation)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [tenantId, membershipId, operation],
    );
  }
}

export function isRoleTemplate(value: string): value is RoleTemplate {
  return value in ROLE_TEMPLATE_OPERATIONS;
}
