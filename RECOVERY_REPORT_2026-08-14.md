# mynomosaigpt — Global Nomologies Extraction Recovery

**Date:** 14 August 2026  
**Supabase project:** `btfggtdysjgdjgmvqdbt`  
**Recovery branch:** `recovery/nomologies-six-specialist-20260814`  
**Scope:** Nomologies extraction, repair, publication safety and affected case projections.  
**Not changed:** the ChatGPT-Sites frontend, the approved left-panel UI, Search V10 ranking architecture, legislation services and unrelated cases.

## Incident

The deployed `elite-lean-v2` profile grouped `facts+procedure` and `analysis+authorities`, intentionally omitted parts of the rich legal record, and replaced whole grouped objects during repair. In confirmed runs, repair reduced readiness from 70→43, 66→48 and 51→35 while removing ratio, obiter, grounds and other legal fields. A manual publication override then allowed a damaged Elena version to become live.

## Production recovery completed

### Worker

The production `nomologies-worker` was restored to the committed six-specialist `elite-hybrid-v1` architecture:

- identity;
- facts;
- procedure;
- analysis;
- authorities; and
- outcome.

The worker continues to use whole-judgment synthesis, deterministic reconciliation, paragraph evidence validation, independent verification and targeted specialist repair.

Current deployed worker:

- Supabase Edge Function: `nomologies-worker`
- deployed version: **41**
- source branch: `recovery/nomologies-six-specialist-20260814`
- source commit: `6f5f6c84fd66f91177c58a941444973f6f474f52`

The recovery branch additionally contains:

- Greek-safe embedding input truncation, preventing the OpenAI 8,192-token ceiling from breaking long judgment indexing; and
- a deterministic monetary-order safety wrapper that does not treat a damages amount in an adjacent clause as a costs award.

### Global safety controls

The database now enforces:

1. `elite-lean-v2` grouped extraction and grouped repair stages are frozen.
2. A live published case cannot point to an `elite-lean-v2` version.
3. A field marked `available` cannot be empty for legally material fields.
4. A published case must contain a legal principle or ratio and an issue or holding.
5. A candidate cannot replace a published version if readiness falls, critical conflicts increase, or populated ratio/grounds/authorities/principle fields disappear.
6. If repair produces a lower score than initial verification, the initial verified record and reviewer artifacts are retained for persistence and the repair regression is recorded.
7. Every case-level recovery is recorded in `nomologies.case_recovery_events`.

### Restored case records

| Case | Damaged lean version | Restored rich version | Result |
|---|---|---|---|
| Elena Sokratous v Annitas Nikolaou | v12, 48/100 | v5 source, 87/100 | published; later cloned as corrected v14 to separate damages from costs |
| Takis Palaontas v Esfera Holdings Ltd | v10, 89/100 but incomplete | v8, 88/100 | published |
| St. Afxentios Medical Centre Ltd v Louka Tziella et al. | v2, 35/100 | v1, 83/100 | remains in review; not publicly published |

All damaged lean versions remain stored for forensic history. No case version was deleted.

### Elena monetary-order correction

The restored Elena record was cloned into version 14 with a narrow deterministic correction:

- damages: **€25,000**;
- first-instance costs: **no fixed amount; to be calculated by the Registrar**;
- appellate costs: **€3,400**;
- payer/payee fields corrected; and
- damages no longer carry an appellate-stage label.

Current Elena version ID: `b049e9ad-d741-42ff-8577-9aa19a232799`.

### Reindexing

All restored/current case versions were reindexed successfully. Their `case_search_documents.case_version_id` values match their live current-version pointers. Search fields, embeddings, smart tags, principle assertions, provision links and authority edges were rebuilt. Search V10 controlled concept links were then reattached from evidence-supported current fields.

### Search validation

The existing 18-query Greek/English/Greeklish smoke benchmark remains **18/18 top-one correct** after restoration. No stale current-version mismatch remains for published search documents.

## Temporary recovery functions

Two one-time worker-kick functions were used only to drain authorised recovery tasks. Both are now JWT-protected tombstones returning HTTP 410 `FUNCTION_DISABLED`:

- `nomologies-recovery-kick-20260814`
- `nomologies-recovery-kick-v2-20260814`

## Rollback and evidence

- The rich historical case versions were preserved and remain addressable by ID.
- Recovery events record every from/to version pointer.
- The former damaged lean versions remain available for forensic comparison.
- The current worker is sourced from an immutable Git commit rather than hand-edited production-only code.

## Remaining qualification

This recovery reinstates the rich production architecture and blocks the known destructive failure mode. It does not constitute a formal corpus-wide accuracy certification. Future extraction releases must be gated by human-reviewed golden cases covering ratio, obiter, authorities, grounds, evidence attribution and monetary orders before production cutover.
