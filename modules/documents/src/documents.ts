import { createHash } from 'node:crypto';
import type { DbPool } from '../../../platform/db/src/pool.js';
import { withTenant } from '../../../platform/db/src/index.js';
import { writeAudit } from '../../../platform/audit/src/index.js';
import { notFound, validationError } from '../../../platform/http/src/errors.js';

export interface DocumentRow {
  id: string;
  tenant_id: string;
  title: string;
  category: string;
  visibility: string;
  status: string;
  current_version_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface DocumentVersionRow {
  id: string;
  tenant_id: string;
  document_id: string;
  version_number: number;
  stored_object_id: string | null;
  title_snapshot: string;
  body_text: string | null;
  content_sha256: string;
  created_at: Date;
}

function contentHash(title: string, body: string | null, objectId: string | null): string {
  return createHash('sha256')
    .update(title)
    .update('\0')
    .update(body ?? '')
    .update('\0')
    .update(objectId ?? '')
    .digest('hex');
}

export async function createDocument(
  input: {
    tenantId: string;
    actorUserId: string;
    title: string;
    category?: string;
    visibility?: string;
    bodyText?: string;
    storedObjectId?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<{ document: DocumentRow; version: DocumentVersionRow }> {
  return withTenant(input.tenantId, async (db) => {
    if (!input.title.trim()) throw validationError('title required');

    const doc = await db.query<DocumentRow>(
      `INSERT INTO documents (
         tenant_id, title, category, visibility, status, created_by_user_id
       ) VALUES ($1,$2,$3,$4,'draft',$5)
       RETURNING id, tenant_id, title, category, visibility, status,
                 current_version_id, created_at, updated_at`,
      [
        input.tenantId,
        input.title.trim(),
        input.category ?? 'policy',
        input.visibility ?? 'staff',
        input.actorUserId,
      ],
    );

    const hash = contentHash(input.title.trim(), input.bodyText ?? null, input.storedObjectId ?? null);
    const version = await db.query<DocumentVersionRow>(
      `INSERT INTO document_versions (
         tenant_id, document_id, version_number, stored_object_id,
         title_snapshot, body_text, content_sha256, created_by_user_id
       ) VALUES ($1,$2,1,$3,$4,$5,$6,$7)
       RETURNING id, tenant_id, document_id, version_number, stored_object_id,
                 title_snapshot, body_text, content_sha256, created_at`,
      [
        input.tenantId,
        doc.rows[0]!.id,
        input.storedObjectId ?? null,
        input.title.trim(),
        input.bodyText ?? null,
        hash,
        input.actorUserId,
      ],
    );

    const updated = await db.query<DocumentRow>(
      `UPDATE documents SET current_version_id = $2, status = 'published', updated_at = now()
       WHERE id = $1
       RETURNING id, tenant_id, title, category, visibility, status,
                 current_version_id, created_at, updated_at`,
      [doc.rows[0]!.id, version.rows[0]!.id],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'documents.create',
      entityType: 'document',
      entityId: updated.rows[0]!.id,
      correlationId: input.correlationId,
      metadata: { version_id: version.rows[0]!.id },
    });

    return { document: updated.rows[0]!, version: version.rows[0]! };
  }, pool);
}

export async function addDocumentVersion(
  input: {
    tenantId: string;
    actorUserId: string;
    documentId: string;
    title?: string;
    bodyText?: string;
    storedObjectId?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<{ document: DocumentRow; version: DocumentVersionRow }> {
  return withTenant(input.tenantId, async (db) => {
    const existing = await db.query<DocumentRow>(
      `SELECT id, tenant_id, title, category, visibility, status,
              current_version_id, created_at, updated_at
       FROM documents WHERE id = $1 FOR UPDATE`,
      [input.documentId],
    );
    const doc = existing.rows[0];
    if (!doc) throw notFound('Document not found');

    const nextNum = await db.query<{ n: string }>(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS n
       FROM document_versions WHERE document_id = $1`,
      [input.documentId],
    );
    const versionNumber = Number(nextNum.rows[0]!.n);
    const title = (input.title ?? doc.title).trim();
    const hash = contentHash(title, input.bodyText ?? null, input.storedObjectId ?? null);

    const version = await db.query<DocumentVersionRow>(
      `INSERT INTO document_versions (
         tenant_id, document_id, version_number, stored_object_id,
         title_snapshot, body_text, content_sha256, created_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, tenant_id, document_id, version_number, stored_object_id,
                 title_snapshot, body_text, content_sha256, created_at`,
      [
        input.tenantId,
        input.documentId,
        versionNumber,
        input.storedObjectId ?? null,
        title,
        input.bodyText ?? null,
        hash,
        input.actorUserId,
      ],
    );

    const updated = await db.query<DocumentRow>(
      `UPDATE documents
       SET title = $2, current_version_id = $3, status = 'published', updated_at = now()
       WHERE id = $1
       RETURNING id, tenant_id, title, category, visibility, status,
                 current_version_id, created_at, updated_at`,
      [input.documentId, title, version.rows[0]!.id],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'documents.version',
      entityType: 'document',
      entityId: input.documentId,
      correlationId: input.correlationId,
      metadata: {
        version_id: version.rows[0]!.id,
        version_number: versionNumber,
      },
    });

    return { document: updated.rows[0]!, version: version.rows[0]! };
  }, pool);
}

export async function getDocument(
  tenantId: string,
  documentId: string,
  pool: DbPool,
): Promise<{ document: DocumentRow; currentVersion: DocumentVersionRow | null }> {
  return withTenant(tenantId, async (db) => {
    const doc = await db.query<DocumentRow>(
      `SELECT id, tenant_id, title, category, visibility, status,
              current_version_id, created_at, updated_at
       FROM documents WHERE id = $1`,
      [documentId],
    );
    if (!doc.rows[0]) throw notFound('Document not found');
    let currentVersion: DocumentVersionRow | null = null;
    if (doc.rows[0].current_version_id) {
      const ver = await db.query<DocumentVersionRow>(
        `SELECT id, tenant_id, document_id, version_number, stored_object_id,
                title_snapshot, body_text, content_sha256, created_at
         FROM document_versions WHERE id = $1`,
        [doc.rows[0].current_version_id],
      );
      currentVersion = ver.rows[0] ?? null;
    }
    return { document: doc.rows[0], currentVersion };
  }, pool);
}

export async function getDocumentVersion(
  tenantId: string,
  versionId: string,
  pool: DbPool,
): Promise<DocumentVersionRow> {
  return withTenant(tenantId, async (db) => {
    const ver = await db.query<DocumentVersionRow>(
      `SELECT id, tenant_id, document_id, version_number, stored_object_id,
              title_snapshot, body_text, content_sha256, created_at
       FROM document_versions WHERE id = $1`,
      [versionId],
    );
    if (!ver.rows[0]) throw notFound('Document version not found');
    return ver.rows[0];
  }, pool);
}

export async function listDocuments(
  tenantId: string,
  limit = 50,
  pool: DbPool,
): Promise<DocumentRow[]> {
  return withTenant(tenantId, async (db) => {
    const res = await db.query<DocumentRow>(
      `SELECT id, tenant_id, title, category, visibility, status,
              current_version_id, created_at, updated_at
       FROM documents
       ORDER BY updated_at DESC
       LIMIT $1`,
      [Math.min(limit, 100)],
    );
    return res.rows;
  }, pool);
}

export async function listDocumentVersions(
  tenantId: string,
  documentId: string,
  pool: DbPool,
): Promise<DocumentVersionRow[]> {
  return withTenant(tenantId, async (db) => {
    const res = await db.query<DocumentVersionRow>(
      `SELECT id, tenant_id, document_id, version_number, stored_object_id,
              title_snapshot, body_text, content_sha256, created_at
       FROM document_versions
       WHERE document_id = $1
       ORDER BY version_number ASC`,
      [documentId],
    );
    return res.rows;
  }, pool);
}
