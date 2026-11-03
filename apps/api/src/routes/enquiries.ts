import { Router } from 'express';
import { z } from 'zod';
import type { DbPool } from '../../../../platform/db/src/index.js';
import {
  createAuthMiddleware,
  requireActiveTenant,
  requireOperation,
} from '../../../../platform/auth/src/index.js';
import {
  listEnquiries,
  createEnquiry,
  updateEnquiryStatus,
  createEnrolment,
  listEnrolments,
  endEnrolment,
} from '../../../../modules/core/src/index.js';

export function enquiriesRoutes(pool: DbPool): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(pool);

  router.get(
    '/enquiries',
    requireAuth,
    requireActiveTenant,
    requireOperation('enquiries.manage'),
    async (req, res, next) => {
      try {
        const rows = await listEnquiries(
          {
            tenantId: req.actor!.activeTenantId!,
            status: typeof req.query.status === 'string' ? req.query.status : undefined,
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
    '/enquiries',
    requireAuth,
    requireActiveTenant,
    requireOperation('enquiries.manage'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            site_id: z.string().uuid().optional(),
            child_given_name: z.string().min(1).max(100),
            child_family_name: z.string().min(1).max(100),
            child_date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
            guardian_given_name: z.string().min(1).max(100),
            guardian_family_name: z.string().min(1).max(100),
            guardian_email: z.string().email().optional(),
            guardian_phone_e164: z.string().max(32).optional(),
            notes: z.string().max(2000).optional(),
            source: z.string().max(100).optional(),
          })
          .parse(req.body);
        const created = await createEnquiry(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            siteId: body.site_id,
            childGivenName: body.child_given_name,
            childFamilyName: body.child_family_name,
            childDateOfBirth: body.child_date_of_birth,
            guardianGivenName: body.guardian_given_name,
            guardianFamilyName: body.guardian_family_name,
            guardianEmail: body.guardian_email,
            guardianPhoneE164: body.guardian_phone_e164,
            notes: body.notes,
            source: body.source,
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

  router.patch(
    '/enquiries/:enquiryId',
    requireAuth,
    requireActiveTenant,
    requireOperation('enquiries.manage'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            status: z.enum([
              'open',
              'waiting',
              'offered',
              'accepted',
              'declined',
              'withdrawn',
              'enrolled',
            ]),
          })
          .parse(req.body);
        const updated = await updateEnquiryStatus(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            enquiryId: req.params.enquiryId!,
            status: body.status,
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

  router.get(
    '/enrolments',
    requireAuth,
    requireActiveTenant,
    requireOperation('enrolments.manage'),
    async (req, res, next) => {
      try {
        const rows = await listEnrolments(
          {
            tenantId: req.actor!.activeTenantId!,
            childId: typeof req.query.child_id === 'string' ? req.query.child_id : undefined,
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
    '/enrolments',
    requireAuth,
    requireActiveTenant,
    requireOperation('enrolments.manage'),
    async (req, res, next) => {
      try {
        const body = z
          .object({
            site_id: z.string().uuid(),
            child_id: z.string().uuid(),
            enquiry_id: z.string().uuid().optional(),
            start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
            status: z.enum(['pending', 'active', 'paused', 'ended', 'cancelled']).optional(),
          })
          .parse(req.body);
        const created = await createEnrolment(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            siteId: body.site_id,
            childId: body.child_id,
            enquiryId: body.enquiry_id,
            startDate: body.start_date,
            endDate: body.end_date,
            status: body.status,
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
    '/enrolments/:enrolmentId/end',
    requireAuth,
    requireActiveTenant,
    requireOperation('enrolments.manage'),
    async (req, res, next) => {
      try {
        const body = z
          .object({ end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
          .parse(req.body);
        const updated = await endEnrolment(
          {
            tenantId: req.actor!.activeTenantId!,
            actorUserId: req.actor!.userId,
            enrolmentId: req.params.enrolmentId!,
            endDate: body.end_date,
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

  return router;
}
