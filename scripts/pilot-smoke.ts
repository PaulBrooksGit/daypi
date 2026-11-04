/**
 * Hostinger pilot smoke — synthetic data only.
 * Flow: enrol → register → invoice sandbox → document sign → SMS sandbox.
 *
 * Prerequisites: migrated DB, seed users, API on BASE_URL (worker optional).
 * Live Stripe/Twilio and Phase 4 commerce are out of scope.
 */
import { config as loadEnv } from '../tests/load-env.js';

loadEnv();

const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
const OWNER_EMAIL = process.env.SMOKE_OWNER_EMAIL ?? 'owner-a@example.test';
const OWNER_PASSWORD = process.env.SMOKE_OWNER_PASSWORD ?? 'Passw0rd!dev';
const PARENT_EMAIL = process.env.SMOKE_PARENT_EMAIL ?? 'parent-a@example.test';
const PARENT_PASSWORD = process.env.SMOKE_PARENT_PASSWORD ?? 'Passw0rd!dev';

const runId = `smoke_${Date.now()}`;

interface Json {
  data?: unknown;
  error?: { code?: string; message?: string };
}

class SmokeError extends Error {
  constructor(
    readonly step: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`${step} failed: HTTP ${status} ${JSON.stringify(body)}`);
    this.name = 'SmokeError';
  }
}

async function api(
  step: string,
  method: string,
  path: string,
  opts: {
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
    expected?: number[];
  } = {},
): Promise<Json> {
  // Host comes from BASE_URL (must be in ALLOWED_HOSTS). Node fetch forbids overriding Host.
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    ...opts.headers,
  };
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: Json = {};
  try {
    json = text ? (JSON.parse(text) as Json) : {};
  } catch {
    json = { error: { message: text.slice(0, 500) } };
  }
  const expected = opts.expected ?? [200, 201];
  if (!expected.includes(res.status)) {
    throw new SmokeError(step, res.status, json);
  }
  return json;
}

function asRecord(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object') return {};
  return data as Record<string, unknown>;
}

async function login(email: string, password: string): Promise<{ token: string; userId: string }> {
  const json = await api(`login:${email}`, 'POST', '/v1/auth/login', {
    body: { email, password },
  });
  const data = asRecord(json.data);
  const token = String(data.access_token ?? '');
  const user = asRecord(data.user);
  const userId = String(user.id ?? '');
  if (!token || !userId) throw new Error(`login:${email} missing token/user`);
  return { token, userId };
}

async function selectTenant(token: string, tenantId: string): Promise<void> {
  await api('tenant.select', 'POST', '/v1/auth/tenant/select', {
    token,
    body: { tenant_id: tenantId },
  });
}

