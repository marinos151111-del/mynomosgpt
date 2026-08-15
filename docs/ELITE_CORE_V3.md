# Elite Core V3 — lawyer-facing Nomologies extraction

## Purpose

`elite-core-v3` is a candidate-only, simplified extraction architecture for the lawyer-facing case card. It does not alter `cases.current_version_id`, publication status, Search V10, or the live frontend during validation.

## Model and call budget

- Model: `gpt-5.4-mini`
- Three extraction calls run in parallel:
  1. identity and judicial composition;
  2. material facts, simple legal issues, principles/holdings and genuine obiter;
  3. outcome, orders, money, legislation and authorities.
- One deterministic exact-evidence pass.
- At most one targeted repair call where a required field lacks exact evidence.
- One final attribution verifier.
- No LLM section mapper.
- No whole-judgment synthesis.
- No automatic chronology, witnesses, evidence inventory or detailed submissions.

## Core record

### Header

- case name;
- case number;
- court;
- decision date;
- case family;
- primary legislation and exact provisions;
- outcome;
- precedential weight: `Υψηλή`, `Μέση`, or `Χαμηλή`.

### Visible legal sections

1. Ουσιώδη Πραγματικά Περιστατικά.
2. Νομικό Ζήτημα, concise legal principle and case-specific holding.
3. Obiter dictum, or an honest `not_found` state.
4. Διατακτικό, Διατάγματα & Έξοδα.
5. Νομοθεσία & Αυθεντίες.
6. Σύνθεση Δικαστηρίου, distinguishing presiding from authoring judge.

## Evidence contract

Every available scalar field and every list item must contain:

- exact source paragraph IDs;
- an exact verbatim quotation;
- successful deterministic quote and contiguity validation.

The final verifier separately checks:

- present-court attribution versus submissions and quoted authorities;
- final orders versus earlier or quoted orders;
- damages, costs, interest and procedural stages;
- provision-to-instrument ownership;
- judicial roles;
- genuine obiter status.

## Safety contract

- Results are written only to `nomologies.core_v3_runs` and `nomologies.core_v3_tasks`.
- Artifacts use `nomologies-artifacts/core-v3/runs/<run-id>/...`.
- No core-v3 run can publish or replace an existing case version.
- Public search is not reindexed from core-v3 candidates.

## Five-case gate

The first gate uses:

1. Elena Sokratous;
2. St. Afxentios Medical Centre;
3. Palaontas;
4. Mattheos Ioannou Motor Agency;
5. Alexander Keith Edward.

A production cutover is prohibited unless all five are reviewed field by field and the current canonical versions remain unchanged.
