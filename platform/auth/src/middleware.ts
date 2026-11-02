import type { Request, Response, NextFunction } from 'express';
import type { DbPool } from '../../db/src/pool.js';
import { getPool, withTenant } from '../../db/src/index.js';
import { unauthorized, forbidden } from '../../http/src/errors.js';
import { findSessionByToken } from './sessions.js';
import { createHash } from 'node:crypto';
import type { AuthzSubject } from '../../authz/src/authorize.js';
import { assertOperation, type Operation } from '../../authz/src/index.js';

export interface RequestActor {
  userId: string;
  email: string;
  sessionId: string;
  sessionToken: string;
  activeTenantId: string | null;
  mfaEnabled?: boolean;
  clientId?: string;
  subject?: AuthzSubject;
}

declare module 'express-serve-static-core' {
  interface Request {
    actor?: RequestActor;
  }
}

function extractBearerOrCookie(req: Request): string | null {
  const header = req.header('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  const cookie = req.cookies?.daypi_session as string | undefined;
  return cookie ?? null;
}

export function createAuthMiddleware(pool: DbPool = getPool()) {
  return async function authMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const token = extractBearerOrCookie(req);
      if (!token) {
        next(unauthorized());
        return;
      }

      // Integration client tokens: "client_<id>.<secret>"
      if (token.startsWith('client_')) {
        const actor = await resolveIntegrationClient(token, pool);
        req.actor = actor;
        next();
        return;
      }

      const session = await findSessionByToken(token, pool);
      if (!session) {
        next(unauthorized());
        return;
      }

      req.actor = {
        userId: session.user_id,
        email: session.email,
        sessionId: session.id,
        sessionToken: token,
        activeTenantId: session.active_tenant_id,
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}

async function resolveIntegrationClient(
  token: string,
  pool: DbPool,
): Promise<RequestActor> {
  const withoutPrefix = token.slice('client_'.length);
  const dot = withoutPrefix.indexOf('.');
  if (dot <= 0) throw unauthorized('Invalid client token');
  const clientId = withoutPrefix.slice(0, dot);
  const secret = withoutPrefix.slice(dot + 1);
  const secretHash = createHash('sha256').update(secret).digest('hex');

  // Look up client without tenant context — need tenant_id from row then withTenant
  // integration_clients is RLS-protected, so we cannot read without tenant.
  // Store a lookup table approach: use migrator? Better: add client_id unique global
  // and a SECURITY DEFINER function for credential verification.
  // Phase 0 pragmatic approach: verify via SECURITY DEFINER helper created in migration 007.

  const res = await pool.query<{
    id: string;
    tenant_id: string;
    secret_hash: string;
    scopes: string[];
    revoked_at: Date | null;
    expires_at: Date | null;
  }>(`SELECT * FROM verify_integration_client($1, $2)`, [clientId, secretHash]);

  const row = res.rows[0];
  if (!row) throw unauthorized('Invalid client credentials');
  if (row.revoked_at) throw unauthorized('Client revoked');
  if (row.expires_at && row.expires_at.getTime() < Date.now()) {
    throw unauthorized('Client expired');
  }

  return {
    userId: `client:${row.id}`,
    email: '',
    sessionId: row.id,
    sessionToken: token,
    activeTenantId: row.tenant_id,
    clientId: row.id,
    subject: {
      kind: 'integration_client',
      tenantId: row.tenant_id,
      integrationClientId: row.id,
      scopes: row.scopes,
    },
  };
}

export function requireActiveTenant(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (!req.actor?.activeTenantId) {
    next(forbidden('Select a tenant workspace first'));
    return;
  }
  next();
}

export function requireOperation(operation: Operation) {
  return async function operationGuard(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const actor = req.actor;
      if (!actor?.activeTenantId) {
        next(forbidden('Select a tenant workspace first'));
        return;
      }

      await withTenant(actor.activeTenantId, async (db) => {
        let subject = actor.subject;
        if (!subject) {
          const mem = await db.query<{ id: string; role_template: string }>(
            `SELECT id, role_template FROM memberships
             WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`,
            [actor.activeTenantId, actor.userId],
          );
          const membership = mem.rows[0];
          if (!membership) throw forbidden('Not a member of this tenant');
          subject = {
            kind: 'membership',
            tenantId: actor.activeTenantId!,
            membershipId: membership.id,
            roleTemplate: membership.role_template,
          };
          actor.subject = subject;
        }
        await assertOperation(db, subject, operation);
      });
      next();
    } catch (err) {
      next(err);
    }
  };
}
