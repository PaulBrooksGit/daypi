import type { DbClient, DbPool } from '../../../platform/db/src/pool.js';
import { withTenant } from '../../../platform/db/src/index.js';
import { writeAudit } from '../../../platform/audit/src/index.js';
import { conflict, validationError, featureDisabled } from '../../../platform/http/src/errors.js';

export interface UsageAccountRow {
  tenant_id: string;
  balance_minor: number;
  currency: string;
  version: number;
}

export interface UsageLedgerEntryRow {
  id: string;
  tenant_id: string;
  amount_minor: number;
  balance_after_minor: number;
  kind: string;
  reference_type: string | null;
  reference_id: string | null;
  idempotency_key: string;
  created_at: Date;
}

export async function getUsageAccount(
  tenantId: string,
  pool: DbPool,
): Promise<UsageAccountRow> {
  return withTenant(tenantId, async (db) => {
    const res = await db.query<UsageAccountRow>(
      `SELECT tenant_id, balance_minor, currency, version FROM usage_accounts WHERE tenant_id = $1`,
      [tenantId],
    );
    if (!res.rows[0]) throw validationError('Usage account missing');
    return res.rows[0];
  }, pool);
}

export async function listUsageLedger(
  tenantId: string,
  limit = 50,
  pool?: DbPool,
): Promise<UsageLedgerEntryRow[]> {
  return withTenant(tenantId, async (db) => {
    const res = await db.query<UsageLedgerEntryRow>(
      `SELECT id, tenant_id, amount_minor, balance_after_minor, kind,
              reference_type, reference_id, idempotency_key, created_at
       FROM usage_ledger_entries
       ORDER BY created_at DESC
       LIMIT $1`,
      [Math.min(limit, 100)],
    );
    return res.rows;
  }, pool);
}

/**
 * Sandbox top-up via purchase kind only. Promotional grants remain disabled (D04).
 */
export async function sandboxPurchaseCredit(
  input: {
    tenantId: string;
    actorUserId: string;
    amountMinor: number;
    idempotencyKey: string;
    allowPromotionalGrants?: boolean;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<{ account: UsageAccountRow; entry: UsageLedgerEntryRow }> {
  if (input.amountMinor <= 0) throw validationError('amount_minor must be positive');

  return withTenant(input.tenantId, async (db) => {
    const existing = await findByIdempotency(db, input.idempotencyKey);
    if (existing) {
      const account = await lockAccount(db, input.tenantId);
      return { account, entry: existing };
    }

    const result = await appendLedger(db, {
      tenantId: input.tenantId,
      amountMinor: input.amountMinor,
      kind: 'purchase',
      idempotencyKey: input.idempotencyKey,
      referenceType: 'sandbox_top_up',
    });

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'usage.purchase',
      entityType: 'usage_ledger_entry',
      entityId: result.entry.id,
      correlationId: input.correlationId,
      metadata: { amount_minor: input.amountMinor },
    });

    return result;
  }, pool);
}

export async function reserveUsage(
  db: DbClient,
  input: {
    tenantId: string;
    amountMinor: number;
    idempotencyKey: string;
    referenceType?: string;
    referenceId?: string;
  },
): Promise<UsageLedgerEntryRow> {
  if (input.amountMinor <= 0) throw validationError('reserve amount must be positive');
  const existing = await findByIdempotency(db, input.idempotencyKey);
  if (existing) return existing;

  const account = await lockAccount(db, input.tenantId);
  if (account.balance_minor < input.amountMinor) {
    throw conflict('Insufficient usage credit', {
      balance_minor: account.balance_minor,
      required_minor: input.amountMinor,
    });
  }

  // Reservation debits available balance (negative amount)
  return (
    await appendLedger(db, {
      tenantId: input.tenantId,
      amountMinor: -input.amountMinor,
      kind: 'reservation',
      idempotencyKey: input.idempotencyKey,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
    })
  ).entry;
}

export async function settleUsageReservation(
  db: DbClient,
  input: {
    tenantId: string;
    reservedMinor: number;
    actualMinor: number;
    reserveIdempotencyKey: string;
    settleIdempotencyKey: string;
    releaseIdempotencyKey: string;
    referenceType?: string;
    referenceId?: string;
  },
): Promise<{ charge?: UsageLedgerEntryRow; release?: UsageLedgerEntryRow }> {
  if (input.actualMinor < 0 || input.actualMinor > input.reservedMinor) {
    throw validationError('actual charge must be within reserved amount');
  }

  const out: { charge?: UsageLedgerEntryRow; release?: UsageLedgerEntryRow } = {};

  // Reservation already debited reservedMinor. Convert to charge of actual,
  // release unused (credit back reserved - actual).
  if (input.actualMinor > 0) {
    const existingCharge = await findByIdempotency(db, input.settleIdempotencyKey);
    if (existingCharge) {
      out.charge = existingCharge;
    } else {
      // Net effect already reserved; record charge as zero-delta marker via adjustment of 0 not allowed.
      // Pattern: release full reservation, then charge actual (or release unused only).
      // Simpler: release unused = reserved - actual as positive credit.
    }
  }

  const unused = input.reservedMinor - input.actualMinor;
  if (unused > 0) {
    const existingRelease = await findByIdempotency(db, input.releaseIdempotencyKey);
    if (existingRelease) {
      out.release = existingRelease;
    } else {
      out.release = (
        await appendLedger(db, {
          tenantId: input.tenantId,
          amountMinor: unused,
          kind: 'release',
          idempotencyKey: input.releaseIdempotencyKey,
          referenceType: input.referenceType,
          referenceId: input.referenceId,
        })
      ).entry;
    }
  }

  if (input.actualMinor > 0) {
    const existingCharge = await findByIdempotency(db, input.settleIdempotencyKey);
    if (existingCharge) {
      out.charge = existingCharge;
    } else {
      // Reservation already removed funds; charge entry is informational with 0? Not allowed.
      // Use kind 'charge' with amount 0 forbidden — instead record charge of 0 by releasing unused only.
      // Bookkeeping: reservation (-R), release (+R-A) => net -A. Charge row for audit with amount -0 not allowed.
      // Add charge with amount_minor referencing actual as a zero-balance audit via kind charge of tiny?
      // Spec: charge kind with amount. After reservation, settle by releasing unused only; reserved amount
      // that remains unreased IS the charge. Optional explicit charge of 0 skipped.
      // For statement clarity, insert charge with amount_minor = -actual and simultaneously credit
      // +actual from converting reservation — net zero for that pair, then release unused.
      // Cleaner approach used here: release unused only; reserved that stays debited = charge.
      out.charge = undefined;
    }
  }

  // Explicit charge marker (amount 0 not allowed): write charge as reference-only using
  // release of 0 skipped. Add a charge entry that reverses reservation slice then re-debits.
  // Final chosen pattern for tests: reservation (-R), then if actual < R release +(R-A);
  // if we need explicit charge row: release +R then charge -A.
  return out;
}

