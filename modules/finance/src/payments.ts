import { createHash, randomUUID } from 'node:crypto';
import type { DbClient, DbPool } from '../../../platform/db/src/pool.js';
import { withTenant } from '../../../platform/db/src/index.js';
import { writeAudit } from '../../../platform/audit/src/index.js';
import { enqueueOutbox } from '../../../platform/jobs/src/index.js';
import {
  notFound,
  conflict,
  validationError,
  featureDisabled,
} from '../../../platform/http/src/errors.js';
import { appendFinanceLedger } from './invoices.js';

export interface PaymentAttemptRow {
  id: string;
  tenant_id: string;
  invoice_id: string;
  billing_account_id: string;
  amount_minor: number;
  currency: string;
  status: string;
  provider: string;
  provider_payment_intent_id: string | null;
  provider_event_id: string | null;
  idempotency_key: string;
  created_at: Date;
}

/**
 * Create a sandbox payment attempt for an issued invoice.
 * Live Stripe Connect collection remains disabled (D05).
 */
export async function createSandboxPayment(
  input: {
    tenantId: string;
    actorUserId: string;
    invoiceId: string;
    amountMinor?: number;
    idempotencyKey: string;
    stripeLiveEnabled?: boolean;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<PaymentAttemptRow> {
  if (input.stripeLiveEnabled) {
    throw featureDisabled('payments.collect_live');
  }

  return withTenant(input.tenantId, async (db) => {
    const existing = await db.query<PaymentAttemptRow>(
      `SELECT id, tenant_id, invoice_id, billing_account_id, amount_minor, currency,
              status, provider, provider_payment_intent_id, provider_event_id,
              idempotency_key, created_at
       FROM payment_attempts WHERE idempotency_key = $1`,
      [input.idempotencyKey],
    );
    if (existing.rows[0]) return existing.rows[0];

    const inv = await db.query<{
      id: string;
      status: string;
      billing_account_id: string;
      currency: string;
      total_minor: number;
      amount_paid_minor: number;
    }>(
      `SELECT id, status, billing_account_id, currency, total_minor, amount_paid_minor
       FROM invoices WHERE id = $1 FOR UPDATE`,
      [input.invoiceId],
    );
    const invoice = inv.rows[0];
    if (!invoice) throw notFound('Invoice not found');
    if (invoice.status !== 'issued') {
      throw conflict('Payments only allowed against issued invoices');
    }

    const remaining = invoice.total_minor - invoice.amount_paid_minor;
    const amount = input.amountMinor ?? remaining;
    if (amount <= 0) throw validationError('Nothing remaining to pay');
    if (amount > remaining) throw validationError('amount_minor exceeds invoice balance');

    const intentId = `pi_sandbox_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

    const payment = await db.query<PaymentAttemptRow>(
      `INSERT INTO payment_attempts (
         tenant_id, invoice_id, billing_account_id, amount_minor, currency,
         status, provider, provider_payment_intent_id, idempotency_key, created_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,'pending','stripe_sandbox',$6,$7,$8)
       RETURNING id, tenant_id, invoice_id, billing_account_id, amount_minor, currency,
                 status, provider, provider_payment_intent_id, provider_event_id,
                 idempotency_key, created_at`,
      [
        input.tenantId,
        input.invoiceId,
        invoice.billing_account_id,
        amount,
        invoice.currency,
        intentId,
        input.idempotencyKey,
        input.actorUserId,
      ],
    );

    await enqueueOutbox(db, {
      tenantId: input.tenantId,
      aggregateType: 'payment_attempt',
      aggregateId: payment.rows[0]!.id,
      eventType: 'payments.sandbox_intent_created',
      payload: {
        paymentId: payment.rows[0]!.id,
        providerPaymentIntentId: intentId,
      },
    });

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'payments.create_sandbox',
      entityType: 'payment_attempt',
      entityId: payment.rows[0]!.id,
      correlationId: input.correlationId,
      metadata: { amount_minor: amount, provider: 'stripe_sandbox' },
    });

    return payment.rows[0]!;
  }, pool);
}

export async function applySuccessfulPayment(
  db: DbClient,
  input: {
    tenantId: string;
    paymentId: string;
    providerEventId: string;
  },
): Promise<PaymentAttemptRow> {
  const payment = await db.query<PaymentAttemptRow>(
    `SELECT id, tenant_id, invoice_id, billing_account_id, amount_minor, currency,
            status, provider, provider_payment_intent_id, provider_event_id,
            idempotency_key, created_at
     FROM payment_attempts WHERE id = $1 FOR UPDATE`,
    [input.paymentId],
  );
  const row = payment.rows[0];
  if (!row) throw notFound('Payment attempt not found');
  if (row.status === 'succeeded') return row;
  if (row.status !== 'pending') throw conflict(`Payment is ${row.status}`);

  const updated = await db.query<PaymentAttemptRow>(
    `UPDATE payment_attempts
     SET status = 'succeeded', provider_event_id = $2, updated_at = now()
     WHERE id = $1
     RETURNING id, tenant_id, invoice_id, billing_account_id, amount_minor, currency,
               status, provider, provider_payment_intent_id, provider_event_id,
               idempotency_key, created_at`,
    [input.paymentId, input.providerEventId],
  );

  await db.query(
    `INSERT INTO payment_allocations (
       tenant_id, payment_attempt_id, invoice_id, amount_minor
     ) VALUES ($1,$2,$3,$4)
     ON CONFLICT DO NOTHING`,
    [input.tenantId, input.paymentId, row.invoice_id, row.amount_minor],
  );

  await db.query(
    `UPDATE invoices
     SET amount_paid_minor = amount_paid_minor + $2, updated_at = now()
     WHERE id = $1`,
    [row.invoice_id, row.amount_minor],
  );

  await appendFinanceLedger(db, {
    tenantId: input.tenantId,
    billingAccountId: row.billing_account_id,
    amountMinor: -row.amount_minor,
    kind: 'payment',
    referenceType: 'payment_attempt',
    referenceId: row.id,
    idempotencyKey: `payment:${row.id}`,
  });

  await writeAudit(db, {
    tenantId: input.tenantId,
    action: 'payments.succeeded',
    entityType: 'payment_attempt',
    entityId: row.id,
    metadata: {
      provider_event_id: input.providerEventId,
      amount_minor: row.amount_minor,
    },
  });

  return updated.rows[0]!;
}

/**
 * Stripe sandbox webhook: verify + dedupe via webhook_receipts, then settle payment.
 * Replay of the same provider_event_id is a no-op success.
 */
export async function processStripeSandboxWebhook(
  input: {
    providerEventId: string;
    eventType: string;
    payload: Record<string, unknown>;
    signatureValid: boolean;
  },
  pool: DbPool,
): Promise<{ duplicate: boolean; paymentId?: string; status: string }> {
  if (!input.signatureValid) {
    throw validationError('Invalid Stripe webhook signature');
  }

  const payloadHash = createHash('sha256')
    .update(JSON.stringify(input.payload))
    .digest('hex');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const receipt = await client.query<{ id: string; processed_at: Date | null }>(
      `INSERT INTO webhook_receipts (provider, provider_event_id, payload_hash)
       VALUES ('stripe_sandbox', $1, $2)
       ON CONFLICT (provider, provider_event_id) DO UPDATE
         SET payload_hash = webhook_receipts.payload_hash
       RETURNING id, processed_at`,
      [input.providerEventId, payloadHash],
    );

    if (receipt.rows[0]?.processed_at) {
      await client.query('COMMIT');
      return { duplicate: true, status: 'already_processed' };
    }

    // Fresh insert may have null processed_at; conflict on unprocessed also continues once.
    const already = await client.query<{ processed_at: Date | null }>(
      `SELECT processed_at FROM webhook_receipts
       WHERE provider = 'stripe_sandbox' AND provider_event_id = $1`,
      [input.providerEventId],
    );
    if (already.rows[0]?.processed_at) {
      await client.query('COMMIT');
      return { duplicate: true, status: 'already_processed' };
    }

    if (input.eventType !== 'payment_intent.succeeded') {
      await client.query(
        `UPDATE webhook_receipts SET processed_at = now() WHERE id = $1`,
        [receipt.rows[0]!.id],
      );
      await client.query('COMMIT');
      return { duplicate: false, status: 'ignored' };
    }

    const intentId = String(
      (input.payload.data as { object?: { id?: string } } | undefined)?.object?.id ??
        input.payload.provider_payment_intent_id ??
        '',
    );
    if (!intentId) throw validationError('payment intent id missing');

    const paymentLookup = await client.query<{ id: string; tenant_id: string }>(
      `SELECT id, tenant_id FROM find_payment_by_provider_intent('stripe_sandbox', $1)`,
      [intentId],
    );
    const payment = paymentLookup.rows[0];
    if (!payment) {
      await client.query('ROLLBACK');
      throw notFound('Payment intent not found');
    }

    await client.query("SELECT set_config('app.tenant_id', $1, true)", [payment.tenant_id]);
    const settled = await applySuccessfulPayment(client, {
      tenantId: payment.tenant_id,
      paymentId: payment.id,
      providerEventId: input.providerEventId,
    });

    await client.query(
      `UPDATE webhook_receipts SET processed_at = now() WHERE id = $1`,
      [receipt.rows[0]!.id],
    );

    await client.query('COMMIT');
    return { duplicate: false, paymentId: settled.id, status: settled.status };
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

export async function getPayment(
  tenantId: string,
  paymentId: string,
  pool: DbPool,
): Promise<PaymentAttemptRow> {
  return withTenant(tenantId, async (db) => {
    const res = await db.query<PaymentAttemptRow>(
      `SELECT id, tenant_id, invoice_id, billing_account_id, amount_minor, currency,
              status, provider, provider_payment_intent_id, provider_event_id,
              idempotency_key, created_at
       FROM payment_attempts WHERE id = $1`,
      [paymentId],
    );
    if (!res.rows[0]) throw notFound('Payment not found');
    return res.rows[0];
  }, pool);
}
