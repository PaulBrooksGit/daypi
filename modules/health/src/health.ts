import type { DbPool } from '../../../platform/db/src/pool.js';
import { withTenant } from '../../../platform/db/src/index.js';
import { writeAudit } from '../../../platform/audit/src/index.js';
import { assertParentChildAccess } from '../../../platform/tenancy/src/index.js';
import { notFound, validationError } from '../../../platform/http/src/errors.js';
import type { DbClient } from '../../../platform/db/src/pool.js';

export type AllergyOverallStatus =
  | 'unknown'
  | 'unconfirmed'
  | 'confirmed_present'
  | 'confirmed_none';

export interface AllergyProfileRow {
  id: string;
  tenant_id: string;
  child_id: string;
  overall_status: AllergyOverallStatus;
  notes: string;
  reviewed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface AllergyRow {
  id: string;
  tenant_id: string;
  child_id: string;
  allergen: string;
  confirmation_status: string;
  severity: string | null;
  reaction_notes: string;
  created_at: Date;
}

async function assertChildExists(db: DbClient, childId: string): Promise<void> {
  const child = await db.query(
    `SELECT id FROM children WHERE id = $1 AND deleted_at IS NULL`,
    [childId],
  );
  if (!child.rowCount) throw notFound('Child not found');
}

/** Ensures a profile exists; never initialises as confirmed_none / "None". */
export async function getOrCreateAllergyProfile(
  input: {
    tenantId: string;
    actorUserId: string;
    childId: string;
    roleTemplate?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<AllergyProfileRow> {
  return withTenant(input.tenantId, async (db) => {
    await assertChildExists(db, input.childId);
    if (input.roleTemplate === 'parent') {
      await assertParentChildAccess(db, {
        tenantId: input.tenantId,
        guardianUserId: input.actorUserId,
        childId: input.childId,
      });
    }

    const existing = await db.query<AllergyProfileRow>(
      `SELECT id, tenant_id, child_id, overall_status, notes, reviewed_at, created_at, updated_at
       FROM child_allergy_profiles WHERE child_id = $1`,
      [input.childId],
    );
    if (existing.rowCount && existing.rows[0]) {
      await writeAudit(db, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        action: 'health.allergy_profile.read',
        entityType: 'child_allergy_profile',
        entityId: existing.rows[0].id,
        correlationId: input.correlationId,
        metadata: { child_id: input.childId },
      });
      return existing.rows[0];
    }

    const created = await db.query<AllergyProfileRow>(
      `INSERT INTO child_allergy_profiles (
         tenant_id, child_id, overall_status, notes
       ) VALUES ($1,$2,'unknown','')
       RETURNING id, tenant_id, child_id, overall_status, notes, reviewed_at, created_at, updated_at`,
      [input.tenantId, input.childId],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'health.allergy_profile.create',
      entityType: 'child_allergy_profile',
      entityId: created.rows[0]!.id,
      correlationId: input.correlationId,
      metadata: { child_id: input.childId, overall_status: 'unknown' },
    });

    return created.rows[0]!;
  }, pool);
}

export async function setAllergyOverallStatus(
  input: {
    tenantId: string;
    actorUserId: string;
    childId: string;
    overallStatus: AllergyOverallStatus;
    notes?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<AllergyProfileRow> {
  return withTenant(input.tenantId, async (db) => {
    await assertChildExists(db, input.childId);

    await db.query(
      `INSERT INTO child_allergy_profiles (tenant_id, child_id, overall_status)
       VALUES ($1,$2,'unknown')
       ON CONFLICT (tenant_id, child_id) DO NOTHING`,
      [input.tenantId, input.childId],
    );

    const row = await db.query<AllergyProfileRow>(
      `UPDATE child_allergy_profiles
       SET overall_status = $2,
           notes = COALESCE($3, notes),
           reviewed_at = now(),
           reviewed_by_user_id = $4,
           updated_at = now()
       WHERE child_id = $1
       RETURNING id, tenant_id, child_id, overall_status, notes, reviewed_at, created_at, updated_at`,
      [input.childId, input.overallStatus, input.notes ?? null, input.actorUserId],
    );
    if (row.rowCount === 0) throw notFound('Allergy profile not found');

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'health.allergy_profile.update',
      entityType: 'child_allergy_profile',
      entityId: row.rows[0]!.id,
      correlationId: input.correlationId,
      metadata: { overall_status: input.overallStatus },
    });

    return row.rows[0]!;
  }, pool);
}

export async function addAllergy(
  input: {
    tenantId: string;
    actorUserId: string;
    childId: string;
    allergen: string;
    confirmationStatus?: 'unknown' | 'unconfirmed' | 'confirmed_present';
    severity?: 'mild' | 'moderate' | 'severe';
    reactionNotes?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<AllergyRow> {
  return withTenant(input.tenantId, async (db) => {
    await assertChildExists(db, input.childId);
    if (!input.allergen.trim()) throw validationError('allergen required');

    // Ensure profile exists with unknown default (never "None")
    await db.query(
      `INSERT INTO child_allergy_profiles (tenant_id, child_id, overall_status)
       VALUES ($1,$2,'unknown')
       ON CONFLICT (tenant_id, child_id) DO NOTHING`,
      [input.tenantId, input.childId],
    );

    const confirmation = input.confirmationStatus ?? 'unconfirmed';
    const row = await db.query<AllergyRow>(
      `INSERT INTO child_allergies (
         tenant_id, child_id, allergen, confirmation_status, severity,
         reaction_notes, recorded_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, tenant_id, child_id, allergen, confirmation_status, severity,
                 reaction_notes, created_at`,
      [
        input.tenantId,
        input.childId,
        input.allergen.trim(),
        confirmation,
        input.severity ?? null,
        input.reactionNotes ?? '',
        input.actorUserId,
      ],
    );

    if (confirmation === 'confirmed_present') {
      await db.query(
        `UPDATE child_allergy_profiles
         SET overall_status = 'confirmed_present',
             reviewed_at = now(),
             reviewed_by_user_id = $2,
             updated_at = now()
         WHERE child_id = $1`,
        [input.childId, input.actorUserId],
      );
    } else {
      await db.query(
        `UPDATE child_allergy_profiles
         SET overall_status = CASE
               WHEN overall_status = 'confirmed_none' THEN 'unconfirmed'
               WHEN overall_status = 'unknown' THEN 'unconfirmed'
               ELSE overall_status
             END,
             updated_at = now()
         WHERE child_id = $1`,
        [input.childId],
      );
    }

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'health.allergy.create',
      entityType: 'child_allergy',
      entityId: row.rows[0]!.id,
      correlationId: input.correlationId,
      metadata: { confirmation_status: confirmation },
    });

    return row.rows[0]!;
  }, pool);
}

export async function listAllergies(
  input: {
    tenantId: string;
    actorUserId: string;
    childId: string;
    roleTemplate?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<{ profile: AllergyProfileRow; allergies: AllergyRow[] }> {
  return withTenant(input.tenantId, async (db) => {
    await assertChildExists(db, input.childId);
    if (input.roleTemplate === 'parent') {
      await assertParentChildAccess(db, {
        tenantId: input.tenantId,
        guardianUserId: input.actorUserId,
        childId: input.childId,
      });
    }

    let profile = await db.query<AllergyProfileRow>(
      `SELECT id, tenant_id, child_id, overall_status, notes, reviewed_at, created_at, updated_at
       FROM child_allergy_profiles WHERE child_id = $1`,
      [input.childId],
    );
    if (!profile.rowCount) {
      profile = await db.query<AllergyProfileRow>(
        `INSERT INTO child_allergy_profiles (tenant_id, child_id, overall_status)
         VALUES ($1,$2,'unknown')
         RETURNING id, tenant_id, child_id, overall_status, notes, reviewed_at, created_at, updated_at`,
        [input.tenantId, input.childId],
      );
    }

    const allergies = await db.query<AllergyRow>(
      `SELECT id, tenant_id, child_id, allergen, confirmation_status, severity,
              reaction_notes, created_at
       FROM child_allergies WHERE child_id = $1
       ORDER BY created_at DESC`,
      [input.childId],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'health.allergies.read',
      entityType: 'child_allergy_profile',
      entityId: profile.rows[0]!.id,
      correlationId: input.correlationId,
      metadata: { child_id: input.childId },
    });

    return { profile: profile.rows[0]!, allergies: allergies.rows };
  }, pool);
}

export async function addCondition(
  input: {
    tenantId: string;
    actorUserId: string;
    childId: string;
    name: string;
    confirmationStatus?: string;
    careNotes?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<{ id: string; name: string; confirmation_status: string }> {
  return withTenant(input.tenantId, async (db) => {
    await assertChildExists(db, input.childId);
    if (!input.name.trim()) throw validationError('name required');

    const row = await db.query<{ id: string; name: string; confirmation_status: string }>(
      `INSERT INTO child_conditions (
         tenant_id, child_id, name, confirmation_status, care_notes, recorded_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, name, confirmation_status`,
      [
        input.tenantId,
        input.childId,
        input.name.trim(),
        input.confirmationStatus ?? 'unconfirmed',
        input.careNotes ?? '',
        input.actorUserId,
      ],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'health.condition.create',
      entityType: 'child_condition',
      entityId: row.rows[0]!.id,
      correlationId: input.correlationId,
    });

    return row.rows[0]!;
  }, pool);
}

export async function createCarePlan(
  input: {
    tenantId: string;
    actorUserId: string;
    childId: string;
    title: string;
    bodyMarkdown?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<{ id: string; title: string; status: string }> {
  return withTenant(input.tenantId, async (db) => {
    await assertChildExists(db, input.childId);
    if (!input.title.trim()) throw validationError('title required');

    const row = await db.query<{ id: string; title: string; status: string }>(
      `INSERT INTO child_care_plans (
         tenant_id, child_id, title, body_markdown, status, created_by_user_id
       ) VALUES ($1,$2,$3,$4,'draft',$5)
       RETURNING id, title, status`,
      [
        input.tenantId,
        input.childId,
        input.title.trim(),
        input.bodyMarkdown ?? '',
        input.actorUserId,
      ],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'health.care_plan.create',
      entityType: 'child_care_plan',
      entityId: row.rows[0]!.id,
      correlationId: input.correlationId,
    });

    return row.rows[0]!;
  }, pool);
}

export async function addObservation(
  input: {
    tenantId: string;
    actorUserId: string;
    childId: string;
    bodyMarkdown: string;
    category?: string;
    observedAt?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<{ id: string; category: string; observed_at: Date }> {
  return withTenant(input.tenantId, async (db) => {
    await assertChildExists(db, input.childId);
    if (!input.bodyMarkdown.trim()) throw validationError('body_markdown required');

    const row = await db.query<{ id: string; category: string; observed_at: Date }>(
      `INSERT INTO child_observations (
         tenant_id, child_id, observed_at, category, body_markdown, created_by_user_id
       ) VALUES ($1,$2,COALESCE($3::timestamptz, now()),$4,$5,$6)
       RETURNING id, category, observed_at`,
      [
        input.tenantId,
        input.childId,
        input.observedAt ?? null,
        input.category ?? 'general',
        input.bodyMarkdown.trim(),
        input.actorUserId,
      ],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'health.observation.create',
      entityType: 'child_observation',
      entityId: row.rows[0]!.id,
      correlationId: input.correlationId,
    });

    return row.rows[0]!;
  }, pool);
}
