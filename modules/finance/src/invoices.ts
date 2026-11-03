import type { DbClient, DbPool } from '../../../platform/db/src/pool.js';
import { withTenant } from '../../../platform/db/src/index.js';
import { writeAudit } from '../../../platform/audit/src/index.js';
import { notFound, conflict, validationError } from '../../../platform/http/src/errors.js';

export interface BillingAccountRow {
  id: string;
  tenant_id: string;
  guardian_id: string | null;
  child_id: string | null;
  display_name: string;
  currency: string;
  status: string;
  balance_minor: number;
}

export interface InvoiceRow {
  id: string;
  tenant_id: string;
  billing_account_id: string;
  invoice_number: string;
  status: string;
  currency: string;
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  amount_paid_minor: number;
  issued_at: Date | null;
  due_at: Date | null;
  pricing_snapshot: Record<string, unknown>;
  idempotency_key: string | null;
  created_at: Date;
}

export interface InvoiceLineInput {
  description: string;
  quantity?: number;
  unitAmountMinor: number;
  childId?: string;
}

export async function createBillingAccount(
  input: {
    tenantId: string;
    actorUserId: string;
    displayName: string;
    guardianId?: string;
    childId?: string;
    currency?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<BillingAccountRow> {
  return withTenant(input.tenantId, async (db) => {
    if (!input.displayName.trim()) throw validationError('display_name required');
    const res = await db.query<BillingAccountRow>(
      `INSERT INTO billing_accounts (
         tenant_id, guardian_id, child_id, display_name, currency
       ) VALUES ($1,$2,$3,$4,$5)
       RETURNING id, tenant_id, guardian_id, child_id, display_name, currency, status, balance_minor`,
      [
        input.tenantId,
        input.guardianId ?? null,
        input.childId ?? null,
        input.displayName.trim(),
        input.currency ?? 'GBP',
      ],
    );
    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'billing_account.create',
      entityType: 'billing_account',
      entityId: res.rows[0]!.id,
      correlationId: input.correlationId,
    });
    return res.rows[0]!;
  }, pool);
}

