# D11 — UK region / retention options (Pending)

**Status: Pending** (Development Brief v2 §17 D11).  
Document **options** for hosting region, retention, support access, availability and recovery. Do **not** treat any option below as an approved policy. No live child data until D11 (and related privacy items in Brief §15) are approved.

## Hosting / data region — options (unapproved)

| Option | Sketch | Notes |
| --- | --- | --- |
| A | Hostinger VPS in a UK/EU data centre Paul selects | Aligns with Hostinger preference; confirm exact region with Hostinger at provision time |
| B | UK-region managed PostgreSQL + UK VPS app tier | Separates DB HA from app VM; still Pending for vendor choice |
| C | Defer production region until DPIA / contracts reviewed | Keep pilot on synthetic data only |

**Not decided:** exact Hostinger region code, multi-AZ requirements, or cross-border processing for AI/SMS vendors.

## Retention — options (unapproved)

| Option | Sketch |
| --- | --- |
| A | Tenant-configurable retention schedules with platform defaults TBD |
| B | Fixed platform schedule by record class (children, invoices, signatures, audit) TBD after legal review |
| C | Legal-hold overrides + export/delete procedures before any automated purge |

Do not invent day counts or “delete after N years” as approved rules. Signed documents and issued invoices already have **immutability** engineering constraints; that is not a retention schedule.

## Support access / availability / recovery — options (unapproved)

| Topic | Options to decide later |
| --- | --- |
| Support access | Time-limited break-glass only (`FEATURE_SUPPORT_BREAK_GLASS` stays false); no routine unrestricted access |
| Availability target | e.g. best-effort pilot vs measured SLO — numbers **Pending** |
| RPO / RTO | Define after restore drills; backup scripts exist, targets do not |

## Safe development treatment (Brief)

> Document options; no live child data until approved.

Related ops: [hostinger-deploy.md](./hostinger-deploy.md) backup/restore checklist.
