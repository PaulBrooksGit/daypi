import { createHash, randomUUID } from 'node:crypto';
import type { DbClient, DbPool } from '../../../platform/db/src/pool.js';
import { withTenant } from '../../../platform/db/src/index.js';
import { writeAudit } from '../../../platform/audit/src/index.js';
import { enqueueOutbox } from '../../../platform/jobs/src/index.js';
import { notFound, validationError } from '../../../platform/http/src/errors.js';
import {
  reserveUsage,
  settleReservedUsage,
} from '../../finance/src/usage-ledger.js';

export interface MessageRow {
  id: string;
  tenant_id: string;
  channel: string;
  purpose: string;
  subject: string | null;
  body: string;
  status: string;
  estimated_segments: number;
  estimated_cost_minor: number;
  actual_cost_minor: number | null;
  provider: string;
  provider_message_sid: string | null;
  idempotency_key: string;
  created_at: Date;
}

export interface MessageRecipientRow {
  id: string;
  tenant_id: string;
  message_id: string;
  guardian_id: string | null;
  phone_e164: string | null;
  email: string | null;
  delivery_status: string;
  skip_reason: string | null;
}

function estimateSmsSegments(body: string): number {
  // GSM-7 rough estimate; UCS-2 would differ — configurable later.
  const len = body.length;
  if (len <= 160) return 1;
  return Math.ceil(len / 153);
}

