import { Router } from 'express';
import { z } from 'zod';
import type { DbPool } from '../../../../platform/db/src/index.js';
import {
  createAuthMiddleware,
  requireActiveTenant,
  requireOperation,
} from '../../../../platform/auth/src/index.js';
import {
  getCurrentTenant,
  updateCurrentTenant,
  listSites,
  createSite,
  getSite,
  listMemberships,
  revokeMembership,
} from '../../../../platform/tenancy/src/index.js';
import { createInvitation, acceptInvitation } from '../../../../platform/auth/src/index.js';
import { withTenant } from '../../../../platform/db/src/index.js';
import { writeAudit } from '../../../../platform/audit/src/index.js';
import { assertOperation } from '../../../../platform/authz/src/index.js';
import { randomBytes, createHash } from 'node:crypto';
import { notFound } from '../../../../platform/http/src/errors.js';

export function tenantRoutes(pool: DbPool): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(pool);

  router.get(
    '/tenants/current',
    requireAuth,
    requireActiveTenant,
    requireOperation('tenant.read'),
    async (req, res, next) => {
      try {
        const tenant = await getCurrentTenant(req.actor!.activeTenantId!, pool);
        res.json({ data: tenant });
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    '/tenants/current',
    requireAuth,
    requireActiveTenant,
    requireOperation('tenant.update'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            display_name: z.string().min(1).max(200).optional(),
            primary_timezone: z.string().min(1).max(100).optional(),
          })
          .parse(req.body);
        const tenant = await updateCurrentTenant(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            displayName: body.display_name,
            primaryTimezone: body.primary_timezone,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.json({ data: tenant });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/sites',
    requireAuth,
    requireActiveTenant,
    requireOperation('site.read'),
    async (req, res, next) => {
      try {
        const sites = await listSites(req.actor!.activeTenantId!, pool);
        res.json({ data: sites, next_cursor: null });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/sites',
    requireAuth,
    requireActiveTenant,
    requireOperation('site.create'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            name: z.string().min(1).max(200),
            timezone: z.string().min(1).max(100).optional(),
            is_primary: z.boolean().optional(),
          })
          .parse(req.body);
        const site = await createSite(
          {
            tenantId: req.actor!.activeTenantId!,
            name: body.name,
            timezone: body.timezone,
            isPrimary: body.is_primary,
            actorUserId: req.actor!.userId,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.status(201).json({ data: site });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/sites/:siteId',
    requireAuth,
    requireActiveTenant,
    requireOperation('site.read'),
    async (req, res, next) => {
      try {
        const site = await getSite(req.actor!.activeTenantId!, req.params.siteId!, pool);
        res.json({ data: site });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/memberships',
    requireAuth,
    requireActiveTenant,
    requireOperation('membership.read'),
    async (req, res, next) => {
      try {
        const rows = await listMemberships(req.actor!.activeTenantId!, pool);
        res.json({ data: rows, next_cursor: null });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/memberships/invitations',
    requireAuth,
    requireActiveTenant,
    requireOperation('membership.invite'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            email: z.string().email(),
            role_template: z.string().min(1),
          })
          .parse(req.body);
        const invite = await createInvitation({
          tenantId: req.actor!.activeTenantId!,
          email: body.email,
          roleTemplate: body.role_template,
          invitedByUserId: req.actor!.userId,
          correlationId: req.correlationId,
          pool,
        });
        res.status(201).json({
          data: {
            id: invite.id,
            expires_at: invite.expiresAt.toISOString(),
            // token returned once for synthetic/dev flows
            token: invite.token,
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/memberships/invitations/:id/accept',
    requireAuth,
    async (req, res, next) => {
      try {
        const body = z
          .object({
            tenant_id: z.string().uuid(),
            token: z.string().min(1),
          })
          .parse(req.body);
        await acceptInvitation({
          invitationId: req.params.id!,
          token: body.token,
          tenantId: body.tenant_id,
          userId: req.actor!.userId,
          pool,
        });
        res.json({ data: { accepted: true } });
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    '/memberships/:id',
    requireAuth,
    requireActiveTenant,
    requireOperation('membership.revoke'),
    async (req, res, next) => {
      try {
        await revokeMembership({
          tenantId: req.actor!.activeTenantId!,
          membershipId: req.params.id!,
          actorUserId: req.actor!.userId,
          correlationId: req.correlationId,
          pool,
        });
        res.status(204).send();
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/integration-clients',
    requireAuth,
    requireActiveTenant,
    requireOperation('integration_client.manage'),
    async (req, res, next) => {
      try {
        const rows = await withTenant(req.actor!.activeTenantId!, async (db) => {
          const r = await db.query(
            `SELECT id, name, scopes, expires_at, revoked_at, created_at
             FROM integration_clients ORDER BY created_at`,
          );
          return r.rows;
        }, pool);
        res.json({ data: rows, next_cursor: null });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/integration-clients',
    requireAuth,
    requireActiveTenant,
    requireOperation('integration_client.manage'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            name: z.string().min(1).max(200),
            scopes: z.array(z.string()).default([]),
          })
          .parse(req.body);
        const secret = randomBytes(32).toString('base64url');
        const secretHash = createHash('sha256').update(secret).digest('hex');
        const created = await withTenant(req.actor!.activeTenantId!, async (db) => {
          const r = await db.query<{ id: string }>(
            `INSERT INTO integration_clients (tenant_id, name, secret_hash, scopes)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [req.actor!.activeTenantId, body.name, secretHash, body.scopes],
          );
          await writeAudit(db, {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            action: 'integration_client.create',
            entityType: 'integration_client',
            entityId: r.rows[0]!.id,
            correlationId: req.correlationId,
          });
          return r.rows[0]!;
        }, pool);
        res.status(201).json({
          data: {
            id: created.id,
            secret: `client_${created.id}.${secret}`,
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/integration-clients/:id/revoke',
    requireAuth,
    requireActiveTenant,
    requireOperation('integration_client.manage'),
    async (req, res, next) => {
      try {
        await withTenant(req.actor!.activeTenantId!, async (db) => {
          const r = await db.query(
            `UPDATE integration_clients SET revoked_at = now()
             WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
            [req.params.id],
          );
          if (r.rowCount === 0) throw notFound('Client not found');
          await writeAudit(db, {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            action: 'integration_client.revoke',
            entityType: 'integration_client',
            entityId: req.params.id,
            correlationId: req.correlationId,
          });
        }, pool);
        res.status(204).send();
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/audit-events',
    requireAuth,
    requireActiveTenant,
    requireOperation('audit.read'),
    async (req, res, next) => {
      try {
        const limit = Math.min(Number(req.query.limit ?? 25), 100);
        const rows = await withTenant(req.actor!.activeTenantId!, async (db) => {
          const r = await db.query(
            `SELECT id, action, entity_type, entity_id, actor_user_id, occurred_at, reason
             FROM audit_events
             ORDER BY occurred_at DESC
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

  void assertOperation;
  return router;
}
