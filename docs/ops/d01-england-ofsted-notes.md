# D01 — England / Ofsted launch assumptions (Pending)

**Status: Pending** (Development Brief v2 §17 D01).  
This note records **working assumptions for England pilot planning only**. It does **not** approve regulatory sources, setting types, or automated compliance scoring.

## Working assumption (unapproved)

- **Launch nation for first Hostinger pilot discussion:** England (UK).
- **Illustrative setting types in product copy / seed data:** childminder and small nursery.
- **Regulatory label often discussed:** Ofsted-registered childcare in England.

None of the above is an approved production rule set.

## What must stay off until D01 is approved

- Hard-coded age/staffing **ratios** presented as compliance.
- Automated “Ofsted ready” or inspection-pass claims.
- Jurisdiction-specific capacity enforcement beyond synthetic / advisory checks.
- Claims that DayStar scores or AI drafts establish official inspection compliance (Brief §12).

## Synthetic ratios (explicitly off)

Existing booking/capacity code may use **synthetic capacity numbers** (e.g. session `default_capacity`) for concurrency and pilot demos. Those figures are **not** Ofsted ratios, are **not** age-banded EYFS staffing rules, and must not be labelled as approved regulatory calculations.

## Safe development treatment (Brief)

> Synthetic rules only; compliance automation disabled.

Owner must confirm: launch nation(s), supported setting types, and regulatory sources/versioning before enabling compliance automation.
