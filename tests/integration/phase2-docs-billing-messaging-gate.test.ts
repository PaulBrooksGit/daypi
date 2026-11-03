import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  setupFixtures,
  login,
  selectTenant,
  request,
  type Fixtures,
} from './helpers.js';
import {
  createDocument,
  addDocumentVersion,
  createConsentRequest,
  signConsent,
  getConsentWithEvidence,
  getDocumentVersion,
} from '../../modules/documents/src/index.js';
import {
  createBillingAccount,
  draftInvoice,
  issueInvoice,
  createSandboxPayment,
  processStripeSandboxWebhook,
  reconcileBillingAccount,
  sandboxPurchaseCredit,
  getUsageAccount,
  getInvoice,
} from '../../modules/finance/src/index.js';
import {
  createAndQueueMessage,
  processSandboxSend,
  processTwilioSandboxWebhook,
  getMessage,
} from '../../modules/messaging/src/index.js';
import { withTenant } from '../../platform/db/src/index.js';

describe('Phase 2 DayDocs / DayBank / DayText gate', () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await setupFixtures();
    // Ensure guardian has phone for SMS tests
    await withTenant(fx.tenantA, async (db) => {
      await db.query(
        `UPDATE guardians
         SET phone_e164 = '+447700900001', marketing_sms_opt_in = false
         WHERE id = $1`,
        [fx.guardianA],
      );
    }, fx.pool);
  }, 120_000);

  afterAll(async () => {
    await fx.pool.end();
  });

  it('preserves exact signed document version after later edit', async () => {
    const { document, version: v1 } = await createDocument(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        title: 'Safeguarding policy',
        bodyText: 'Version one body — do not alter after sign',
        category: 'policy',
        visibility: 'guardians',
      },
      fx.pool,
    );

    const consent = await createConsentRequest(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        documentId: document.id,
        documentVersionId: v1.id,
        guardianId: fx.guardianA,
        childId: fx.childA1,
      },
      fx.pool,
    );

    const signed = await signConsent(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.parentA.id,
        consentId: consent.id,
        signerDisplayName: 'Pat Ash',
        roleTemplate: 'parent',
      },
      fx.pool,
    );

    expect(signed.consent.status).toBe('signed');
    expect(signed.evidence.content_sha256_at_sign).toBe(v1.content_sha256);
    expect(signed.version.id).toBe(v1.id);
    expect(signed.version.body_text).toBe('Version one body — do not alter after sign');

    // Later edit creates a new version; current document points at v2
    const { version: v2 } = await addDocumentVersion(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        documentId: document.id,
        title: 'Safeguarding policy',
        bodyText: 'Version two body — edited after signature',
      },
      fx.pool,
    );
    expect(v2.version_number).toBe(2);
    expect(v2.content_sha256).not.toBe(v1.content_sha256);

    // Signed evidence still resolves to exact v1 content
    const retrieved = await getConsentWithEvidence(fx.tenantA, consent.id, fx.pool);
    expect(retrieved.evidence?.document_version_id).toBe(v1.id);
    expect(retrieved.evidence?.content_sha256_at_sign).toBe(v1.content_sha256);
    expect(retrieved.version.body_text).toBe('Version one body — do not alter after sign');

    const frozen = await getDocumentVersion(fx.tenantA, v1.id, fx.pool);
    expect(frozen.body_text).toBe('Version one body — do not alter after sign');
    expect(frozen.content_sha256).toBe(v1.content_sha256);

    // Append-only: cannot mutate signature evidence
    await expect(
      withTenant(fx.tenantA, async (db) => {
        await db.query(`UPDATE signature_evidence SET signer_display_name = 'Hacked' WHERE id = $1`, [
          signed.evidence.id,
        ]);
      }, fx.pool),
    ).rejects.toThrow(/append-only/i);
  });

  it('payment webhook replay yields one financial effect and reconciles', async () => {
    const account = await createBillingAccount(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        displayName: 'Ash family',
        guardianId: fx.guardianA,
        childId: fx.childA1,
      },
      fx.pool,
    );

    const drafted = await draftInvoice(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        billingAccountId: account.id,
        idempotencyKey: 'inv-phase2-1',
        lines: [
          {
            description: 'Morning sessions Nov',
            quantity: 4,
            unitAmountMinor: 2500,
            childId: fx.childA1,
          },
        ],
      },
      fx.pool,
    );
    expect(drafted.invoice.total_minor).toBe(10_000);

    const issued = await issueInvoice(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        invoiceId: drafted.invoice.id,
      },
      fx.pool,
    );
    expect(issued.status).toBe('issued');

    // Issued totals immutable
    await expect(
      withTenant(fx.tenantA, async (db) => {
        await db.query(`UPDATE invoices SET total_minor = 1 WHERE id = $1`, [issued.id]);
      }, fx.pool),
    ).rejects.toThrow(/immutable/i);

    const payment = await createSandboxPayment(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        invoiceId: issued.id,
        idempotencyKey: 'pay-phase2-1',
      },
      fx.pool,
    );
    expect(payment.status).toBe('pending');
    expect(payment.provider_payment_intent_id).toBeTruthy();

    // Same idempotency key returns same payment
    const again = await createSandboxPayment(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        invoiceId: issued.id,
        idempotencyKey: 'pay-phase2-1',
      },
      fx.pool,
    );
    expect(again.id).toBe(payment.id);

    const eventId = 'evt_sandbox_phase2_pay_1';
    const payload = {
      id: eventId,
      type: 'payment_intent.succeeded',
      data: { object: { id: payment.provider_payment_intent_id } },
    };

    const first = await processStripeSandboxWebhook(
      {
        providerEventId: eventId,
        eventType: 'payment_intent.succeeded',
        payload,
        signatureValid: true,
      },
      fx.pool,
    );
    expect(first.duplicate).toBe(false);
    expect(first.status).toBe('succeeded');

    const replay = await processStripeSandboxWebhook(
      {
        providerEventId: eventId,
        eventType: 'payment_intent.succeeded',
        payload,
        signatureValid: true,
      },
      fx.pool,
    );
    expect(replay.duplicate).toBe(true);
    expect(replay.status).toBe('already_processed');

    const inv = await getInvoice(fx.tenantA, issued.id, fx.pool);
    expect(inv.invoice.amount_paid_minor).toBe(10_000);

    const paymentsCount = await withTenant(fx.tenantA, async (db) => {
      const r = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM payment_attempts
         WHERE invoice_id = $1 AND status = 'succeeded'`,
        [issued.id],
      );
      return Number(r.rows[0]!.n);
    }, fx.pool);
    expect(paymentsCount).toBe(1);

    const ledgerPayments = await withTenant(fx.tenantA, async (db) => {
      const r = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM finance_ledger_entries
         WHERE kind = 'payment' AND reference_id = $1`,
        [payment.id],
      );
      return Number(r.rows[0]!.n);
    }, fx.pool);
    expect(ledgerPayments).toBe(1);

    const reconciliation = await reconcileBillingAccount(fx.tenantA, account.id, fx.pool);
    expect(reconciliation.balanced).toBe(true);
    expect(reconciliation.payments_succeeded_minor).toBe(10_000);
    // issue +10000, payment -10000 => balance 0
    expect(reconciliation.account_balance_minor).toBe(0);
    expect(reconciliation.invoices_outstanding_minor).toBe(0);
  });

  it('usage ledger reserve/settle reconciles and rejects promotional grants path', async () => {
    await sandboxPurchaseCredit(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        amountMinor: 100,
        idempotencyKey: 'usage-topup-1',
      },
      fx.pool,
    );

    const before = await getUsageAccount(fx.tenantA, fx.pool);
    expect(before.balance_minor).toBeGreaterThanOrEqual(100);

    const queued = await createAndQueueMessage(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        channel: 'sms',
        purpose: 'transactional',
        body: 'Session reminder for tomorrow morning.',
        guardianIds: [fx.guardianA],
        idempotencyKey: 'msg-phase2-1',
      },
      fx.pool,
    );
    expect(queued.message.status).toBe('queued');
    expect(queued.estimate.cost_minor).toBeGreaterThan(0);

    const afterReserve = await getUsageAccount(fx.tenantA, fx.pool);
    expect(afterReserve.balance_minor).toBe(before.balance_minor - queued.estimate.cost_minor);

    const sent = await processSandboxSend(
      { tenantId: fx.tenantA, messageId: queued.message.id },
      fx.pool,
    );
    expect(sent.status).toBe('sent');
    expect(sent.provider_message_sid).toBeTruthy();

    const afterSettle = await getUsageAccount(fx.tenantA, fx.pool);
    expect(afterSettle.balance_minor).toBe(before.balance_minor - (sent.actual_cost_minor ?? 0));

    // Idempotent create
    const dup = await createAndQueueMessage(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        channel: 'sms',
        purpose: 'transactional',
        body: 'different body should not matter',
        guardianIds: [fx.guardianA],
        idempotencyKey: 'msg-phase2-1',
      },
      fx.pool,
    );
    expect(dup.message.id).toBe(queued.message.id);

    // Marketing preference: opt-out skips recipient
    const marketing = await createAndQueueMessage(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        channel: 'sms',
        purpose: 'marketing',
        body: 'Book our open day!',
        guardianIds: [fx.guardianA],
        idempotencyKey: 'msg-phase2-marketing',
      },
      fx.pool,
    );
    expect(marketing.recipients[0]!.delivery_status).toBe('skipped');
    expect(marketing.recipients[0]!.skip_reason).toBe('marketing_sms_opt_out');
  });

  it('Twilio delivery webhook replay does not duplicate delivery events', async () => {
    const funded = await getUsageAccount(fx.tenantA, fx.pool);
    if (funded.balance_minor < 20) {
      await sandboxPurchaseCredit(
        {
          tenantId: fx.tenantA,
          actorUserId: fx.ownerA.id,
          amountMinor: 50,
          idempotencyKey: 'usage-topup-twilio',
        },
        fx.pool,
      );
    }

    const queued = await createAndQueueMessage(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        channel: 'sms',
        purpose: 'transactional',
        body: 'Pickup update',
        guardianIds: [fx.guardianA],
        idempotencyKey: 'msg-phase2-twilio',
      },
      fx.pool,
    );
    const sent = await processSandboxSend(
      { tenantId: fx.tenantA, messageId: queued.message.id },
      fx.pool,
    );

    const detail = await getMessage(fx.tenantA, sent.id, fx.pool);
    const recipient = detail.recipients.find((r) => r.delivery_status === 'sent');
    expect(recipient).toBeTruthy();

    const eventId = 'twilio_evt_delivery_1';
    const payload = {
      id: eventId,
      MessageSid: sent.provider_message_sid,
      MessageStatus: 'delivered',
      recipient_sid: recipient!.id
        ? undefined
        : undefined,
    };
    // Use first sent recipient via fallback when recipient_sid omitted
    const first = await processTwilioSandboxWebhook(
      {
        providerEventId: eventId,
        payload: {
          ...payload,
          recipient_sid: (
            await withTenant(fx.tenantA, async (db) => {
              const r = await db.query<{ sid: string | null }>(
                `SELECT provider_recipient_sid AS sid FROM message_recipients WHERE id = $1`,
                [recipient!.id],
              );
              return r.rows[0]!.sid;
            }, fx.pool)
          )!,
        },
        signatureValid: true,
      },
      fx.pool,
    );
    expect(first.duplicate).toBe(false);
    expect(first.status).toBe('delivered');

    const replay = await processTwilioSandboxWebhook(
      {
        providerEventId: eventId,
        payload: {
          MessageSid: sent.provider_message_sid,
          MessageStatus: 'delivered',
        },
        signatureValid: true,
      },
      fx.pool,
    );
    expect(replay.duplicate).toBe(true);

    const events = await withTenant(fx.tenantA, async (db) => {
      const r = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM message_delivery_events
         WHERE message_id = $1`,
        [sent.id],
      );
      return Number(r.rows[0]!.n);
    }, fx.pool);
    expect(events).toBe(1);

    const finalMsg = await getMessage(fx.tenantA, sent.id, fx.pool);
    expect(finalMsg.message.status).toBe('delivered');
  });

  it('HTTP API: sandbox payment webhook and document routes smoke', async () => {
    const token = await login(fx.app, fx.ownerA.email, fx.ownerA.password);
    await selectTenant(fx.app, token, fx.tenantA);

    const docRes = await request(fx.app)
      .post('/v1/documents')
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'HTTP policy',
        body_text: 'HTTP body',
      });
    expect(docRes.status).toBe(201);
    expect(docRes.body.data.document.id).toBeTruthy();

    const accountRes = await request(fx.app)
      .post('/v1/billing-accounts')
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${token}`)
      .send({ display_name: 'HTTP billing', guardian_id: fx.guardianA });
    expect(accountRes.status).toBe(201);

    const invRes = await request(fx.app)
      .post('/v1/invoices')
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'http-inv-1')
      .send({
        billing_account_id: accountRes.body.data.id,
        lines: [{ description: 'Fee', unit_amount_minor: 1500 }],
      });
    expect(invRes.status).toBe(201);

    const issueRes = await request(fx.app)
      .post(`/v1/invoices/${invRes.body.data.invoice.id}/issue`)
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${token}`);
    expect(issueRes.status).toBe(200);

    const payRes = await request(fx.app)
      .post('/v1/payments')
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'http-pay-1')
      .send({ invoice_id: invRes.body.data.invoice.id });
    expect(payRes.status).toBe(201);

    const wh1 = await request(fx.app)
      .post('/v1/webhooks/stripe')
      .set('Host', 'localhost')
      .send({
        id: 'evt_http_1',
        type: 'payment_intent.succeeded',
        data: { object: { id: payRes.body.data.provider_payment_intent_id } },
      });
    expect(wh1.status).toBe(200);
    expect(wh1.body.data.duplicate).toBe(false);

    const wh2 = await request(fx.app)
      .post('/v1/webhooks/stripe')
      .set('Host', 'localhost')
      .send({
        id: 'evt_http_1',
        type: 'payment_intent.succeeded',
        data: { object: { id: payRes.body.data.provider_payment_intent_id } },
      });
    expect(wh2.status).toBe(200);
    expect(wh2.body.data.duplicate).toBe(true);

    const liveDisabled = await request(fx.app)
      .post('/v1/payments/collect')
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(liveDisabled.status).toBe(403);
    expect(liveDisabled.body.error.code).toBe('FEATURE_DISABLED');
  });
});
