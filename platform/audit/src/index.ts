import type { DbClient } from '../../db/src/pool.js';

export interface AuditWrite {
  tenantId: string | null;
  actorUserId?: string | null;
  actorClientId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  reason?: string | null;
  correlationId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Append-only audit writer. Call inside the same tenant transaction when tenant-scoped. */
export async function writeAudit(db: DbClient, event: AuditWrite): Promise<void> {
  await db.query(
    `INSERT INTO audit_events (
       tenant_id, actor_user_id, actor_client_id, action,
       entity_type, entity_id, reason, correlation_id, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [
      event.tenantId,
      event.actorUserId ?? null,
      event.actorClientId ?? null,
      event.action,
      event.entityType ?? null,
      event.entityId ?? null,
      event.reason ?? null,
      event.correlationId ?? null,
      JSON.stringify(redactMetadata(event.metadata ?? {})),
    ],
  );
}

function redactMetadata(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    const key = k.toLowerCase();
    if (
      key.includes('password') ||
      key.includes('token') ||
      key.includes('secret') ||
      key.includes('photo') ||
      key.includes('medical')
    ) {
      out[k] = '[redacted]';
    } else {
      out[k] = v;
    }
  }
  return out;
}