/** Full settle: release reservation then post actual charge (idempotent). */
export async function settleReservedUsage(
  db: DbClient,
  input: {
    tenantId: string;
    reservedMinor: number;
    actualMinor: number;
    releaseAllKey: string;
    chargeKey: string;
    referenceType?: string;
    referenceId?: string;
  },
): Promise<{ release: UsageLedgerEntryRow; charge: UsageLedgerEntryRow | null }> {
  if (input.actualMinor < 0 || input.actualMinor > input.reservedMinor) {
    throw validationError('actual charge must be within reserved amount');
  }

  const existingRelease = await findByIdempotency(db, input.releaseAllKey);
  const release =
    existingRelease ??
    (
      await appendLedger(db, {
        tenantId: input.tenantId,
        amountMinor: input.reservedMinor,
        kind: 'release',
        idempotencyKey: input.releaseAllKey,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
      })
    ).entry;

  let charge: UsageLedgerEntryRow | null = null;
  if (input.actualMinor > 0) {
    const existingCharge = await findByIdempotency(db, input.chargeKey);
    charge =
      existingCharge ??
      (
        await appendLedger(db, {
          tenantId: input.tenantId,
          amountMinor: -input.actualMinor,
          kind: 'charge',
          idempotencyKey: input.chargeKey,
          referenceType: input.referenceType,
          referenceId: input.referenceId,
        })
      ).entry;
  }

  return { release, charge };
}

export async function assertPromotionalGrantsDisabled(
  allowPromotionalGrants: boolean,
): Promise<void> {
  if (!allowPromotionalGrants) {
    // Callers must not use kind=grant for welcome credit until D04.
    return;
  }
  throw featureDisabled('usage.promotional_grants');
}

async function lockAccount(db: DbClient, tenantId: string): Promise<UsageAccountRow> {
  const res = await db.query<UsageAccountRow>(
    `SELECT tenant_id, balance_minor, currency, version
     FROM usage_accounts WHERE tenant_id = $1 FOR UPDATE`,
    [tenantId],
  );
  if (!res.rows[0]) throw validationError('Usage account missing');
  return res.rows[0];
}

async function findByIdempotency(
  db: DbClient,
  idempotencyKey: string,
): Promise<UsageLedgerEntryRow | null> {
  const res = await db.query<UsageLedgerEntryRow>(
    `SELECT id, tenant_id, amount_minor, balance_after_minor, kind,
            reference_type, reference_id, idempotency_key, created_at
     FROM usage_ledger_entries WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return res.rows[0] ?? null;
}

async function appendLedger(
  db: DbClient,
  input: {
    tenantId: string;
    amountMinor: number;
    kind: string;
    idempotencyKey: string;
    referenceType?: string;
    referenceId?: string;
  },
): Promise<{ account: UsageAccountRow; entry: UsageLedgerEntryRow }> {
  const account = await lockAccount(db, input.tenantId);
  const balanceAfter = account.balance_minor + input.amountMinor;
  if (balanceAfter < 0) {
    throw conflict('Insufficient usage credit', {
      balance_minor: account.balance_minor,
      delta_minor: input.amountMinor,
    });
  }

  const entry = await db.query<UsageLedgerEntryRow>(
    `INSERT INTO usage_ledger_entries (
       tenant_id, amount_minor, balance_after_minor, kind,
       reference_type, reference_id, idempotency_key
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, tenant_id, amount_minor, balance_after_minor, kind,
               reference_type, reference_id, idempotency_key, created_at`,
    [
      input.tenantId,
      input.amountMinor,
      balanceAfter,
      input.kind,
      input.referenceType ?? null,
      input.referenceId ?? null,
      input.idempotencyKey,
    ],
  );

  const updated = await db.query<UsageAccountRow>(
    `UPDATE usage_accounts
     SET balance_minor = $2, version = version + 1, updated_at = now()
     WHERE tenant_id = $1
     RETURNING tenant_id, balance_minor, currency, version`,
    [input.tenantId, balanceAfter],
  );

  return { account: updated.rows[0]!, entry: entry.rows[0]! };
}
