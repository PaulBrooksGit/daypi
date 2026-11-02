import { Router } from 'express';
import { z } from 'zod';
import type { DbPool } from '../../../../platform/db/src/index.js';
import {
  loginWithPassword,
  logout,
  selectTenant,
  requestPasswordRecovery,
  createAuthMiddleware,
} from '../../../../platform/auth/src/index.js';
import type { AppConfig } from '../../../../platform/config/src/index.js';
import { getPool, withTenant } from '../../../../platform/db/src/index.js';

export function authRoutes(pool: DbPool, config: AppConfig): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(pool);

  router.post('/auth/login', async (req, res, next) => {
    try {
      const body = z
        .object({
          email: z.string().email(),
          password: z.string().min(8),
        })
        .parse(req.body);

      const result = await loginWithPassword(
        {
          email: body.email,
          password: body.password,
          userAgent: req.get('user-agent') ?? undefined,
          ip: req.ip,
          correlationId: req.correlationId,
        },
        pool,
      );

      res.cookie('daypi_session', result.token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.COOKIE_SECURE,
        path: '/',
        expires: result.expiresAt,
      });

      res.json({
        data: {
          user: result.user,
          mfa_required: result.mfaRequired,
          expires_at: result.expiresAt.toISOString(),
          // Bearer also returned for API clients / tests
          access_token: result.token,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/auth/mfa/verify', requireAuth, async (req, res, next) => {
    try {
      // Phase 0 stub: accept code "000000" only when MFA is enabled on the user.
      const body = z.object({ code: z.string().min(6).max(8) }).parse(req.body);
      const user = await pool.query<{ mfa_enabled: boolean }>(
        `SELECT mfa_enabled FROM users WHERE id = $1`,
        [req.actor!.userId],
      );
      if (!user.rows[0]?.mfa_enabled) {
        res.json({ data: { verified: true, skipped: true } });
        return;
      }
      if (body.code !== '000000') {
        res.status(401).json({ error: { code: 'MFA_INVALID', message: 'Invalid MFA code' } });
        return;
      }
      res.json({ data: { verified: true } });
    } catch (err) {
      next(err);
    }
  });

  router.post('/auth/logout', requireAuth, async (req, res, next) => {
    try {
      await logout(req.actor!.sessionToken, pool);
      res.clearCookie('daypi_session', { path: '/' });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  router.post('/auth/password/recover', async (req, res, next) => {
    try {
      const body = z.object({ email: z.string().email() }).parse(req.body);
      await requestPasswordRecovery({
        email: body.email,
        correlationId: req.correlationId,
        pool,
      });
      res.json({ data: { ok: true } });
    } catch (err) {
      next(err);
    }
  });

  router.get('/auth/me', requireAuth, async (req, res, next) => {
    try {
      const memberships = await pool.query(
        `SELECT m.id, m.tenant_id, m.role_template, m.status, t.display_name
         FROM memberships m
         JOIN tenants t ON t.id = m.tenant_id
         WHERE m.user_id = $1 AND m.status = 'active'
         ORDER BY t.display_name`,
        [req.actor!.userId],
      );
      // memberships is RLS-protected — this query on bare pool will return ZERO rows!
      // Need a SECURITY DEFINER function OR disable RLS for memberships SELECT by user_id.
      // Fix: migration helper list_memberships_for_user.
      void memberships;
      const listed = await pool.query(
        `SELECT * FROM list_memberships_for_user($1)`,
        [req.actor!.userId],
      );

      res.json({
        data: {
          id: req.actor!.userId,
          email: req.actor!.email,
          active_tenant_id: req.actor!.activeTenantId,
          memberships: listed.rows,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/auth/tenant/select', requireAuth, async (req, res, next) => {
    try {
      const body = z.object({ tenant_id: z.string().uuid() }).parse(req.body);
      await selectTenant({
        token: req.actor!.sessionToken,
        tenantId: body.tenant_id,
        correlationId: req.correlationId,
        pool,
      });
      res.json({ data: { active_tenant_id: body.tenant_id } });
    } catch (err) {
      next(err);
    }
  });

  void getPool;
  void withTenant;
  return router;
}
