import type { DbClient } from '../../db/src/pool.js';

export interface OutboxWrite {
  tenantId: string | null;
  aggregateType: string;
  aggregateId?: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  availableAt?: Date;
}

export async function enqueueOutbox(db: DbClient, event: OutboxWrite): Promise<string> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO outbox_events (
       tenant_id, aggregate_type, aggregate_id, event_type, payload, available_at
     ) VALUES ($1,$2,$3,$4,$5::jsonb,$6)
     RETURNING id`,
    [
      event.tenantId,
      event.aggregateType,
      event.aggregateId ?? null,
      event.eventType,
      JSON.stringify(event.payload),
      event.availableAt ?? new Date(),
    ],
  );
  return res.rows[0]!.id;
}

export interface ClaimedOutboxEvent {
  id: string;
  tenant_id: string | null;
  aggregate_type: string;
  aggregate_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  attempt_count: number;
}

/** Claim a batch of pending outbox rows via SECURITY DEFINER helper. */
export async function claimOutboxBatch(
  db: DbClient,
  limit = 10,
): Promise<ClaimedOutboxEvent[]> {
  const res = await db.query<ClaimedOutboxEvent>(`SELECT * FROM claim_outbox_batch($1)`, [limit]);
  return res.rows.map((row) => ({
    ...row,
    payload:
      typeof row.payload === 'string'
        ? (JSON.parse(row.payload) as Record<string, unknown>)
        : row.payload,
  }));
}

export async function markOutboxDone(db: DbClient, id: string): Promise<void> {
  await db.query(`SELECT complete_outbox_event($1, true, NULL, 8)`, [id]);
}

export async function markOutboxRetry(
  db: DbClient,
  id: string,
  errorSummary: string,
  _attemptNo: number,
  maxAttempts = 8,
): Promise<void> {
  await db.query(`SELECT complete_outbox_event($1, false, $2, $3)`, [
    id,
    errorSummary.slice(0, 500),
    maxAttempts,
  ]);
}

export async function recordJobAttempt(
  db: DbClient,
  outboxEventId: string,
  attemptNo: number,
  errorSummary?: string | null,
): Promise<void> {
  await db.query(`SELECT record_job_attempt_row($1, $2, $3)`, [
    outboxEventId,
    attemptNo,
    errorSummary ?? null,
  ]);
}