export async function createAndQueueMessage(
  input: {
    tenantId: string;
    actorUserId: string;
    channel: 'sms' | 'email';
    purpose: 'transactional' | 'marketing';
    body: string;
    subject?: string;
    guardianIds: string[];
    idempotencyKey: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<{
  message: MessageRow;
  recipients: MessageRecipientRow[];
  estimate: { segments: number; cost_minor: number; currency: string };
}> {
  if (!input.body.trim()) throw validationError('body required');
  if (!input.guardianIds.length) throw validationError('at least one recipient required');

  return withTenant(input.tenantId, async (db) => {
    const existing = await db.query<MessageRow>(
      `SELECT id, tenant_id, channel, purpose, subject, body, status,
              estimated_segments, estimated_cost_minor, actual_cost_minor,
              provider, provider_message_sid, idempotency_key, created_at
       FROM messages WHERE idempotency_key = $1`,
      [input.idempotencyKey],
    );
    if (existing.rows[0]) {
      const recipients = await db.query<MessageRecipientRow>(
        `SELECT id, tenant_id, message_id, guardian_id, phone_e164, email,
                delivery_status, skip_reason
         FROM message_recipients WHERE message_id = $1`,
        [existing.rows[0].id],
      );
      return {
        message: existing.rows[0],
        recipients: recipients.rows,
        estimate: {
          segments: existing.rows[0].estimated_segments,
          cost_minor: existing.rows[0].estimated_cost_minor,
          currency: 'GBP',
        },
      };
    }

    await db.query(
      `INSERT INTO messaging_rate_config (tenant_id)
       VALUES ($1) ON CONFLICT DO NOTHING`,
      [input.tenantId],
    );
    const rate = await db.query<{ sms_segment_cost_minor: number; currency: string }>(
      `SELECT sms_segment_cost_minor, currency FROM messaging_rate_config WHERE tenant_id = $1`,
      [input.tenantId],
    );
    const segmentCost = rate.rows[0]?.sms_segment_cost_minor ?? 4;
    const currency = rate.rows[0]?.currency ?? 'GBP';
    const segments =
      input.channel === 'sms' ? estimateSmsSegments(input.body) : 1;
    const costMinor =
      input.channel === 'sms' ? segments * segmentCost * input.guardianIds.length : 0;

    const reserveKey = `msg_reserve:${input.idempotencyKey}`;
    if (costMinor > 0) {
      await reserveUsage(db, {
        tenantId: input.tenantId,
        amountMinor: costMinor,
        idempotencyKey: reserveKey,
        referenceType: 'message',
      });
    }

    const provider = input.channel === 'sms' ? 'twilio_sandbox' : 'email_sandbox';
    const msg = await db.query<MessageRow>(
      `INSERT INTO messages (
         tenant_id, channel, purpose, subject, body, status,
         estimated_segments, estimated_cost_minor, usage_reservation_key,
         provider, idempotency_key, created_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,'queued',$6,$7,$8,$9,$10,$11)
       RETURNING id, tenant_id, channel, purpose, subject, body, status,
                 estimated_segments, estimated_cost_minor, actual_cost_minor,
                 provider, provider_message_sid, idempotency_key, created_at`,
      [
        input.tenantId,
        input.channel,
        input.purpose,
        input.subject ?? null,
        input.body,
        segments,
        costMinor,
        costMinor > 0 ? reserveKey : null,
        provider,
        input.idempotencyKey,
        input.actorUserId,
      ],
    );

    const recipients: MessageRecipientRow[] = [];
    for (const guardianId of input.guardianIds) {
      const g = await db.query<{
        id: string;
        phone_e164: string | null;
        email: string | null;
        marketing_sms_opt_in: boolean;
        marketing_email_opt_in: boolean;
        sms_opted_out_at: Date | null;
      }>(
        `SELECT id, phone_e164, email, marketing_sms_opt_in, marketing_email_opt_in, sms_opted_out_at
         FROM guardians WHERE id = $1 AND deleted_at IS NULL`,
        [guardianId],
      );
      const guardian = g.rows[0];
      if (!guardian) throw notFound(`Guardian ${guardianId} not found`);

      let deliveryStatus = 'queued';
      let skipReason: string | null = null;

      if (input.purpose === 'marketing') {
        if (input.channel === 'sms') {
          if (!guardian.marketing_sms_opt_in || guardian.sms_opted_out_at) {
            deliveryStatus = 'skipped';
            skipReason = 'marketing_sms_opt_out';
          }
        } else if (!guardian.marketing_email_opt_in) {
          deliveryStatus = 'skipped';
          skipReason = 'marketing_email_opt_out';
        }
      }

      if (input.channel === 'sms' && deliveryStatus === 'queued' && !guardian.phone_e164) {
        deliveryStatus = 'skipped';
        skipReason = 'missing_phone';
      }
      if (input.channel === 'email' && deliveryStatus === 'queued' && !guardian.email) {
        deliveryStatus = 'skipped';
        skipReason = 'missing_email';
      }

      const r = await db.query<MessageRecipientRow>(
        `INSERT INTO message_recipients (
           tenant_id, message_id, guardian_id, phone_e164, email, delivery_status, skip_reason
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, tenant_id, message_id, guardian_id, phone_e164, email,
                   delivery_status, skip_reason`,
        [
          input.tenantId,
          msg.rows[0]!.id,
          guardianId,
          guardian.phone_e164,
          guardian.email,
          deliveryStatus,
          skipReason,
        ],
      );
      recipients.push(r.rows[0]!);
    }

    await enqueueOutbox(db, {
      tenantId: input.tenantId,
      aggregateType: 'message',
      aggregateId: msg.rows[0]!.id,
      eventType: 'messages.send_sandbox',
      payload: { messageId: msg.rows[0]!.id },
    });

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action:
        input.purpose === 'marketing'
          ? 'messages.marketing.send'
          : 'messages.transactional.send',
      entityType: 'message',
      entityId: msg.rows[0]!.id,
      correlationId: input.correlationId,
      metadata: {
        channel: input.channel,
        purpose: input.purpose,
        estimated_cost_minor: costMinor,
      },
    });

    return {
      message: msg.rows[0]!,
      recipients,
      estimate: { segments, cost_minor: costMinor, currency },
    };
  }, pool);
}

/** Sandbox send: mark queued recipients sent and settle usage reservation. */
export async function processSandboxSend(
  input: { tenantId: string; messageId: string },
  pool: DbPool,
): Promise<MessageRow> {
  return withTenant(input.tenantId, async (db) => {
    return sendMessageInTx(db, input);
  }, pool);
}

