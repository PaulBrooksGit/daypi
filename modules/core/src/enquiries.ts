import type { DbPool } from '../../../platform/db/src/pool.js';
import { withTenant } from '../../../platform/db/src/index.js';
import { writeAudit } from '../../../platform/audit/src/index.js';
import { notFound, conflict } from '../../../platform/http/src/errors.js';

export async function listEnquiries(
  input: { tenantId: string; status?: string; limit?: number },
  pool: DbPool,
) {
  const limit = Math.min(input.limit ?? 25, 100);
  return withTenant(input.tenantId, async (db) => {
    if (input.status) {
      const r = await db.query(
        `SELECT * FROM enquiries WHERE status = $1 ORDER BY created_at DESC LIMIT $2`,
        [input.status, limit],
      );
      return r.rows;
    }
    const r = await db.query(
      `SELECT * FROM enquiries ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return r.rows;
  }, pool);
}

export async function createEnquiry(
  input: {
    tenantId: string;
    actorUserId: string;
    siteId?: string;
    childGivenName: string;
    childFamilyName: string;
    childDateOfBirth?: string;
    guardianGivenName: string;
    guardianFamilyName: string;
    guardianEmail?: string;
    guardianPhoneE164?: string;
    notes?: string;
    source?: string;
    correlationId?: string;
  },
  pool: DbPool,
) {
  return withTenant(input.tenantId, async (db) => {
    const r = await db.query(
      `INSERT INTO enquiries (
         tenant_id, site_id, child_given_name, child_family_name, child_date_of_birth,
         guardian_given_name, guardian_family_name, guardian_email, guardian_phone_e164,
         notes, source
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        input.tenantId,
        input.siteId ?? null,
        input.childGivenName,
        input.childFamilyName,
        input.childDateOfBirth ?? null,
        input.guardianGivenName,
        input.guardianFamilyName,
        input.guardianEmail ?? null,
        input.guardianPhoneE164 ?? null,
        input.notes ?? null,
        input.source ?? null,
      ],
    );
    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'enquiries.create',
      entityType: 'enquiry',
      entityId: r.rows[0]!.id as string,
      correlationId: input.correlationId,
    });
    return r.rows[0];
  }, pool);
}

export async function updateEnquiryStatus(
  input: {
    tenantId: string;
    actorUserId: string;
    enquiryId: string;
    status: string;
    correlationId?: string;
  },
  pool: DbPool,
) {
  return withTenant(input.tenantId, async (db) => {
    const r = await db.query(
      `UPDATE enquiries SET status = $2, version = version + 1
       WHERE id = $1 RETURNING *`,
      [input.enquiryId, input.status],
    );
    if (r.rowCount === 0) throw notFound('Enquiry not found');
    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'enquiries.update',
      entityType: 'enquiry',
      entityId: input.enquiryId,
      correlationId: input.correlationId,
      metadata: { status: input.status },
    });
    return r.rows[0];
  }, pool);
}

export async function createEnrolment(
  input: {
    tenantId: string;
    actorUserId: string;
    siteId: string;
    childId: string;
    enquiryId?: string;
    startDate: string;
    endDate?: string;
    status?: string;
    correlationId?: string;
  },
  pool: DbPool,
) {
  return withTenant(input.tenantId, async (db) => {
    if (input.enquiryId) {
      const enq = await db.query(`SELECT id, status FROM enquiries WHERE id = $1`, [
        input.enquiryId,
      ]);
      if (enq.rowCount === 0) throw notFound('Enquiry not found');
    }

    const r = await db.query(
      `INSERT INTO enrolments (
         tenant_id, site_id, child_id, enquiry_id, status, start_date, end_date
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        input.tenantId,
        input.siteId,
        input.childId,
        input.enquiryId ?? null,
        input.status ?? 'active',
        input.startDate,
        input.endDate ?? null,
      ],
    );

    await db.query(
      `UPDATE children SET enrolment_status = 'active', start_date = COALESCE(start_date, $2::date),
         version = version + 1
       WHERE id = $1`,
      [input.childId, input.startDate],
    );

    if (input.enquiryId) {
      await db.query(
        `UPDATE enquiries SET status = 'enrolled', child_id = $2, version = version + 1
         WHERE id = $1`,
        [input.enquiryId, input.childId],
      );
    }

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'enrolments.create',
      entityType: 'enrolment',
      entityId: r.rows[0]!.id as string,
      correlationId: input.correlationId,
    });
    return r.rows[0];
  }, pool);
}

export async function listEnrolments(
  input: { tenantId: string; childId?: string; limit?: number },
  pool: DbPool,
) {
  const limit = Math.min(input.limit ?? 25, 100);
  return withTenant(input.tenantId, async (db) => {
    if (input.childId) {
      const r = await db.query(
        `SELECT * FROM enrolments WHERE child_id = $1 ORDER BY start_date DESC LIMIT $2`,
        [input.childId, limit],
      );
      return r.rows;
    }
    const r = await db.query(
      `SELECT * FROM enrolments ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return r.rows;
  }, pool);
}

export async function endEnrolment(
  input: {
    tenantId: string;
    actorUserId: string;
    enrolmentId: string;
    endDate: string;
    correlationId?: string;
  },
  pool: DbPool,
) {
  return withTenant(input.tenantId, async (db) => {
    const r = await db.query(
      `UPDATE enrolments SET status = 'ended', end_date = $2, version = version + 1
       WHERE id = $1 AND status = 'active'
       RETURNING *`,
      [input.enrolmentId, input.endDate],
    );
    if (r.rowCount === 0) throw conflict('Enrolment not active or not found');
    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'enrolments.end',
      entityType: 'enrolment',
      entityId: input.enrolmentId,
      correlationId: input.correlationId,
    });
    return r.rows[0];
  }, pool);
}
