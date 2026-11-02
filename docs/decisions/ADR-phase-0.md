# Phase 0 ADR summary (in-repo)

Status: Implemented foundation aligned with project-store `phase-0-architecture-decisions.md`.

| ADR | Decision |
| --- | --- |
| ADR-01 | Modular monolith: `apps/api`, `apps/worker`, `modules/*`, `platform/*` |
| ADR-02 | Single app + `/v1` API; local host allowlist only (D02 pending) |
| ADR-03 | Tenant isolation via membership + composite FKs + RLS; `daypi_app` has no BYPASSRLS; transaction-local `app.tenant_id` |
| ADR-04 | Session cookie + Bearer; MFA hook; invitations with expiry |
| ADR-05 | Transactional outbox + DayPush worker skeleton |
| ADR-06 | Usage ledger + draft subscription tables; live billing/grants disabled |
| ADR-07 | Consequential AI execute routes hard-gated |
| ADR-08 | Node 20+, Express, TypeScript, PostgreSQL 16, local/S3-compatible storage stub |
| ADR-09 | OpenAPI for implemented routes only under `contracts/openapi/` |
| ADR-10/11 | Compliance automation, offline, GPS disabled |

Pinned at implementation: **Node ≥20**, **PostgreSQL 16**.
