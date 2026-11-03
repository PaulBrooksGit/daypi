# DayPI

API-first multi-tenant platform for childminders and small nurseries.

**Phase 1 DayCore minimum** — builds on the Phase 0 foundation with children/guardians, enquiries/enrolments, sessions/bookings/capacity, registers with corrections, staff/rota/time records, and minimal import/export for synthetic pilot data.

Authority: Development Brief v2. Pending owner decisions **D01–D12** are not invented; auctions, live charges, payroll, consequential AI, and Hostinger stay disabled / unconfigured.

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
contracts/openapi/ Implemented routes only
db/migrations/     Versioned SQL
tests/integration/ Isolation + Phase 1 gate tests
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

## Phase 1 gate coverage

| Scenario | Expected |
| --- | --- |
| Parent linked to one sibling only / access revoked | Only authorised records |
| Two confirms claim the final place | At most one confirmed booking |
| Register check-in/out + correction | Operational status accurate; history not rewritten |

## Tests / CI

```bash
npm run typecheck
npm test
```

CI runs typecheck, lint, unit + integration tests against Postgres 16.

## Hostinger

Planned production host later — **not configured**.
