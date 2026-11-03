# ADR — Phase 2 Documents, billing and communications

Status: Implemented on branch for Phase 2 gate  
Authority: Development Brief v2 §16 Phase 2; Phase 0–1 ADRs remain in force.

## Decision

Deliver DayDocs, core DayBank and DayText required for the Phase 2 gate:

1. **DayDocs** — versioned documents, consent requests, immutable signature evidence tied to a specific `document_version`
2. **DayBank (core)** — childcare billing accounts, draft/issue invoices with immutable issued snapshots, sandbox payment attempts, allocations, append-only finance ledger, reconciliation helper; platform usage ledger reserve/settle/release with sandbox purchase top-ups only
3. **DayText** — transactional/marketing messages, delivery tracking, marketing preference skips, Twilio/Stripe **sandbox** webhooks with `webhook_receipts` dedupe

## Signed-version preservation

Consent signatures store `document_version_id` and `content_sha256_at_sign`. `document_versions` and `signature_evidence` are append-only. Editing a policy creates a new version; the signed version row remains retrievable unchanged.

## Payment / webhook replay

Inbound Stripe sandbox events are keyed by `(provider, provider_event_id)` on `webhook_receipts`. Replays return `already_processed` without a second payment allocation or finance ledger debit. Payment creates require `Idempotency-Key`.

## Financial reconciliation

`billing_accounts.balance_minor` is derived from append-only `finance_ledger_entries`. Reconciliation compares account balance to ledger sum and reports outstanding issued invoices vs succeeded payments.

## Explicitly out of scope / disabled

- D01–D12 unchanged: no invented commercial rates as approved production rules
- Live Stripe Connect collection (`FEATURE_STRIPE_LIVE`, `/payments/collect`) disabled
- Promotional usage grants disabled (D04); sandbox `purchase` top-ups only for tests
- DaySwap/DaySale, payroll, consequential AI, Hostinger, marketplace settlement not implemented