export async function sendMessageInTx(
  db: DbClient,
  input: { tenantId: string; messageId: string },
): Promise<MessageRow> {
  const msg = await db.query<MessageRow & { usage_reservation_key: string | null }>(
    `SELECT id, tenant_id, channel, purpose, subject, body, status,
            estimated_segments, estimated_cost_minor, actual_cost_minor,
            provider, provider_message_sid, idempotency_key, created_at,
            usage_reservation_key
     FROM messages WHERE id = $1 FOR UPDATE`,
    [input.messageId],
  );
  const row = msg.rows[0];
  if (!row) throw notFound('Message not found');
  if (row.status !== 'queued' && row.status !== 'sending') {
    return row;
  }

  await db.query(`UPDATE messages SET status = 'sending', updated_at = now() WHERE id = $1`, [
    input.messageId,
  ]);

  const sid = `SM_sandbox_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const recipients = await db.query<{ id: string; delivery_status: string }>(
    `SELECT id, delivery_status FROM message_recipients WHERE message_id = $1`,
    [input.messageId],
  );

  let sentCount = 0;
  for (const r of recipients.rows) {
    if (r.delivery_status === 'skipped') continue;
    await db.query(
      `UPDATE message_recipients
       SET delivery_status = 'sent', provider_recipient_sid = $2, updated_at = now()
       WHERE id = $1`,
      [r.id, `${sid}_${r.id.slice(0, 8)}`],
    );
    sentCount += 1;
  }

  const segmentCost =
    row.estimated_segments > 0 && row.estimated_cost_minor > 0
      ? Math.round(row.estimated_cost_minor / Math.max(recipients.rows.length, 1))
      : 0;
  const actualCost = segmentCost * sentCount;

  if (row.usage_reservation_key && row.estimated_cost_minor > 0) {
    await settleReservedUsage(db, {
      tenantId: input.tenantId,
      reservedMinor: row.estimated_cost_minor,
      actualMinor: actualCost,
      releaseAllKey: `${row.usage_reservation_key}:release`,
      chargeKey: `${row.usage_reservation_key}:charge`,
      referenceType: 'message',
      referenceId: row.id,
    });
  }

  const updated = await db.query<MessageRow>(
    `UPDATE messages
     SET status = 'sent', provider_message_sid = $2, actual_cost_minor = $3, updated_at = now()
     WHERE id = $1
     RETURNING id, tenant_id, channel, purpose, subject, body, status,
               estimated_segments, estimated_cost_minor, actual_cost_minor,
               provider, provider_message_sid, idempotency_key, created_at`,
    [input.messageId, sid, actualCost],
  );

  return updated.rows[0]!;
}

export async function applyTwilioDeliveryStatus(
  db: DbClient,
  input: {
    tenantId: string;
    messageId: string;
    recipientId?: string;
    providerEventId: string;
    status: string;
    payloadHash: string;
  },
): Promise<void> {
  const existingEvent = await db.query(
    `SELECT id FROM message_delivery_events
     WHERE provider = 'twilio_sandbox' AND provider_event_id = $1`,
    [input.providerEventId],
  );
  if (existingEvent.rowCount) return;

  await db.query(
    `INSERT INTO message_delivery_events (
       tenant_id, message_id, recipient_id, provider, provider_event_id, status, payload_hash
     ) VALUES ($1,$2,$3,'twilio_sandbox',$4,$5,$6)`,
    [
      input.tenantId,
      input.messageId,
      input.recipientId ?? null,
      input.providerEventId,
      input.status,
      input.payloadHash,
    ],
  );

  if (input.recipientId) {
    const mapped =
      input.status === 'delivered'
        ? 'delivered'
        : input.status === 'failed' || input.status === 'undelivered'
          ? input.status
          : null;
    if (mapped) {
      await db.query(
        `UPDATE message_recipients
         SET delivery_status = $2, updated_at = now()
         WHERE id = $1`,
        [input.recipientId, mapped],
      );
    }
  }

  if (input.status === 'delivered') {
    await db.query(
      `UPDATE messages SET status = 'delivered', updated_at = now()
       WHERE id = $1 AND status IN ('sent', 'sending')`,
      [input.messageId],
    );
  }
}

export async function processTwilioSandboxWebhook(
  input: {
    providerEventId: string;
    payload: Record<string, unknown>;
    signatureValid: boolean;
  },
  pool: DbPool,
): Promise<{ duplicate: boolean; status: string }> {
  if (!input.signatureValid) throw validationError('Invalid Twilio webhook signature');

  const payloadHash = createHash('sha256')
    .update(JSON.stringify(input.payload))
    .digest('hex');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const receipt = await client.query<{ id: string; processed_at: Date | null }>(
      `INSERT INTO webhook_receipts (provider, provider_event_id, payload_hash)
       VALUES ('twilio_sandbox', $1, $2)
       ON CONFLICT (provider, provider_event_id) DO UPDATE
         SET payload_hash = webhook_receipts.payload_hash
       RETURNING id, processed_at`,
      [input.providerEventId, payloadHash],
    );

    if (receipt.rows[0]?.processed_at) {
      await client.query('COMMIT');
      return { duplicate: true, status: 'already_processed' };
    }

    const messageSid = String(input.payload.MessageSid ?? input.payload.message_sid ?? '');
    const deliveryStatus = String(input.payload.MessageStatus ?? input.payload.status ?? '');
    if (!messageSid) throw validationError('MessageSid required');

    const msg = await client.query<{ id: string; tenant_id: string }>(
      `SELECT id, tenant_id FROM find_message_by_provider_sid('twilio_sandbox', $1)`,
      [messageSid],
    );
    if (!msg.rows[0]) {
      await client.query('ROLLBACK');
      throw notFound('Message not found for Twilio sid');
    }

    await client.query("SELECT set_config('app.tenant_id', $1, true)", [msg.rows[0].tenant_id]);

    const recipientSid = input.payload.recipient_sid
      ? String(input.payload.recipient_sid)
      : null;
    let recipientId: string | undefined;
    if (recipientSid) {
      const r = await client.query<{ id: string }>(
        `SELECT id FROM message_recipients WHERE provider_recipient_sid = $1`,
        [recipientSid],
      );
      recipientId = r.rows[0]?.id;
    } else {
      const r = await client.query<{ id: string }>(
        `SELECT id FROM message_recipients
         WHERE message_id = $1 AND delivery_status = 'sent'
         ORDER BY created_at LIMIT 1`,
        [msg.rows[0].id],
      );
      recipientId = r.rows[0]?.id;
    }

    await applyTwilioDeliveryStatus(client, {
      tenantId: msg.rows[0].tenant_id,
      messageId: msg.rows[0].id,
      recipientId,
      providerEventId: input.providerEventId,
      status: deliveryStatus,
      payloadHash,
    });

    await client.query(
      `UPDATE webhook_receipts SET processed_at = now() WHERE id = $1`,
      [receipt.rows[0]!.id],
    );
    await client.query('COMMIT');
    return { duplicate: false, status: deliveryStatus };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function getMessage(
  tenantId: string,
  messageId: string,
  pool: DbPool,
): Promise<{ message: MessageRow; recipients: MessageRecipientRow[] }> {
  return withTenant(tenantId, async (db) => {
    const msg = await db.query<MessageRow>(
      `SELECT id, tenant_id, channel, purpose, subject, body, status,
              estimated_segments, estimated_cost_minor, actual_cost_minor,
              provider, provider_message_sid, idempotency_key, created_at
       FROM messages WHERE id = $1`,
      [messageId],
    );
    if (!msg.rows[0]) throw notFound('Message not found');
    const recipients = await db.query<MessageRecipientRow>(
      `SELECT id, tenant_id, message_id, guardian_id, phone_e164, email,
              delivery_status, skip_reason
       FROM message_recipients WHERE message_id = $1`,
      [messageId],
    );
    return { message: msg.rows[0], recipients: recipients.rows };
  }, pool);
}

export async function listMessages(
  tenantId: string,
  limit = 50,
  pool: DbPool,
): Promise<MessageRow[]> {
  return withTenant(tenantId, async (db) => {
    const res = await db.query<MessageRow>(
      `SELECT id, tenant_id, channel, purpose, subject, body, status,
              estimated_segments, estimated_cost_minor, actual_cost_minor,
              provider, provider_message_sid, idempotency_key, created_at
       FROM messages ORDER BY created_at DESC LIMIT $1`,
      [Math.min(limit, 100)],
    );
    return res.rows;
  }, pool);
}