async function main() {
  console.info(JSON.stringify({ event: 'pilot_smoke_start', base_url: BASE_URL, run_id: runId }));

  const health = await api('health', 'GET', '/v1/health', { expected: [200] });
  void health;

  const owner = await login(OWNER_EMAIL, OWNER_PASSWORD);
  const parent = await login(PARENT_EMAIL, PARENT_PASSWORD);

  const me = await api('auth.me', 'GET', '/v1/auth/me', { token: owner.token });
  const memberships = (asRecord(me.data).memberships as Array<Record<string, unknown>>) ?? [];
  const tenantId = String(memberships[0]?.tenant_id ?? '');
  if (!tenantId) throw new Error('owner has no memberships — run npm run seed');
  await selectTenant(owner.token, tenantId);
  await selectTenant(parent.token, tenantId);

  const sitesJson = await api('sites.list', 'GET', '/v1/sites', { token: owner.token });
  const sites = (sitesJson.data as Array<Record<string, unknown>>) ?? [];
  const siteId = String(sites[0]?.id ?? '');
  if (!siteId) throw new Error('no site on tenant');

  // --- Enrol ---
  const enquiry = asRecord(
    (
      await api('enquiries.create', 'POST', '/v1/enquiries', {
        token: owner.token,
        body: {
          site_id: siteId,
          child_given_name: 'Pilot',
          child_family_name: `Smoke${runId.slice(-6)}`,
          child_date_of_birth: '2022-06-15',
          guardian_given_name: 'Pilot',
          guardian_family_name: 'Guardian',
          guardian_email: `pilot-guardian-${runId}@example.test`,
          guardian_phone_e164: '+447700900099',
          source: 'pilot-smoke',
          notes: 'Synthetic Hostinger pilot smoke enquiry',
        },
      })
    ).data,
  );
  const enquiryId = String(enquiry.id);

  await api('enquiries.offer', 'PATCH', `/v1/enquiries/${enquiryId}`, {
    token: owner.token,
    body: { status: 'offered' },
  });
  await api('enquiries.accept', 'PATCH', `/v1/enquiries/${enquiryId}`, {
    token: owner.token,
    body: { status: 'accepted' },
  });

  const child = asRecord(
    (
      await api('children.create', 'POST', '/v1/children', {
        token: owner.token,
        body: {
          given_name: 'Pilot',
          family_name: `Smoke${runId.slice(-6)}`,
          date_of_birth: '2022-06-15',
          enrolment_status: 'waiting',
        },
      })
    ).data,
  );
  const childId = String(child.id);

  const guardian = asRecord(
    (
      await api('guardians.create', 'POST', '/v1/guardians', {
        token: owner.token,
        body: {
          given_name: 'Pilot',
          family_name: 'Guardian',
          email: `pilot-guardian-${runId}@example.test`,
          phone_e164: '+447700900099',
          user_id: parent.userId,
        },
      })
    ).data,
  );
  const guardianId = String(guardian.id);

  await api('relationships.link', 'PUT', `/v1/children/${childId}/guardians/${guardianId}`, {
    token: owner.token,
    body: {
      relationship: 'parent',
      access_level: 'full',
      has_parental_responsibility: true,
      is_authorised_collector: true,
      is_billing_contact: true,
    },
  });

  const enrolment = asRecord(
    (
      await api('enrolments.create', 'POST', '/v1/enrolments', {
        token: owner.token,
        body: {
          site_id: siteId,
          child_id: childId,
          enquiry_id: enquiryId,
          start_date: '2026-11-04',
          status: 'active',
        },
      })
    ).data,
  );

  // --- Register ---
  const sessionDate = '2026-12-01';
  const sessionDef = asRecord(
    (
      await api('session-definitions.create', 'POST', '/v1/session-definitions', {
        token: owner.token,
        body: {
          site_id: siteId,
          name: `Pilot morning ${runId.slice(-6)}`,
          local_start_time: '09:00',
          local_end_time: '12:00',
          default_capacity: 8,
          timezone: 'Europe/London',
        },
      })
    ).data,
  );
  const dated = asRecord(
    (
      await api('dated-sessions.create', 'POST', '/v1/dated-sessions', {
        token: owner.token,
        body: {
          session_definition_id: sessionDef.id,
          session_date: sessionDate,
        },
      })
    ).data,
  );
  const datedSessionId = String(dated.id);

  const booking = asRecord(
    (
      await api('bookings.create', 'POST', '/v1/bookings', {
        token: owner.token,
        headers: { 'Idempotency-Key': `${runId}-booking` },
        body: {
          child_id: childId,
          dated_session_id: datedSessionId,
        },
      })
    ).data,
  );
  const confirmed = asRecord(
    (
      await api('bookings.confirm', 'POST', `/v1/bookings/${String(booking.id)}/confirm`, {
        token: owner.token,
      })
    ).data,
  );

  const checkIn = asRecord(
    (
      await api('attendance.check-in', 'POST', '/v1/attendance/check-in', {
        token: owner.token,
        body: {
          child_id: childId,
          dated_session_id: datedSessionId,
          notes: 'pilot smoke check-in',
        },
      })
    ).data,
  );

  const register = asRecord(
    (
      await api('registers.get', 'GET', `/v1/registers/${datedSessionId}`, {
        token: owner.token,
      })
    ).data,
  );

  // --- Invoice sandbox ---
  const account = asRecord(
    (
      await api('billing-accounts.create', 'POST', '/v1/billing-accounts', {
        token: owner.token,
        body: {
          display_name: `Pilot Smoke ${runId.slice(-6)}`,
          guardian_id: guardianId,
          child_id: childId,
        },
      })
    ).data,
  );
  const drafted = asRecord(
    (
      await api('invoices.draft', 'POST', '/v1/invoices', {
        token: owner.token,
        headers: { 'Idempotency-Key': `${runId}-invoice` },
        body: {
          billing_account_id: account.id,
          lines: [
            {
              description: 'Pilot smoke morning sessions',
              quantity: 2,
              unit_amount_minor: 1500,
              child_id: childId,
            },
          ],
        },
      })
    ).data,
  );
  const draftInvoice = asRecord(drafted.invoice ?? drafted);
  const issued = asRecord(
    (
      await api('invoices.issue', 'POST', `/v1/invoices/${String(draftInvoice.id)}/issue`, {
        token: owner.token,
      })
    ).data,
  );
  const payment = asRecord(
    (
      await api('payments.create', 'POST', '/v1/payments', {
        token: owner.token,
        headers: { 'Idempotency-Key': `${runId}-payment` },
        body: { invoice_id: issued.id },
      })
    ).data,
  );
  const stripeEventId = `evt_${runId}`;
  await api('webhooks.stripe', 'POST', '/v1/webhooks/stripe', {
    body: {
      id: stripeEventId,
      type: 'payment_intent.succeeded',
      data: { object: { id: payment.provider_payment_intent_id } },
      provider_payment_intent_id: payment.provider_payment_intent_id,
    },
  });

  // --- Document sign ---
  const docBundle = asRecord(
    (
      await api('documents.create', 'POST', '/v1/documents', {
        token: owner.token,
        body: {
          title: `Pilot consent ${runId.slice(-6)}`,
          category: 'policy',
          visibility: 'guardians',
          body_text: 'Synthetic pilot policy body — not a live legal document.',
        },
      })
    ).data,
  );
  const document = asRecord(docBundle.document ?? docBundle);
  const version = asRecord(docBundle.version ?? {});
  const versionId = String(version.id ?? document.current_version_id ?? '');

  const consent = asRecord(
    (
      await api('consents.create', 'POST', '/v1/consents', {
        token: owner.token,
        body: {
          document_id: document.id,
          document_version_id: versionId || undefined,
          guardian_id: guardianId,
          child_id: childId,
        },
      })
    ).data,
  );

  const signed = asRecord(
    (
      await api('consents.sign', 'POST', `/v1/consents/${String(consent.id)}/signatures`, {
        token: parent.token,
        body: {
          signer_display_name: 'Pilot Guardian',
          signature_method: 'typed_name',
        },
      })
    ).data,
  );

  // --- SMS sandbox ---
  await api('usage.top-up', 'POST', '/v1/usage/top-ups', {
    token: owner.token,
    headers: { 'Idempotency-Key': `${runId}-topup` },
    body: { amount_minor: 200 },
  });

  const messageBundle = asRecord(
    (
      await api('messages.create', 'POST', '/v1/messages', {
        token: owner.token,
        headers: { 'Idempotency-Key': `${runId}-sms` },
        body: {
          channel: 'sms',
          purpose: 'transactional',
          body: 'Pilot smoke transactional SMS (sandbox only).',
          guardian_ids: [guardianId],
        },
      })
    ).data,
  );
  const message = asRecord(messageBundle.message ?? messageBundle);
  const sent = asRecord(
    (
      await api('messages.sandbox-send', 'POST', `/v1/messages/${String(message.id)}/sandbox-send`, {
        token: owner.token,
      })
    ).data,
  );

  // Omit recipient_sid so sandbox webhook resolves the sent recipient via MessageSid.
  await api('webhooks.twilio', 'POST', '/v1/webhooks/twilio', {
    body: {
      id: `twilio_${runId}`,
      MessageSid: sent.provider_message_sid,
      MessageStatus: 'delivered',
    },
  });

  const summary = {
    ok: true,
    run_id: runId,
    tenant_id: tenantId,
    site_id: siteId,
    enquiry_id: enquiryId,
    child_id: childId,
    guardian_id: guardianId,
    enrolment_id: enrolment.id,
    dated_session_id: datedSessionId,
    booking_id: confirmed.id ?? booking.id,
    attendance_event_id: checkIn.id,
    register_present_count: Array.isArray(register.entries)
      ? (register.entries as unknown[]).length
      : register.children
        ? (register.children as unknown[]).length
        : undefined,
    invoice_id: issued.id,
    payment_id: payment.id,
    consent_id: consent.id,
    signature_status: asRecord(signed.consent).status ?? signed.status,
    message_id: message.id,
    message_status: sent.status,
  };

  console.info(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
