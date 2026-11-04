import type { DbPool } from '../../../platform/db/src/pool.js';
import { withTenant } from '../../../platform/db/src/index.js';
import { writeAudit } from '../../../platform/audit/src/index.js';
import { notFound, validationError } from '../../../platform/http/src/errors.js';

export interface FacilityAssetRow {
  id: string;
  tenant_id: string;
  site_id: string | null;
  name: string;
  category: string;
  location_label: string;
  status: string;
  created_at: Date;
}

export async function createAsset(
  input: {
    tenantId: string;
    actorUserId: string;
    name: string;
    category?: 'premises' | 'equipment' | 'vehicle' | 'outdoor' | 'other';
    siteId?: string;
    locationLabel?: string;
    serialNumber?: string;
    notes?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<FacilityAssetRow> {
  return withTenant(input.tenantId, async (db) => {
    if (!input.name.trim()) throw validationError('name required');

    const row = await db.query<FacilityAssetRow>(
      `INSERT INTO facility_assets (
         tenant_id, site_id, name, category, location_label,
         serial_number, notes, created_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, tenant_id, site_id, name, category, location_label, status, created_at`,
      [
        input.tenantId,
        input.siteId ?? null,
        input.name.trim(),
        input.category ?? 'equipment',
        input.locationLabel ?? '',
        input.serialNumber ?? null,
        input.notes ?? '',
        input.actorUserId,
      ],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'facilities.asset.create',
      entityType: 'facility_asset',
      entityId: row.rows[0]!.id,
      correlationId: input.correlationId,
    });

    return row.rows[0]!;
  }, pool);
}

export async function listAssets(
  tenantId: string,
  limit: number,
  pool: DbPool,
): Promise<FacilityAssetRow[]> {
  return withTenant(tenantId, async (db) => {
    const result = await db.query<FacilityAssetRow>(
      `SELECT id, tenant_id, site_id, name, category, location_label, status, created_at
       FROM facility_assets
       ORDER BY created_at DESC
       LIMIT $1`,
      [Math.min(Math.max(limit, 1), 100)],
    );
    return result.rows;
  }, pool);
}

export async function createInspectionSchedule(
  input: {
    tenantId: string;
    actorUserId: string;
    assetId: string;
    title: string;
    cadenceDays: number;
    nextDueOn: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<{ id: string; title: string; next_due_on: Date; status: string }> {
  return withTenant(input.tenantId, async (db) => {
    if (!input.title.trim()) throw validationError('title required');
    if (input.cadenceDays < 1) throw validationError('cadence_days must be >= 1');

    const asset = await db.query(`SELECT id FROM facility_assets WHERE id = $1`, [input.assetId]);
    if (asset.rowCount === 0) throw notFound('Asset not found');

    const row = await db.query<{
      id: string;
      title: string;
      next_due_on: Date;
      status: string;
    }>(
      `INSERT INTO facility_inspection_schedules (
         tenant_id, asset_id, title, cadence_days, next_due_on, created_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, title, next_due_on, status`,
      [
        input.tenantId,
        input.assetId,
        input.title.trim(),
        input.cadenceDays,
        input.nextDueOn,
        input.actorUserId,
      ],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'facilities.schedule.create',
      entityType: 'facility_inspection_schedule',
      entityId: row.rows[0]!.id,
      correlationId: input.correlationId,
    });

    return row.rows[0]!;
  }, pool);
}

export async function recordInspection(
  input: {
    tenantId: string;
    actorUserId: string;
    assetId: string;
    outcome: 'pass' | 'pass_with_notes' | 'fail';
    scheduleId?: string;
    notes?: string;
    evidenceObjectId?: string;
    findings?: Array<{ severity?: string; description: string }>;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<{
  inspection: { id: string; outcome: string; inspected_at: Date };
  findings: Array<{ id: string; description: string; severity: string }>;
}> {
  return withTenant(input.tenantId, async (db) => {
    const asset = await db.query(`SELECT id FROM facility_assets WHERE id = $1`, [input.assetId]);
    if (asset.rowCount === 0) throw notFound('Asset not found');

    const inspection = await db.query<{ id: string; outcome: string; inspected_at: Date }>(
      `INSERT INTO facility_inspections (
         tenant_id, asset_id, schedule_id, outcome, notes,
         evidence_object_id, inspected_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, outcome, inspected_at`,
      [
        input.tenantId,
        input.assetId,
        input.scheduleId ?? null,
        input.outcome,
        input.notes ?? '',
        input.evidenceObjectId ?? null,
        input.actorUserId,
      ],
    );

    if (input.scheduleId) {
      await db.query(
        `UPDATE facility_inspection_schedules s
         SET next_due_on = (CURRENT_DATE + (s.cadence_days || ' days')::interval)::date,
             updated_at = now()
         WHERE s.id = $1`,
        [input.scheduleId],
      );
    }

    const findings: Array<{ id: string; description: string; severity: string }> = [];
    for (const finding of input.findings ?? []) {
      if (!finding.description.trim()) continue;
      const f = await db.query<{ id: string; description: string; severity: string }>(
        `INSERT INTO facility_findings (
           tenant_id, inspection_id, asset_id, severity, description
         ) VALUES ($1,$2,$3,$4,$5)
         RETURNING id, description, severity`,
        [
          input.tenantId,
          inspection.rows[0]!.id,
          input.assetId,
          finding.severity ?? 'medium',
          finding.description.trim(),
        ],
      );
      findings.push(f.rows[0]!);
    }

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'facilities.inspection.record',
      entityType: 'facility_inspection',
      entityId: inspection.rows[0]!.id,
      correlationId: input.correlationId,
      metadata: { outcome: input.outcome, findings_count: findings.length },
    });

    return { inspection: inspection.rows[0]!, findings };
  }, pool);
}

export async function createMaintenanceAction(
  input: {
    tenantId: string;
    actorUserId: string;
    assetId: string;
    title: string;
    findingId?: string;
    detail?: string;
    dueOn?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<{ id: string; title: string; status: string }> {
  return withTenant(input.tenantId, async (db) => {
    if (!input.title.trim()) throw validationError('title required');
    const asset = await db.query(`SELECT id FROM facility_assets WHERE id = $1`, [input.assetId]);
    if (asset.rowCount === 0) throw notFound('Asset not found');

    const row = await db.query<{ id: string; title: string; status: string }>(
      `INSERT INTO facility_maintenance_actions (
         tenant_id, finding_id, asset_id, title, detail, due_on, created_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, title, status`,
      [
        input.tenantId,
        input.findingId ?? null,
        input.assetId,
        input.title.trim(),
        input.detail ?? '',
        input.dueOn ?? null,
        input.actorUserId,
      ],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'facilities.maintenance.create',
      entityType: 'facility_maintenance_action',
      entityId: row.rows[0]!.id,
      correlationId: input.correlationId,
    });

    return row.rows[0]!;
  }, pool);
}
