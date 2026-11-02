import type { DbClient, DbPool } from '../../db/src/pool.js';
import { getPool, withTenant } from '../../db/src/index.js';
import { seedMembershipGrants, type RoleTemplate } from '../../authz/src/index.js';
import { writeAudit } from '../../audit/src/index.js';
import { notFound, forbidden } from '../../http/src/errors.js';

export interface TenantRow {
  id: string;
  display_name: string;
  setting_type: string;
  primary_timezone: string;
  status: string;
}

export interface SiteRow {
  id: string;
  tenant_id: string;
  name: string;
  timezone: string;
  is_primary: boolean;
}

export async function getCurrentTenant(
  tenantId: string,
  pool: DbPool = getPool(),
): Promise<TenantRow> {
  return withTenant(tenantId, async (db) => {
    // tenants table is not RLS — still resolve via membership-gated route only
    const res = await db.query<TenantRow>(
      `SELECT id, display_name, setting_type, primary_timezone, status FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const row = res.rows[0];
    if (!row) throw notFound('Tenant not found');
    return row;
  }, pool);
}

export async function updateCurrentTenant(
  input: {
    tenantId: string;
    actorUserId: string;
    displayName?: string;
    primaryTimezone?: string;
    correlationId?: string;
  },
  pool: DbPool = getPool(),
): Promise<TenantRow> {
  return withTenant(input.tenantId, async (db) => {
    const res = await db.query<TenantRow>(
      `UPDATE tenants SET
         display_name = COALESCE($2, display_name),
         primary_timezone = COALESCE($3, primary_timezone),
         updated_at = now()
       WHERE id = $1
       RETURNING id, display_name, setting_type, primary_timezone, status`,
      [input.tenantId, input.displayName ?? null, input.primaryTimezone ?? null],
    );
    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'tenant.update',
      entityType: 'tenant',
      entityId: input.tenantId,
      correlationId: input.correlationId,
    });
    return res.rows[0]!;
  }, pool);
}

export async function listSites(tenantId: string, pool: DbPool = getPool()): Promise<SiteRow[]> {
  return withTenant(tenantId, async (db) => {
    const res = await db.query<SiteRow>(
      `SELECT id, tenant_id, name, timezone, is_primary FROM sites ORDER BY is_primary DESC, name`,
    );
    return res.rows;
  }, pool);
}

export async function createSite(
  input: {
    tenantId: string;
    name: string;
    timezone?: string;
    isPrimary?: boolean;
    actorUserId: string;
    correlationId?: string;
  },
  pool: DbPool = getPool(),
): Promise<SiteRow> {
  return withTenant(input.tenantId, async (db) => {
    if (input.isPrimary) {
      await db.query(`UPDATE sites SET is_primary = false WHERE tenant_id = $1`, [input.tenantId]);
    }
    const res = await db.query<SiteRow>(
      `INSERT INTO sites (tenant_id, name, timezone, is_primary)
       VALUES ($1, $2, $3, $4)
       RETURNING id, tenant_id, name, timezone, is_primary`,
      [
        input.tenantId,
        input.name,
        input.timezone ?? 'Europe/London',
        input.isPrimary ?? false,
      ],
    );
    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'site.create',
      entityType: 'site',
      entityId: res.rows[0]!.id,
      correlationId: input.correlationId,
    });
    return res.rows[0]!;
  }, pool);
}

export async function getSite(
  tenantId: string,
  siteId: string,
  pool: DbPool = getPool(),
): Promise<SiteRow> {
  return withTenant(tenantId, async (db) => {
    const res = await db.query<SiteRow>(
      `SELECT id, tenant_id, name, timezone, is_primary FROM sites WHERE id = $1`,
      [siteId],
    );
    const row = res.rows[0];
    if (!row) throw notFound('Site not found');
    return row;
  }, pool);
}

export async function listMemberships(tenantId: string, pool: DbPool = getPool()) {
  return withTenant(tenantId, async (db) => {
    const res = await db.query(
      `SELECT m.id, m.user_id, m.role_template, m.status, m.created_at, m.revoked_at, u.email
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       ORDER BY m.created_at`,
    );
    return res.rows;
  }, pool);
}

export async function revokeMembership(input: {
  tenantId: string;
  membershipId: string;
  actorUserId: string;
  correlationId?: string;
  pool?: DbPool;
}): Promise<void> {
  const pool = input.pool ?? getPool();
  await withTenant(input.tenantId, async (db) => {
    const res = await db.query<{ id: string; role_template: string }>(
      `UPDATE memberships
       SET status = 'revoked', revoked_at = now()
       WHERE id = $1 AND status = 'active'
       RETURNING id, role_template`,
      [input.membershipId],
    );
    if (res.rowCount === 0) throw notFound('Membership not found');
    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'membership.revoke',
      entityType: 'membership',
      entityId: input.membershipId,
      correlationId: input.correlationId,
    });
  }, pool);
}

export async function createTenantBootstrap(
  db: DbClient,
  input: {
    displayName: string;
    settingType?: string;
    timezone?: string;
    ownerUserId: string;
    siteName?: string;
  },
): Promise<{ tenantId: string; membershipId: string; siteId: string }> {
  const tenant = await db.query<{ id: string }>(
    `INSERT INTO tenants (display_name, setting_type, primary_timezone)
     VALUES ($1, $2, $3) RETURNING id`,
    [input.displayName, input.settingType ?? 'childminder', input.timezone ?? 'Europe/London'],
  );
  const tenantId = tenant.rows[0]!.id;

  await db.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);

  const site = await db.query<{ id: string }>(
    `INSERT INTO sites (tenant_id, name, timezone, is_primary)
     VALUES ($1, $2, $3, true) RETURNING id`,
    [tenantId, input.siteName ?? 'Primary', input.timezone ?? 'Europe/London'],
  );

  const mem = await db.query<{ id: string }>(
    `INSERT INTO memberships (tenant_id, user_id, role_template, status)
     VALUES ($1, $2, 'owner', 'active') RETURNING id`,
    [tenantId, input.ownerUserId],
  );

  await seedMembershipGrants(db, tenantId, mem.rows[0]!.id, 'owner');

  await db.query(
    `INSERT INTO platform_subscriptions (tenant_id, plan_code, status)
     VALUES ($1, 'draft_standard_39', 'trialing')`,
    [tenantId],
  );
  await db.query(
    `INSERT INTO usage_accounts (tenant_id, balance_minor, currency)
     VALUES ($1, 0, 'GBP')`,
    [tenantId],
  );
  await db.query(
    `INSERT INTO entitlements (tenant_id, module_key, enabled, limits)
     VALUES ($1, 'daycore', true, '{}'::jsonb),
            ($1, 'daybyte', true, '{}'::jsonb),
            ($1, 'dayteam', true, '{}'::jsonb)`,
    [tenantId],
  );

  return { tenantId, membershipId: mem.rows[0]!.id, siteId: site.rows[0]!.id };
}

export async function assertParentChildAccess(
  db: DbClient,
  input: { tenantId: string; guardianUserId: string; childId: string },
): Promise<void> {
  const res = await db.query(
    `SELECT 1
     FROM guardians g
     JOIN child_guardian_relationships r
       ON r.tenant_id = g.tenant_id AND r.guardian_id = g.id
     WHERE g.tenant_id = $1
       AND g.user_id = $2
       AND r.child_id = $3
       AND r.revoked_at IS NULL
       AND r.access_level IN ('full', 'limited')
       AND g.deleted_at IS NULL`,
    [input.tenantId, input.guardianUserId, input.childId],
  );
  if (res.rowCount === 0) throw forbidden('No access to this child');
}

export type { RoleTemplate };
