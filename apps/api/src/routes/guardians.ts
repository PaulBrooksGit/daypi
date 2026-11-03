import { Router } from 'express';
import { z } from 'zod';
import type { DbPool } from '../../../../platform/db/src/index.js';
import {
  createAuthMiddleware,
  requireActiveTenant,
  requireOperation,
} from '../../../../platform/auth/src/index.js';
import {
  listGuardians,
  createGuardian,
  getGuardian,
  upsertChildGuardianRelationship,
  revokeChildGuardianRelationship,
} from '../../../../modules/core/src/index.js';

export function guardiansRoutes(pool: DbPool): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(pool);

  router.get(
    '/guardians',
    requireAuth,
    requireActiveTenant,
    requireOperation('guardians.read'),
    async (req, res, next) => {
      try {
        const rows = await listGuardians(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            roleTemplate: req.actor!.subject?.roleTemplate,
            limit: Number(req.query.limit ?? 25),
          },
          pool,
        );
        res.json({ data: rows, next_cursor: null });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/guardians',
    requireAuth,
    requireActiveTenant,
    requireOperation('guardians.create'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            given_name: z.string().min(1).max(100),
            family_name: z.string().min(1).max(100),
            email: z.string().email().optional(),
            phone_e164: z.string().max(32).optional(),
            user_id: z.string().uuid().optional(),
          })
          .parse(req.body);
        const created = await createGuardian(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            givenName: body.given_name,
            familyName: body.family_name,
            email: body.email,
            phoneE164: body.phone_e164,
            userId: body.user_id,
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
    '/guardians/:guardianId',
    requireAuth,
    requireActiveTenant,
    requireOperation('guardians.read'),
    async (req, res, next) => {
      try {
        const row = await getGuardian(
          {
            tenantId: req.actor!.activeTenantId!,
            guardianId: req.params.guardianId!,
            actorUserId: req.actor!.userId,
            roleTemplate: req.actor!.subject?.roleTemplate,
          },
          pool,
        );
        res.json({ data: row });
      } catch (err) {
        next(err);
      }
    },
  );

  router.put(
    '/children/:childId/guardians/:guardianId',
    requireAuth,
    requireActiveTenant,
    requireOperation('relationships.manage'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            relationship: z.string().max(100).optional(),
            has_parental_responsibility: z.boolean().optional(),
            is_billing_contact: z.boolean().optional(),
            is_emergency_contact: z.boolean().optional(),
            is_authorised_collector: z.boolean().optional(),
            access_level: z.enum(['full', 'limited', 'none']).optional(),
          })
          .parse(req.body ?? {});
        const row = await upsertChildGuardianRelationship(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            childId: req.params.childId!,
            guardianId: req.params.guardianId!,
            relationship: body.relationship,
            hasParentalResponsibility: body.has_parental_responsibility,
            isBillingContact: body.is_billing_contact,
            isEmergencyContact: body.is_emergency_contact,
            isAuthorisedCollector: body.is_authorised_collector,
            accessLevel: body.access_level,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.json({ data: row });
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    '/children/:childId/guardians/:guardianId',
    requireAuth,
    requireActiveTenant,
    requireOperation('relationships.manage'),
    async (req, res, next) => {
      try {
        await revokeChildGuardianRelationship(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            childId: req.params.childId!,
            guardianId: req.params.guardianId!,
            correlationId: req.correlationId,
          },
          pool,
        );
        res.status(204).send();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
