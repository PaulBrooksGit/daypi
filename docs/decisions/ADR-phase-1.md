# ADR — Phase 1 DayCore minimum

Status: Implemented on branch for Phase 1 gate  
Authority: Development Brief v2 §16 Phase 1; Phase 0 ADRs remain in force.

## Decision

Deliver DayCore plus minimum DayByte and DayTeam required for the Phase 1 gate:

1. Children, guardians, relationships, enquiries/enrolments
2. Session definitions, dated sessions, bookings, reservations with transactional capacity
3. Registers (check-in/out) with append-only corrections
4. Staff profiles, planned rota, actual time events (separate records)
5. Minimal children import/export for synthetic pilot data

## Capacity safety

Confirmed bookings and active (non-expired) reservations consume capacity. Parent `bookings.create` produces `requested` (advisory). Staff confirm under `SELECT … FOR UPDATE` on `dated_sessions` so two claims for the final place cannot both succeed. Compliance ratio automation remains disabled (D01).

## Guardian boundaries

Parents see only children with active `child_guardian_relationship` (`access_level` full/limited, not revoked). Revocation is immediate. Checkout with a collector verifies authorised collector and active restrictions.

## Corrections

Attendance corrections are append-only. Original events are superseded, never rewritten or deleted, so register history remains auditable.

## Explicitly out of scope / disabled

D01–D12 unchanged: no live billing, auctions/DaySwap/DaySale, payroll, consequential AI, Hostinger, offline completion, or statutory ratio enforcement.
