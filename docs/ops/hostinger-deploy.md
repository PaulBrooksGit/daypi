# Hostinger deploy pack (pilot prep)

Status: **practical pilot prep** — not Phase 4 commerce, not live Stripe/Twilio, and not a Hostinger account login runbook. Use this pack to place DayPI on a UK-friendly Hostinger VPS / Node-capable host when Paul is ready.

Authority: Development Brief v2. Production target preference: Hostinger. Pending decisions **D01** / **D11** stay Pending (see sibling notes). Do not invent live secrets.

## Process model

DayPI is a modular monolith with **two long-running Node processes** from the same release:

| Process | npm script (prod) | Role |
| --- | --- | --- |
| API | `npm run start:api` | Express HTTP `/v1` (auth, tenancy, DayCore–DayText, Phase 3 modules) |
| DayPush worker | `npm run start:worker` | Outbox poller — sandbox SMS send, storage scan stubs, payment intent notes |

Same codebase, same `DATABASE_URL`, same feature gates. Do **not** run only the API in pilot: queued `messages.send_sandbox` and related outbox events need the worker (the smoke script can call `/v1/messages/:id/sandbox-send` as a bypass for local demos).

Web UI (`apps/web`) is still a stub — pilot is API + worker.

```text
Internet → HTTPS reverse proxy → API :3001
                                 ↓
                         PostgreSQL 16
DayPush worker ──────────────────┘  (polls outbox / jobs)
```

## Recommended Hostinger layout

**Proposed** for a first pilot (VPS with root/SSH):

```text
/opt/daypi/
  app/                 # git checkout of a release tag or main
  .env                 # production env (mode 0600; never commit)
  data/
    storage/           # STORAGE_LOCAL_ROOT if still on local disk
    backups/           # pg_dump artefacts
  logs/                # optional process logs if not using journald
```

Suggested Hostinger product: **VPS** (not shared PHP hosting). DayPI needs Node ≥ 20, PostgreSQL 16, long-running processes, and outbound HTTPS. Shared “Node app” panels can work for a single process but make the dual-process + Postgres layout awkward — prefer VPS.

Minimum practical VPS sketch (pilot, synthetic / low traffic):

- 2 vCPU / 4 GB RAM / 40+ GB disk
- Ubuntu 22.04 or 24.04 LTS
- Node 20 or 22 (see `.nvmrc`; CI uses 22)
- PostgreSQL 16 on-box **or** managed Postgres in the same region
- Reverse proxy: Caddy (automatic HTTPS) or nginx + Let’s Encrypt
- Process supervision: systemd units for `daypi-api` and `daypi-worker`

Optional later: object storage (S3-compatible) instead of local disk; Redis is **not** required today (see below).

Compose for a laptop / throwaway VPS rehearsal: [`deploy/hostinger/docker-compose.yml`](../../deploy/hostinger/docker-compose.yml).

## Postgres + Redis

### PostgreSQL 16 — **required**

- Application role: `daypi_app` — `NOSUPERUSER`, **no** `BYPASSRLS`, not table owner.
- Migrator role: `daypi_migrator` — owns tables / applies `db/migrations/*.sql`.
- Extensions: `citext`, `pgcrypto`.
- Separate DB names for local/test vs pilot (never share a live child-data DB with CI).
- Bootstrap helper: [`scripts/hostinger/bootstrap-db.sh`](../../scripts/hostinger/bootstrap-db.sh).

Connection pooling: keep transaction-scoped tenant context (`withTenant` / `app.tenant_id`). Prefer modest `max` pool sizes per process; do not share one pooled connection across tenants without resetting context.

### Redis — **not required for current pilot**

There is **no** Redis client or `REDIS_*` env in this codebase. DayPush durability is the **PostgreSQL outbox**, polled by the worker. Do not block Hostinger pilot on Redis. If Hostinger bundles Redis, leave it unused until a later ADR introduces caching or an alternate queue.

## Environment checklist

Source of truth: root [`.env.example`](../../.env.example). Production checklist mirror: [`deploy/hostinger/env.production.example`](../../deploy/hostinger/env.production.example).

