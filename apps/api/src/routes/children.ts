import { Router } from 'express';
import { z } from 'zod';
import type { DbPool } from '../../../../platform/db/src/index.js';
import {
  createAuthMiddleware,
  requireActiveTenant,
  requireOperation,
} from '../../../../platform/auth/src/index.js';
import { withTenant } from '../../../../platform/db/src/index.js';
import { writeAudit } from '../../../../platform/audit/src/index.js';
import { notFound, forbidden } from '../../../../platform/http/src/errors.js';
import { updateChild, archiveChild } from '../../../../modules/core/src/index.js';


export function childrenRoutes(pool: DbPool): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(pool);

  router.get(
    '/children',
    requireAuth,
    requireActiveTenant,
    requireOperation('children.read'),
    async (req, res, next) => {
      try {
        const tenantId = req.actor!.activeTenantId!;
        const limit = Math.min(Number(req.query.limit ?? 25), 100);

        const rows = await withTenant(tenantId, async (db) => {
          const role = req.actor!.subject?.roleTemplate;
          if (role === 'parent') {
            const r = await db.query(
              `SELECT c.id, c.tenant_id, c.given_name, c.family_name, c.preferred_name,
                      c.date_of_birth, c.enrolment_status
               FROM children c
               JOIN child_guardian_relationships rel
                 ON rel.tenant_id = c.tenant_id AND rel.child_id = c.id
               JOIN guardians g
                 ON g.tenant_id = rel.tenant_id AND g.id = rel.guardian_id
               WHERE g.user_id = $1
                 AND rel.revoked_at IS NULL
                 AND rel.access_level IN ('full', 'limited')
                 AND c.deleted_at IS NULL
               ORDER BY c.family_name, c.given_name
               LIMIT $2`,
              [req.actor!.userId, limit],
            );
            return r.rows;
          }

          const r = await db.query(
            `SELECT id, tenant_id, given_name, family_name, preferred_name,
                    date_of_birth, enrolment_status
             FROM children
             WHERE deleted_at IS NULL
             ORDER BY family_name, given_name
             LIMIT $1`,
            [limit],
          );
          return r.rows;
        }, pool);

        res.json({ data: rows, next_cursor: null });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/children/:childId',
    requireAuth,
    requireActiveTenant,
    requireOperation('children.read'),
    async (req, res, next) => {
      try {
        const tenantId = req.actor!.activeTenantId!;
        const childId = req.params.childId!;

        const child = await withTenant(tenantId, async (db) => {
          if (req.actor!.subject?.roleTemplate === 'parent') {
            const access = await db.query(
              `SELECT 1
               FROM child_guardian_relationships rel
               JOIN guardians g ON g.tenant_id = rel.tenant_id AND g.id = rel.guardian_id
               WHERE rel.child_id = $1 AND g.user_id = $2
                 AND rel.revoked_at IS NULL
                 AND rel.access_level IN ('full', 'limited')`,
              [childId, req.actor!.userId],
            );
            if (access.rowCount === 0) throw forbidden('No access to this child');
          }

          const r = await db.query(
            `SELECT id, tenant_id, given_name, family_name, preferred_name,
                    date_of_birth, enrolment_status
             FROM children WHERE id = $1 AND deleted_at IS NULL`,
            [childId],
          );
          const row = r.rows[0];
          if (!row) throw notFound('Child not found');
          return row;
        }, pool);

        res.json({ data: child });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/children',
    requireAuth,
    requireActiveTenant,
    requireOperation('children.create'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            given_name: z.string().min(1).max(100),
            family_name: z.string().min(1).max(100),
            preferred_name: z.string().max(100).optional(),
            date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            enrolment_status: z
              .enum(['lead', 'waiting', 'active', 'graduated', 'withdrawn'])
              .optional(),
            // Intentionally ignored if present — tenant comes from session only
            tenant_id: z.string().uuid().optional(),
          })
          .parse(req.body);

        const tenantId = req.actor!.activeTenantId!;
        if (body.tenant_id && body.tenant_id !== tenantId) {
          throw forbidden('tenant_id in body is not authoritative');
        }

        const created = await withTenant(tenantId, async (db) => {
          const r = await db.query(
            `INSERT INTO children (
               tenant_id, given_name, family_name, preferred_name, date_of_birth, enrolment_status
             ) VALUES ($1,$2,$3,$4,$5,$6)
             RETURNING id, tenant_id, given_name, family_name, preferred_name,
                       date_of_birth, enrolment_status`,
            [
              tenantId,
              body.given_name,
              body.family_name,
              body.preferred_name ?? null,
              body.date_of_birth,
              body.enrolment_status ?? 'lead',
            ],
          );
          await writeAudit(db, {
            tenantId,
            actorUserId: req.actor!.userId,
            action: 'children.create',
            entityType: 'child',
            entityId: r.rows[0]!.id as string,
            correlationId: req.correlationId,
          });
          return r.rows[0];
        }, pool);

        res.status(201).json({ data: created });
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    '/children/:childId',
    requireAuth,
    requireActiveTenant,
    requireOperation('children.update'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            given_name: z.string().min(1).max(100).optional(),
            family_name: z.string().min(1).max(100).optional(),
            preferred_name: z.string().max(100).nullable().optional(),
            enrolment_status: z
              .enum(['lead', 'waiting', 'active', 'graduated', 'withdrawn'])
              .optional(),
            version: z.number().int().positive().optional(),
          })
          .parse(req.body);
        const updated = await updateChild(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            childId: req.params.childId!,
            givenName: body.given_name,
            familyName: body.family_name,
            preferredName: body.preferred_name,
            enrolmentStatus: body.enrolment_status,
            expectedVersion: body.version,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.json({ data: updated });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/children/:childId/archive',
    requireAuth,
    requireActiveTenant,
    requireOperation('children.archive'),
    async (req, res, next) => {
      try {
        const archived = await archiveChild(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            childId: req.params.childId!,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.json({ data: archived });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