export async function draftInvoice(
  input: {
    tenantId: string;
    actorUserId: string;
    billingAccountId: string;
    lines: InvoiceLineInput[];
    taxMinor?: number;
    dueAt?: string;
    idempotencyKey?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<{ invoice: InvoiceRow; lines: unknown[] }> {
  return withTenant(input.tenantId, async (db) => {
    if (input.idempotencyKey) {
      const existing = await db.query<InvoiceRow>(
        `SELECT id, tenant_id, billing_account_id, invoice_number, status, currency,
                subtotal_minor, tax_minor, total_minor, amount_paid_minor,
                issued_at, due_at, pricing_snapshot, idempotency_key, created_at
         FROM invoices WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      if (existing.rows[0]) {
        const lines = await db.query(`SELECT * FROM invoice_lines WHERE invoice_id = $1`, [
          existing.rows[0].id,
        ]);
        return { invoice: mapInvoice(existing.rows[0]), lines: lines.rows };
      }
    }

    if (!input.lines.length) throw validationError('at least one line required');

    const account = await db.query(
      `SELECT id FROM billing_accounts WHERE id = $1 AND status = 'active'`,
      [input.billingAccountId],
    );
    if (account.rowCount === 0) throw notFound('Billing account not found');

    let subtotal = 0;
    for (const line of input.lines) {
      const qty = line.quantity ?? 1;
      if (qty <= 0) throw validationError('quantity must be positive');
      subtotal += qty * line.unitAmountMinor;
    }
    const tax = input.taxMinor ?? 0;
    if (tax < 0) throw validationError('tax_minor must be >= 0');
    const total = subtotal + tax;

    const seq = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM invoices WHERE tenant_id = $1`,
      [input.tenantId],
    );
    const invoiceNumber = `INV-${String(Number(seq.rows[0]!.n) + 1).padStart(5, '0')}`;

    const inv = await db.query<InvoiceRow>(
      `INSERT INTO invoices (
         tenant_id, billing_account_id, invoice_number, status, currency,
         subtotal_minor, tax_minor, total_minor, due_at, pricing_snapshot,
         idempotency_key, created_by_user_id
       ) VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
       RETURNING id, tenant_id, billing_account_id, invoice_number, status, currency,
                 subtotal_minor, tax_minor, total_minor, amount_paid_minor,
                 issued_at, due_at, pricing_snapshot, idempotency_key, created_at`,
      [
        input.tenantId,
        input.billingAccountId,
        invoiceNumber,
        'GBP',
        subtotal,
        tax,
        total,
        input.dueAt ?? null,
        JSON.stringify({
          lines: input.lines,
          captured_at: new Date().toISOString(),
        }),
        input.idempotencyKey ?? null,
        input.actorUserId,
      ],
    );

    const lineRows = [];
    for (const line of input.lines) {
      const qty = line.quantity ?? 1;
      const amount = qty * line.unitAmountMinor;
      const r = await db.query(
        `INSERT INTO invoice_lines (
           tenant_id, invoice_id, description, quantity, unit_amount_minor, amount_minor, child_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, description, quantity, unit_amount_minor, amount_minor, child_id`,
        [
          input.tenantId,
          inv.rows[0]!.id,
          line.description,
          qty,
          line.unitAmountMinor,
          amount,
          line.childId ?? null,
        ],
      );
      lineRows.push(r.rows[0]);
    }

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'invoices.draft',
      entityType: 'invoice',
      entityId: inv.rows[0]!.id,
      correlationId: input.correlationId,
    });

    return { invoice: mapInvoice(inv.rows[0]!), lines: lineRows };
  }, pool);
}

export async function issueInvoice(
  input: {
    tenantId: string;
    actorUserId: string;
    invoiceId: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<InvoiceRow> {
  return withTenant(input.tenantId, async (db) => {
    const inv = await db.query<InvoiceRow>(
      `SELECT id, tenant_id, billing_account_id, invoice_number, status, currency,
              subtotal_minor, tax_minor, total_minor, amount_paid_minor,
              issued_at, due_at, pricing_snapshot, idempotency_key, created_at
       FROM invoices WHERE id = $1 FOR UPDATE`,
      [input.invoiceId],
    );
    const row = inv.rows[0];
    if (!row) throw notFound('Invoice not found');
    if (row.status === 'issued') return mapInvoice(row);
    if (row.status !== 'draft') throw conflict(`Cannot issue invoice in status ${row.status}`);

    const issued = await db.query<InvoiceRow>(
      `UPDATE invoices
       SET status = 'issued', issued_at = now(), updated_at = now()
       WHERE id = $1
       RETURNING id, tenant_id, billing_account_id, invoice_number, status, currency,
                 subtotal_minor, tax_minor, total_minor, amount_paid_minor,
                 issued_at, due_at, pricing_snapshot, idempotency_key, created_at`,
      [input.invoiceId],
    );

    await appendFinanceLedger(db, {
      tenantId: input.tenantId,
      billingAccountId: row.billing_account_id,
      amountMinor: row.total_minor,
      kind: 'invoice_issue',
      referenceType: 'invoice',
      referenceId: row.id,
      idempotencyKey: `invoice_issue:${row.id}`,
    });

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'invoices.issue',
      entityType: 'invoice',
      entityId: row.id,
      correlationId: input.correlationId,
      metadata: { total_minor: row.total_minor },
    });

    return mapInvoice(issued.rows[0]!);
  }, pool);
}

export async function getInvoice(
  tenantId: string,
  invoiceId: string,
  pool: DbPool,
): Promise<{ invoice: InvoiceRow; lines: unknown[] }> {
  return withTenant(tenantId, async (db) => {
    const inv = await db.query<InvoiceRow>(
      `SELECT id, tenant_id, billing_account_id, invoice_number, status, currency,
              subtotal_minor, tax_minor, total_minor, amount_paid_minor,
              issued_at, due_at, pricing_snapshot, idempotency_key, created_at
       FROM invoices WHERE id = $1`,
      [invoiceId],
    );
    if (!inv.rows[0]) throw notFound('Invoice not found');
    const lines = await db.query(
      `SELECT id, description, quantity, unit_amount_minor, amount_minor, child_id
       FROM invoice_lines WHERE invoice_id = $1 ORDER BY created_at`,
      [invoiceId],
    );
    return { invoice: mapInvoice(inv.rows[0]), lines: lines.rows };
  }, pool);
}

export async function creditInvoice(
  input: {
    tenantId: string;
    actorUserId: string;
    invoiceId: string;
    amountMinor: number;
    reason: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<{ invoice: InvoiceRow; creditId: string }> {
  return withTenant(input.tenantId, async (db) => {
    if (input.amountMinor <= 0) throw validationError('amount_minor must be positive');
    const inv = await db.query<InvoiceRow>(
      `SELECT id, tenant_id, billing_account_id, invoice_number, status, currency,
              subtotal_minor, tax_minor, total_minor, amount_paid_minor,
              issued_at, due_at, pricing_snapshot, idempotency_key, created_at
       FROM invoices WHERE id = $1 FOR UPDATE`,
      [input.invoiceId],
    );
    const row = inv.rows[0];
    if (!row) throw notFound('Invoice not found');
    if (row.status !== 'issued') throw conflict('Only issued invoices can be credited');

    const credit = await db.query<{ id: string }>(
      `INSERT INTO invoice_credits (tenant_id, invoice_id, amount_minor, reason, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [input.tenantId, input.invoiceId, input.amountMinor, input.reason, input.actorUserId],
    );

    const updated = await db.query<InvoiceRow>(
      `UPDATE invoices SET status = 'credited', updated_at = now()
       WHERE id = $1
       RETURNING id, tenant_id, billing_account_id, invoice_number, status, currency,
                 subtotal_minor, tax_minor, total_minor, amount_paid_minor,
                 issued_at, due_at, pricing_snapshot, idempotency_key, created_at`,
      [input.invoiceId],
    );

    await appendFinanceLedger(db, {
      tenantId: input.tenantId,
      billingAccountId: row.billing_account_id,
      amountMinor: -input.amountMinor,
      kind: 'credit',
      referenceType: 'invoice_credit',
      referenceId: credit.rows[0]!.id,
      idempotencyKey: `invoice_credit:${credit.rows[0]!.id}`,
    });

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'invoices.credit',
      entityType: 'invoice',
      entityId: input.invoiceId,
      correlationId: input.correlationId,
      metadata: { amount_minor: input.amountMinor, reason: input.reason },
    });

    return { invoice: mapInvoice(updated.rows[0]!), creditId: credit.rows[0]!.id };
  }, pool);
}

export async function appendFinanceLedger(
  db: DbClient,
  input: {
    tenantId: string;
    billingAccountId: string;
    amountMinor: number;
    kind: string;
    idempotencyKey: string;
    referenceType?: string;
    referenceId?: string;
  },
): Promise<void> {
  const existing = await db.query(
    `SELECT id FROM finance_ledger_entries WHERE idempotency_key = $1`,
    [input.idempotencyKey],
  );
  if (existing.rowCount) return;

  const account = await db.query<{ balance_minor: number; version: number }>(
    `SELECT balance_minor, version FROM billing_accounts WHERE id = $1 FOR UPDATE`,
    [input.billingAccountId],
  );
  if (!account.rows[0]) throw notFound('Billing account not found');
  const balanceAfter = account.rows[0].balance_minor + input.amountMinor;

  await db.query(
    `INSERT INTO finance_ledger_entries (
       tenant_id, billing_account_id, amount_minor, balance_after_minor, kind,
       reference_type, reference_id, idempotency_key
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      input.tenantId,
      input.billingAccountId,
      input.amountMinor,
      balanceAfter,
      input.kind,
      input.referenceType ?? null,
      input.referenceId ?? null,
      input.idempotencyKey,
    ],
  );

  await db.query(
    `UPDATE billing_accounts
     SET balance_minor = $2, version = version + 1, updated_at = now()
     WHERE id = $1`,
    [input.billingAccountId, balanceAfter],
  );
}

export async function reconcileBillingAccount(
  tenantId: string,
  billingAccountId: string,
  pool: DbPool,
): Promise<{
  account_balance_minor: number;
  ledger_balance_minor: number;
  invoices_outstanding_minor: number;
  payments_succeeded_minor: number;
  balanced: boolean;
}> {
  return withTenant(tenantId, async (db) => {
    const account = await db.query<{ balance_minor: number }>(
      `SELECT balance_minor FROM billing_accounts WHERE id = $1`,
      [billingAccountId],
    );
    if (!account.rows[0]) throw notFound('Billing account not found');

    const ledger = await db.query<{ balance: string }>(
      `SELECT COALESCE(SUM(amount_minor), 0)::text AS balance
       FROM finance_ledger_entries WHERE billing_account_id = $1`,
      [billingAccountId],
    );

    const outstanding = await db.query<{ amount: string }>(
      `SELECT COALESCE(SUM(total_minor - amount_paid_minor), 0)::text AS amount
       FROM invoices
       WHERE billing_account_id = $1 AND status = 'issued'`,
      [billingAccountId],
    );

    const payments = await db.query<{ amount: string }>(
      `SELECT COALESCE(SUM(amount_minor), 0)::text AS amount
       FROM payment_attempts
       WHERE billing_account_id = $1 AND status = 'succeeded'`,
      [billingAccountId],
    );

    const accountBalance = account.rows[0].balance_minor;
    const ledgerBalance = Number(ledger.rows[0]!.balance);
    return {
      account_balance_minor: accountBalance,
      ledger_balance_minor: ledgerBalance,
      invoices_outstanding_minor: Number(outstanding.rows[0]!.amount),
      payments_succeeded_minor: Number(payments.rows[0]!.amount),
      balanced: accountBalance === ledgerBalance,
    };
  }, pool);
}

function mapInvoice(row: InvoiceRow): InvoiceRow {
  return {
    ...row,
    pricing_snapshot:
      typeof row.pricing_snapshot === 'string'
        ? JSON.parse(row.pricing_snapshot)
        : row.pricing_snapshot,
  };
}
