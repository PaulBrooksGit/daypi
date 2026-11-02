# DayPI

API-first multi-tenant platform for childminders and small nurseries.

**Phase 0 foundation** — TypeScript Express modular monolith, PostgreSQL with tenant-aware FKs + RLS, auth/sessions, operation-level authorisation, audit/outbox worker skeleton, storage stubs, synthetic two-tenant fixtures, and isolation tests.

Authority: Development Brief v2. Pending owner decisions **D01–D12** are not invented; auctions, live charges, payroll, and consequential AI stay disabled.

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
modules/           Business module stubs (writes owned later)
contracts/openapi/ Implemented routes only
db/migrations/     Versioned SQL
tests/integration/ Isolation + pool-safety gate tests
docs/decisions/    In-repo ADR + threat model notes
```

## Local setup

```bash
cp .env.example .env
# Create roles/databases (see scripts notes / CI workflow)
npm install
npm run migrate
npm run seed
npm run dev:api
```

Default seeded password: `Passw0rd!dev` (synthetic emails `*@example.test`).

## Tests / CI

```bash
npm run typecheck
npm test
```

CI runs typecheck, lint, unit + integration tests against Postgres 16.

## Hostinger

Planned production host later — **not configured in Phase 0**.
