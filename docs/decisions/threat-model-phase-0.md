# Phase 0 threat model notes (STRIDE-style)

Scope: foundation surfaces only (auth, tenancy, RLS, uploads, outbox/webhooks stubs).

## Spoofing

- Host header: exact allowlist; malformed/unrecognised hosts rejected.
- Tenant id: never taken from body/header for authorisation; session + membership only.
- Integration clients: hashed secrets, tenant-bound, verify via SECURITY DEFINER helper without data bypass.

## Tampering

- Composite tenant-aware FKs block cross-tenant child↔guardian links.
- Append-only audit and usage ledger triggers.
- Outbox processed with SKIP LOCKED; attempts logged.

## Repudiation

- Audit events for tenant select, invites, revokes, uploads, site/tenant updates.
- Support break-glass remains feature-flagged off (D11).

## Information disclosure

- RLS fail-closed without `app.tenant_id`.
- Parent sibling isolation enforced in application queries.
- File download checks tenant via RLS + app check; no metadata on miss.
- Logs redact token/secret/medical/photo keys.

## Denial of service

- Upload size/MIME limits; JSON body limit 1mb.
- Bounded pagination (max 100).
- Worker backoff and dead-letter status for poison messages.

## Elevation of privilege

- Operation-level grants; role name insufficient alone.
- Disabled ops (AI consequential, payroll, DaySwap/DaySale, marketplace, live GPS) hard-gated.
- App DB role cannot BYPASSRLS; FORCE RLS on tenant tables.

## Residual risks / pending decisions

- Production domains and auth topology (D02).
- Live child data and support access policy (D11).
- Provider webhook signature verification deepened in Phase 2.