| Variable | Pilot notes |
| --- | --- |
| `NODE_ENV` | `production` |
| `PORT` | Internal listen port (e.g. `3001`); proxy terminates TLS |
| `DATABASE_URL` | `daypi_app` connection string |
| `MIGRATION_DATABASE_URL` | `daypi_migrator` — used only for `npm run migrate` |
| `SESSION_SECRET` | Long random (≥16); generate on host, never commit |
| `COOKIE_SECURE` | `true` behind HTTPS |
| `CORS_ORIGINS` | Exact pilot web origins if any; otherwise leave tight |
| `TRUSTED_PROXIES` | Proxy CIDRs / addresses so forwarded host/IP are trusted |
| `ALLOWED_HOSTS` | Exact public hostnames (API rejects unknown Host) |
| `FEATURE_*` | Keep all live/commerce flags **`false`** for pilot prep |
| `STORAGE_DRIVER` | `local` for early pilot; `s3` when bucket ready |
| `STORAGE_LOCAL_ROOT` | Absolute path under `/opt/daypi/data/storage` |
| `S3_*` | Fill only when using S3-compatible storage |
| `STRIPE_WEBHOOK_SECRET` / `TWILIO_WEBHOOK_SECRET` | Sandbox HMAC optional; empty accepts unsigned in non-live mode — do **not** enable `FEATURE_STRIPE_LIVE` |
| `LOG_LEVEL` | `info` |

Never put live child data, live Stripe keys, or live Twilio credentials in pilot env until D05 / messaging commercial rules and D11 are approved.

## Migration steps

1. Provision Postgres roles/DB (`bootstrap-db.sh` or equivalent).
2. Copy env: `cp deploy/hostinger/env.production.example /opt/daypi/.env` and edit secrets locally on the host.
3. Install: `npm ci --omit=dev` (or `npm ci` if you build on the box with TypeScript).
4. Build: `npm run build`.
5. Migrate: `npm run migrate` (uses `MIGRATION_DATABASE_URL`).
6. Optional synthetic seed (**dev/pilot only**): `npm run seed` — password `Passw0rd!dev`, emails `*@example.test`.
7. Start API + worker under systemd (or `docker compose up`).
8. Health: `GET /v1/health` and `GET /v1/ready` through the public HTTPS name.
9. Run [`scripts/pilot-smoke.ts`](../../scripts/pilot-smoke.ts) against the API (synthetic only).

Rollback sketch: keep previous release directory; restore DB from last verified dump if a migration is unsafe; reverse proxy can point back to the previous release. Prefer forward-fix migrations; do not invent automatic down migrations that are not in-repo.

## HTTPS reverse proxy

- Terminate TLS at Caddy or nginx; proxy to `127.0.0.1:3001`.
- Set `TRUSTED_PROXIES` to the proxy.
- Put the public hostname in `ALLOWED_HOSTS` (exact match, lowercased).
- `COOKIE_SECURE=true`.
- Examples: [`deploy/hostinger/Caddyfile.example`](../../deploy/hostinger/Caddyfile.example), [`deploy/hostinger/nginx.conf.example`](../../deploy/hostinger/nginx.conf.example).

Do not expose Postgres or the worker port publicly.

## Backup / restore checklist

Scripts: [`scripts/hostinger/backup.sh`](../../scripts/hostinger/backup.sh), [`scripts/hostinger/restore.sh`](../../scripts/hostinger/restore.sh).

Before pilot traffic (even synthetic):

- [ ] Nightly `pg_dump` (custom or plain) of the pilot DB to encrypted / access-controlled storage
- [ ] Include `STORAGE_LOCAL_ROOT` (or S3 versioning) in backup scope
- [ ] Record which migration ID is current (`schema_migrations`)
- [ ] Restore drill onto a **scratch** database; confirm `/v1/ready` and a read of synthetic fixtures
- [ ] Document RPO/RTO targets under **D11** (still Pending — do not invent approved numbers)

A successful backup job alone is not a tested restore (Brief §15).

## Pilot bugfix included

Migration `028_membership_list_row_security.sql` + `/v1/auth/me` cleanup: memberships listing before tenant select no longer hits FORCE RLS. Required for smoke login → membership discovery. Apply with `npm run migrate`.

## Explicit non-goals (this pack)

- Phase 4: DayTown, DayShop, DaySwap, DaySale
- Live Stripe Connect / live Twilio
- Logging into Paul’s Hostinger account from this agent
- Approving D01 Ofsted rules or D11 retention schedules

## Related docs

- [Pilot smoke](./pilot-smoke.md)
- [D01 England / Ofsted notes (Pending)](./d01-england-ofsted-notes.md)
- [D11 UK region / retention options (Pending)](./d11-uk-region-retention-notes.md)
