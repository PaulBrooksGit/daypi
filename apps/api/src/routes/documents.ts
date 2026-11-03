import { Router } from 'express';
import { z } from 'zod';
import type { DbPool } from '../../../../platform/db/src/index.js';
import {
  createAuthMiddleware,
  requireActiveTenant,
  requireOperation,
} from '../../../../platform/auth/src/index.js';
import {
  createDocument,
  addDocumentVersion,
  getDocument,
  getDocumentVersion,
  listDocuments,
  listDocumentVersions,
  createConsentRequest,
  signConsent,
  getConsentWithEvidence,
} from '../../../../modules/documents/src/index.js';

export function documentsRoutes(pool: DbPool): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(pool);

  router.get(
    '/documents',
    requireAuth,
    requireActiveTenant,
    requireOperation('documents.read'),
    async (req, res, next) => {
      try {
        const rows = await listDocuments(
          req.actor!.activeTenantId!,
          Number(req.query.limit ?? 50),
          pool,
        );
        res.json({ data: rows, next_cursor: null });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/documents',
    requireAuth,
    requireActiveTenant,
    requireOperation('documents.upload'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            title: z.string().min(1).max(500),
            category: z.string().min(1).max(100).optional(),
            visibility: z.enum(['staff', 'guardians', 'private']).optional(),
            body_text: z.string().max(200_000).optional(),
            stored_object_id: z.string().uuid().optional(),
          })
          .parse(req.body);
        const created = await createDocument(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            title: body.title,
            category: body.category,
            visibility: body.visibility,
            bodyText: body.body_text,
            storedObjectId: body.stored_object_id,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.status(201).json({ data: created });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/documents/:documentId',
    requireAuth,
    requireActiveTenant,
    requireOperation('documents.read'),
    async (req, res, next) => {
      try {
        const data = await getDocument(
          req.actor!.activeTenantId!,
          req.params.documentId!,
          pool,
        );
        res.json({ data });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/documents/:documentId/versions',
    requireAuth,
    requireActiveTenant,
    requireOperation('documents.version'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            title: z.string().min(1).max(500).optional(),
            body_text: z.string().max(200_000).optional(),
            stored_object_id: z.string().uuid().optional(),
          })
          .parse(req.body);
        const created = await addDocumentVersion(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            documentId: req.params.documentId!,
            title: body.title,
            bodyText: body.body_text,
            storedObjectId: body.stored_object_id,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.status(201).json({ data: created });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/documents/:documentId/versions',
    requireAuth,
    requireActiveTenant,
    requireOperation('documents.read'),
    async (req, res, next) => {
      try {
        const rows = await listDocumentVersions(
          req.actor!.activeTenantId!,
          req.params.documentId!,
          pool,
        );
        res.json({ data: rows });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/document-versions/:versionId',
    requireAuth,
    requireActiveTenant,
    requireOperation('documents.read'),
    async (req, res, next) => {
      try {
        const version = await getDocumentVersion(
          req.actor!.activeTenantId!,
          req.params.versionId!,
          pool,
        );
        res.json({ data: version });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/consents',
    requireAuth,
    requireActiveTenant,
    requireOperation('consents.request'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            document_id: z.string().uuid(),
            document_version_id: z.string().uuid().optional(),
            guardian_id: z.string().uuid(),
            child_id: z.string().uuid().optional(),
            title: z.string().min(1).max(500).optional(),
            expires_at: z.string().datetime().optional(),
          })
          .parse(req.body);
        const created = await createConsentRequest(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            documentId: body.document_id,
            documentVersionId: body.document_version_id,
            guardianId: body.guardian_id,
            childId: body.child_id,
            title: body.title,
            expiresAt: body.expires_at,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.status(201).json({ data: created });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/consents/:consentId/signatures',
    requireAuth,
    requireActiveTenant,
    requireOperation('consents.sign'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            signer_display_name: z.string().min(1).max(200),
            signature_method: z.enum(['typed_name', 'drawn', 'checkbox_ack']).optional(),
          })
          .parse(req.body);
        // Parents have consents.sign; staff owners may also need to request then parent signs.
        // If actor has consents.request but not sign, still allow owner/manager via documents path?
        // Matrix: consents.sign = Parent Own. Owners don't have consents.sign in template.
        // For gate tests parents sign. Allow if operation granted.
        const signed = await signConsent(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            consentId: req.params.consentId!,
            signerDisplayName: body.signer_display_name,
            signatureMethod: body.signature_method,
            roleTemplate: req.actor!.subject?.roleTemplate,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.status(201).json({ data: signed });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/consents/:consentId',
    requireAuth,
    requireActiveTenant,
    requireOperation('documents.read'),
    async (req, res, next) => {
      try {
        const data = await getConsentWithEvidence(
          req.actor!.activeTenantId!,
          req.params.consentId!,
          pool,
        );
        res.json({ data });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
