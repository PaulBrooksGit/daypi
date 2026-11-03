import type { DbPool } from '../../../platform/db/src/pool.js';
import { withTenant } from '../../../platform/db/src/index.js';
import { writeAudit } from '../../../platform/audit/src/index.js';
import {
  notFound,
  conflict,
  forbidden,
  validationError,
} from '../../../platform/http/src/errors.js';
import type { DocumentVersionRow } from './documents.js';

export interface ConsentRequestRow {
  id: string;
  tenant_id: string;
  document_id: string;
  document_version_id: string;
  child_id: string | null;
  guardian_id: string | null;
  title: string;
  status: string;
  signed_at: Date | null;
  created_at: Date;
}

export interface SignatureEvidenceRow {
  id: string;
  tenant_id: string;
  consent_request_id: string;
  document_version_id: string;
  signed_by_user_id: string | null;
  guardian_id: string | null;
  signed_at: Date;
  signature_method: string;
  signer_display_name: string;
  content_sha256_at_sign: string;
  evidence_payload: Record<string, unknown>;
}

export async function createConsentRequest(
  input: {
    tenantId: string;
    actorUserId: string;
    documentId: string;
    documentVersionId?: string;
    guardianId: string;
    childId?: string;
    title?: string;
    expiresAt?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<ConsentRequestRow> {
  return withTenant(input.tenantId, async (db) => {
    const doc = await db.query<{ id: string; title: string; current_version_id: string | null }>(
      `SELECT id, title, current_version_id FROM documents WHERE id = $1`,
      [input.documentId],
    );
    if (!doc.rows[0]) throw notFound('Document not found');

    const versionId = input.documentVersionId ?? doc.rows[0].current_version_id;
    if (!versionId) throw validationError('Document has no version to consent against');

    const version = await db.query(
      `SELECT id FROM document_versions WHERE id = $1 AND document_id = $2`,
      [versionId, input.documentId],
    );
    if (version.rowCount === 0) throw notFound('Document version not found');

    const guardian = await db.query(
      `SELECT id FROM guardians WHERE id = $1 AND deleted_at IS NULL`,
      [input.guardianId],
    );
    if (guardian.rowCount === 0) throw notFound('Guardian not found');

    if (input.childId) {
      const child = await db.query(
        `SELECT id FROM children WHERE id = $1 AND deleted_at IS NULL`,
        [input.childId],
      );
      if (child.rowCount === 0) throw notFound('Child not found');
    }

    const res = await db.query<ConsentRequestRow>(
      `INSERT INTO consent_requests (
         tenant_id, document_id, document_version_id, child_id, guardian_id,
         title, status, requested_by_user_id, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8)
       RETURNING id, tenant_id, document_id, document_version_id, child_id, guardian_id,
                 title, status, signed_at, created_at`,
      [
        input.tenantId,
        input.documentId,
        versionId,
        input.childId ?? null,
        input.guardianId,
        input.title ?? `Consent: ${doc.rows[0].title}`,
        input.actorUserId,
        input.expiresAt ?? null,
      ],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'consents.request',
      entityType: 'consent_request',
      entityId: res.rows[0]!.id,
      correlationId: input.correlationId,
      metadata: { document_version_id: versionId },
    });

    return res.rows[0]!;
  }, pool);
}

export async function signConsent(
  input: {
    tenantId: string;
    actorUserId: string;
    consentId: string;
    signerDisplayName: string;
    signatureMethod?: 'typed_name' | 'drawn' | 'checkbox_ack';
    roleTemplate?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<{ consent: ConsentRequestRow; evidence: SignatureEvidenceRow; version: DocumentVersionRow }> {
  return withTenant(input.tenantId, async (db) => {
    const consent = await db.query<ConsentRequestRow>(
      `SELECT id, tenant_id, document_id, document_version_id, child_id, guardian_id,
              title, status, signed_at, created_at
       FROM consent_requests WHERE id = $1 FOR UPDATE`,
      [input.consentId],
    );
    const row = consent.rows[0];
    if (!row) throw notFound('Consent request not found');
    if (row.status === 'signed') {
      const existing = await db.query<SignatureEvidenceRow>(
        `SELECT id, tenant_id, consent_request_id, document_version_id, signed_by_user_id,
                guardian_id, signed_at, signature_method, signer_display_name,
                content_sha256_at_sign, evidence_payload
         FROM signature_evidence WHERE consent_request_id = $1`,
        [row.id],
      );
      const version = await db.query<DocumentVersionRow>(
        `SELECT id, tenant_id, document_id, version_number, stored_object_id,
                title_snapshot, body_text, content_sha256, created_at
         FROM document_versions WHERE id = $1`,
        [row.document_version_id],
      );
      return {
        consent: row,
        evidence: {
          ...existing.rows[0]!,
          evidence_payload:
            typeof existing.rows[0]!.evidence_payload === 'string'
              ? JSON.parse(existing.rows[0]!.evidence_payload as unknown as string)
              : existing.rows[0]!.evidence_payload,
        },
        version: version.rows[0]!,
      };
    }
    if (row.status !== 'pending') throw conflict(`Consent is ${row.status}`);

    if (input.roleTemplate === 'parent') {
      const link = await db.query(
        `SELECT g.id FROM guardians g
         WHERE g.user_id = $1 AND g.id = $2 AND g.deleted_at IS NULL`,
        [input.actorUserId, row.guardian_id],
      );
      if (link.rowCount === 0) throw forbidden('Not authorised to sign this consent');
    }

    if (!input.signerDisplayName.trim()) {
      throw validationError('signer_display_name required');
    }

    const version = await db.query<DocumentVersionRow>(
      `SELECT id, tenant_id, document_id, version_number, stored_object_id,
              title_snapshot, body_text, content_sha256, created_at
       FROM document_versions WHERE id = $1`,
      [row.document_version_id],
    );
    if (!version.rows[0]) throw notFound('Signed document version missing');

    const evidence = await db.query<SignatureEvidenceRow>(
      `INSERT INTO signature_evidence (
         tenant_id, consent_request_id, document_version_id, signed_by_user_id,
         guardian_id, signature_method, signer_display_name, content_sha256_at_sign,
         evidence_payload
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       RETURNING id, tenant_id, consent_request_id, document_version_id, signed_by_user_id,
                 guardian_id, signed_at, signature_method, signer_display_name,
                 content_sha256_at_sign, evidence_payload`,
      [
        input.tenantId,
        row.id,
        row.document_version_id,
        input.actorUserId,
        row.guardian_id,
        input.signatureMethod ?? 'typed_name',
        input.signerDisplayName.trim(),
        version.rows[0].content_sha256,
        JSON.stringify({
          document_id: row.document_id,
          version_number: version.rows[0].version_number,
        }),
      ],
    );

    const updated = await db.query<ConsentRequestRow>(
      `UPDATE consent_requests
       SET status = 'signed', signed_at = now(), updated_at = now()
       WHERE id = $1
       RETURNING id, tenant_id, document_id, document_version_id, child_id, guardian_id,
                 title, status, signed_at, created_at`,
      [row.id],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'consents.sign',
      entityType: 'consent_request',
      entityId: row.id,
      correlationId: input.correlationId,
      metadata: {
        document_version_id: row.document_version_id,
        content_sha256: version.rows[0].content_sha256,
      },
    });

    return {
      consent: updated.rows[0]!,
      evidence: {
        ...evidence.rows[0]!,
        evidence_payload:
          typeof evidence.rows[0]!.evidence_payload === 'string'
            ? JSON.parse(evidence.rows[0]!.evidence_payload as unknown as string)
            : evidence.rows[0]!.evidence_payload,
      },
      version: version.rows[0],
    };
  }, pool);
}

export async function getConsentWithEvidence(
  tenantId: string,
  consentId: string,
  pool: DbPool,
): Promise<{
  consent: ConsentRequestRow;
  evidence: SignatureEvidenceRow | null;
  version: DocumentVersionRow;
}> {
  return withTenant(tenantId, async (db) => {
    const consent = await db.query<ConsentRequestRow>(
      `SELECT id, tenant_id, document_id, document_version_id, child_id, guardian_id,
              title, status, signed_at, created_at
       FROM consent_requests WHERE id = $1`,
      [consentId],
    );
    if (!consent.rows[0]) throw notFound('Consent request not found');

    const version = await db.query<DocumentVersionRow>(
      `SELECT id, tenant_id, document_id, version_number, stored_object_id,
              title_snapshot, body_text, content_sha256, created_at
       FROM document_versions WHERE id = $1`,
      [consent.rows[0].document_version_id],
    );
    if (!version.rows[0]) throw notFound('Document version not found');

    const evidence = await db.query<SignatureEvidenceRow>(
      `SELECT id, tenant_id, consent_request_id, document_version_id, signed_by_user_id,
              guardian_id, signed_at, signature_method, signer_display_name,
              content_sha256_at_sign, evidence_payload
       FROM signature_evidence WHERE consent_request_id = $1`,
      [consentId],
    );

    return {
      consent: consent.rows[0],
      evidence: evidence.rows[0]
        ? {
            ...evidence.rows[0],
            evidence_payload:
              typeof evidence.rows[0].evidence_payload === 'string'
                ? JSON.parse(evidence.rows[0].evidence_payload as unknown as string)
                : evidence.rows[0].evidence_payload,
          }
        : null,
      version: version.rows[0],
    };
  }, pool);
}
