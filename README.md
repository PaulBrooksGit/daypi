# DayPI

API-first multi-tenant platform for childminders and small nurseries.

**Phase 2** — DayDocs (versioned documents/consents), core DayBank (childcare invoicing + usage ledger), and DayText (messaging with delivery tracking). Builds on Phase 0 foundation and Phase 1 DayCore minimum.

Authority: Development Brief v2. Pending owner decisions **D01–D12** are not invented; auctions, live charges, payroll, consequential AI, and Hostinger stay disabled / unconfigured. Stripe and Twilio integrations are **sandbox-only** until commercial rules are approved.

## Stack (pinned)

- Node.js ≥ 20
- PostgreSQL 16
- Express + TypeScript (strict)
- Vitest + Supertest (real Postgres for integration tests)

## Layout

```text
apps/api/          HTTP API (/v1)
apps/worker/       DayPush outbox worker
apps/web/          Frontend stub (framework TBD before scaffold)
platform/          auth, authz, tenancy, db, audit, jobs, storage, http, config
modules/core/      DayCore (families, sessions, bookings, import/export)
modules/operations DayByte (registers / attendance)
modules/team/      DayTeam (staff, rota, time)
modules/documents  DayDocs (versions, consents, signatures)
modules/finance    DayBank (invoices, payments, usage ledger)
modules/messaging  DayText (messages, delivery, prefs)
contracts/openapi/ Implemented routes only
db/migrations/     Versioned SQL
tests/integration/ Isolation + Phase 1/2 gate tests
docs/decisions/    In-repo ADR + threat model notes
```

## Local setup

```bash
cp .env.example .env
# Create roles/databases (see CI workflow)
npm install
npm run migrate
npm run seed
npm run dev:api
```

Default seeded password: `Passw0rd!dev` (synthetic emails `*@example.test`).

## Phase 2 gate coverage

| Scenario | Expected |
| --- | --- |
| Same payment/webhook replayed | One financial effect; duplicate recognised |
| Billing account reconciliation | Ledger balance matches account; allocations consistent |
| Signed policy later edited | Original signed version/evidence retrievable unchanged |
| Marketing SMS to opted-out guardian | Recipient skipped; transactional still allowed |

## Tests / CI

```bash
npm run typecheck
npm test
```

CI runs typecheck, lint, unit + integration tests against Postgres 16.

## Hostinger

Planned production host later — **not configured**.
