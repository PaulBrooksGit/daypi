# DayPI

API-first multi-tenant platform for childminders and small nurseries.

**Phase 3** — Supporting services on top of Phases 0–2: DayMain (website CMS), DayMake (constrained AI drafts), DayStar (quality audits/testimonials), DayGrow (health records), DayStep (trips), DayCare (facilities).

Authority: Development Brief v2. Pending owner decisions **D01–D12** are not invented; auctions, live charges, payroll, consequential AI, background GPS, and Hostinger stay disabled / unconfigured. Stripe and Twilio integrations are **sandbox-only** until commercial rules are approved.

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
modules/websites   DayMain (templates, draft/publish, domain stub)
modules/ai         DayMake (synthetic drafts; consequential execute gated)
modules/quality    DayStar (audit templates, moderated testimonials)
modules/health     DayGrow (allergies/conditions/care plans/observations)
modules/trips      DayStep (permissions, headcounts, online location samples)
modules/facilities DayCare (assets, inspections, maintenance)
contracts/openapi/ Implemented routes only
db/migrations/     Versioned SQL
tests/integration/ Isolation + Phase 1/2/3 gate tests
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

## Hostinger pilot prep

Production target preference is Hostinger (UK-friendly VPS / Node). This repo ships a **deploy pack** and synthetic **pilot smoke** — not live Stripe/Twilio, not Phase 4 commerce, and not Hostinger account login.

| Doc / artefact | Path |
| --- | --- |
| Deploy pack | [`docs/ops/hostinger-deploy.md`](docs/ops/hostinger-deploy.md) |
| Pilot smoke | [`docs/ops/pilot-smoke.md`](docs/ops/pilot-smoke.md) · `npm run smoke:pilot` |
| D01 / D11 notes (Pending) | [`docs/ops/d01-england-ofsted-notes.md`](docs/ops/d01-england-ofsted-notes.md), [`docs/ops/d11-uk-region-retention-notes.md`](docs/ops/d11-uk-region-retention-notes.md) |
| Compose rehearsal | [`deploy/hostinger/docker-compose.yml`](deploy/hostinger/docker-compose.yml) |

Redis is **not** required today (Postgres outbox). Keep all `FEATURE_*` live flags false for pilot.
