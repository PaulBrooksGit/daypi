import { Router } from 'express';
import { z } from 'zod';
import type { DbPool } from '../../../../platform/db/src/index.js';
import type { AppConfig } from '../../../../platform/config/src/index.js';
import {
  createAuthMiddleware,
  requireActiveTenant,
  requireOperation,
} from '../../../../platform/auth/src/index.js';
import { withTenant } from '../../../../platform/db/src/index.js';
import { createStorageService } from '../../../../platform/storage/src/index.js';
import { writeAudit } from '../../../../platform/audit/src/index.js';
import { enqueueOutbox } from '../../../../platform/jobs/src/index.js';

export function storageRoutes(pool: DbPool, config: AppConfig): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(pool);
  const storage = createStorageService(config);

  router.post(
    '/files',
    requireAuth,
    requireActiveTenant,
    requireOperation('documents.upload'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            content_type: z.string().min(1),
            // base64 body for Phase 0 stub (multipart later)
            content_base64: z.string().min(1),
            filename: z.string().optional(),
          })
          .parse(req.body);

        const buf = Buffer.from(body.content_base64, 'base64');
        const tenantId = req.actor!.activeTenantId!;

        const object = await withTenant(tenantId, async (db) => {
          const created = await storage.putObject(db, {
            tenantId,
            userId: req.actor!.userId,
            contentType: body.content_type,
            body: buf,
            filename: body.filename,
          });
          await enqueueOutbox(db, {
            tenantId,
            aggregateType: 'stored_object',
            aggregateId: created.id,
            eventType: 'storage.scan',
            payload: { objectId: created.id },
          });
          await writeAudit(db, {
            tenantId,
            actorUserId: req.actor!.userId,
            action: 'documents.upload',
            entityType: 'stored_object',
            entityId: created.id,
            correlationId: req.correlationId,
          });
          return created;
        }, pool);

        res.status(201).json({
          data: {
            id: object.id,
            content_type: object.content_type,
            size_bytes: Number(object.size_bytes),
            scan_status: object.scan_status,
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/files/:id',
    requireAuth,
    requireActiveTenant,
    requireOperation('documents.read'),
    async (req, res, next) => {
      try {
        const tenantId = req.actor!.activeTenantId!;
        const result = await withTenant(tenantId, async (db) => {
          return storage.getDownload(db, { tenantId, objectId: req.params.id! });
        }, pool);

        res.json({
          data: {
            id: result.object.id,
            content_type: result.object.content_type,
            size_bytes: Number(result.object.size_bytes),
            scan_status: result.object.scan_status,
            download_url: result.url,
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
