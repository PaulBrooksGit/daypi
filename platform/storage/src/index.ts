import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import type { DbClient } from '../../db/src/pool.js';
import type { AppConfig } from '../../config/src/index.js';
import { forbidden, notFound, validationError } from '../../http/src/errors.js';

export interface StoredObjectRow {
  id: string;
  tenant_id: string;
  storage_key: string;
  content_type: string;
  size_bytes: string;
  scan_status: string;
}

export interface StorageService {
  putObject(
    db: DbClient,
    input: {
      tenantId: string;
      userId?: string;
      contentType: string;
      body: Buffer;
      filename?: string;
    },
  ): Promise<StoredObjectRow>;
  getDownload(
    db: DbClient,
    input: { tenantId: string; objectId: string },
  ): Promise<{ object: StoredObjectRow; url: string; body?: Buffer }>;
}

export function createStorageService(config: AppConfig): StorageService {
  if (config.STORAGE_DRIVER === 's3') {
    // Stub: real S3 wiring later; Phase 0 uses local for isolation demos.
    return createLocalStorage(config);
  }
  return createLocalStorage(config);
}

function createLocalStorage(config: AppConfig): StorageService {
  const root = path.resolve(config.STORAGE_LOCAL_ROOT);

  return {
    async putObject(db, input) {
      if (input.body.byteLength > config.UPLOAD_MAX_BYTES) {
        throw validationError('File exceeds upload size limit');
      }
      if (!config.uploadAllowedMime.includes(input.contentType)) {
        throw validationError('Content type not allowed');
      }

      const objectId = randomUUID();
      const storageKey = `${input.tenantId}/${objectId}`;
      const abs = path.join(root, storageKey);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, input.body);
      const checksum = createHash('sha256').update(input.body).digest('hex');

      const res = await db.query<StoredObjectRow>(
        `INSERT INTO stored_objects (
           id, tenant_id, storage_key, content_type, size_bytes, checksum_sha256, scan_status, created_by_user_id
         ) VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)
         RETURNING id, tenant_id, storage_key, content_type, size_bytes::text, scan_status`,
        [
          objectId,
          input.tenantId,
          storageKey,
          input.contentType,
          input.body.byteLength,
          checksum,
          input.userId ?? null,
        ],
      );
      return res.rows[0]!;
    },

    async getDownload(db, input) {
      const res = await db.query<StoredObjectRow>(
        `SELECT id, tenant_id, storage_key, content_type, size_bytes::text, scan_status
         FROM stored_objects
         WHERE id = $1 AND deleted_at IS NULL`,
        [input.objectId],
      );
      const object = res.rows[0];
      if (!object) throw notFound('Object not found');
      if (object.tenant_id !== input.tenantId) {
        // Should already be blocked by RLS; fail closed without metadata leak
        throw notFound('Object not found');
      }
      if (object.scan_status === 'quarantine') {
        throw forbidden('Object quarantined');
      }

      const abs = path.join(root, object.storage_key);
      try {
        await access(abs);
      } catch {
        throw notFound('Object not found');
      }
      const body = await readFile(abs);
      // Short-lived "URL" stub for local driver
      const url = `local://${object.storage_key}?exp=${Date.now() + 60_000}`;
      return { object, url, body };
    },
  };
}
