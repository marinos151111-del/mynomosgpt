# Elite Multi-Agent Extraction Pipeline — Contract & Build Plan

Status: approved target defined, build gated on frontend work finishing in Figma Make.
Target Supabase project: `My Nomos AI original` (`vstpdsvowewfgqdzowmt`), Edge Function `make-server-a776a6d3`.

## 1. Goal

Replace the current single-call "lite" case parser with a multi-agent, evidence-first
pipeline whose output matches the approved rendering of
**ΕΛΕΝΗ ΣΩΚΡΑΤΟΥΣ v. ΑΝΝΙΤΑΣ ΝΙΚΟΛΑΟΥ, Πολιτική Έφεση Αρ. 405/2016** (the "gold
rendering"), and to remove dead code from the deployed Edge Function at the same time.

The pipeline design fuses:

- the **Nomologies V2 engine** in this repo (`src/nomologies-v2/`): section map,
  specialist agents, per-paragraph evidence grounding, independent reviewer,
  readiness scoring; and
- the **operational layer already live** in the Make server: bulk discover/fetch,
  dedupe, readiness gate, deploy, grounded indexer, search, embeddings, case chat.

Only the parser core changes. The bulk workflow, deploy gate and indexer stay.

## 2. Record contract (what the parser must output)

### 2.0 Canonical section order (as approved in the gold rendering)

The case page renders in EXACTLY this order — the record and the UI must both
follow it:

1. Case header (name, appeal number, court, date, primary law + articles, badges:
   outcome, Βαρύτητα, case type, proceeding type)
2. Κυρίαρχη Νομική Αρχή
3. Ουσιώδη Πραγματικά Περιστατικά
4. Διαδικαστική Πορεία
5. Νομικά Ζητήματα & Κρίση (numbered, each with the court's κρίση)
6. Διατακτικό, Διατάγματα & Έξοδα (verbatim διατακτικό + structured orders)
7. Νομοθεσία & Αυθεντίες (legislation first, then case authorities)
8. Σύνθεση Δικαστηρίου (after the authorities, near the end — incl. Παρέδωσε την απόφαση)
9. Λόγοι Έφεσης (all grounds with per-ground result)
10. Στοιχεία Απόφασης & Ευρετηρίαση (jurisdiction, Greek-only keywords)
11. Single AI action («Ρώτησε το AI») — one action, not separate Πλήρες κείμενο /
    CyLaw / chat buttons

The internal quality layer (evidence, confidence, review flags) is never rendered
on the public page.

Field names marked **(existing)** keep the current record's name so nothing already
rendering breaks. Fields marked **(new)** must be added to the record and the UI.

### 2.1 Identity & panel

| Field | Type | Notes |
|---|---|---|
| `name` (existing) | string | Formal case name, verbatim |
| `citation` (existing) | string | e.g. `Πολιτική Έφεση Αρ. 405/2016` |
| `ecli`, `docket`, `date`, `court` (existing) | string | date `DD/MM/YYYY` |
| `jurisdiction` (existing) | string | `Κύπρος` |
| `judges` (existing) | string[] | kept for compatibility |
| `panel` (new) | `{ name, role }[]` | role ∈ `presiding \| member` → UI: Προεδρεύων / Μέλος |
| `authorJudge` (existing) | string | The judge who **delivered** the judgment (Παρέδωσε την απόφαση) — NOT the first-listed/presiding judge unless the text says so. Must carry `authorEvidence` verbatim quote |

### 2.2 Classification & principle

| Field | Type | Notes |
|---|---|---|
| `caseType`, `caseFamily`, `courtLevel`, `proceedingType` (existing) | enums | Greek display labels in UI |
| `legalArea` (existing) | string | Greek only (e.g. `ιδιωτική ζωή / εμπιστευτικότητα`) |
| `dominantPrinciple` (new, replaces `legalPrinciple`) | string | Κυρίαρχη Νομική Αρχή — multi-sentence allowed, precise, never absolute beyond what the court held |
| `secondaryPrinciples` (existing) | `{ type, principle }[]` | deduplicated |
| `weight` (new) | enum `high \| medium \| low` | Βαρύτητα, from court level + panel + treatment of authorities |

### 2.3 Facts, procedure, issues, grounds

| Field | Type | Notes |
|---|---|---|
| `factsSummary` (existing) | string | Facts ONLY — must not contain the appellate holding (cross-contamination check) |
| `proceduralHistory` (existing) | string | e.g. first-instance court, what was appealed, withdrawn grounds |
| `legalIssues` (new, structured) | `{ n, issue, ruling }[]` | Numbered issues, each with the court's κρίση. **Deduplicated** (the gold rendering itself shows 01–04 duplicated as 05–08 — the pipeline must collapse those) |
| `groundsOfAppeal` (new) | `{ n, topic, summary, result }[]` | All grounds (22 in the gold case). result ∈ `succeeded \| failed \| not_determined \| withdrawn` → Επιτυχία / Απέτυχε / Δεν κρίθηκε / Αποσύρθηκε. Never render raw `unknown` |

### 2.4 Outcome & orders

| Field | Type | Notes |
|---|---|---|
| `outcome` (existing) | enum (24 values) | e.g. `appeal_allowed` |
| `dispositionText` (existing) | string | Verbatim διατακτικό, complete — including Registrar assessment and VAT clauses |
| `orders` (new) | `{ kind, stage, amount, currency, vat, payer, payee, assessedBy, evidenceQuote }[]` | kind ∈ `damages \| costs \| other`; stage ∈ `first_instance \| appeal`; `payer`/`payee` must be clean party designations (`Εφεσίβλητη`, `Εφεσείουσα`) — never text fragments like "της Εφεσίβλητης για το ποσό των €25". Amounts parsed as numbers with currency |

### 2.5 Legislation & authorities

| Field | Type | Notes |
|---|---|---|
| `primaryLaw`, `secondaryLaws` (existing) | as today | plus: |
| `legislation` (new) | `{ label, role, rationale, articles: { id, treatment }[] }[]` | role ∈ `primary \| secondary`; per-article treatment ∈ `cited \| interpreted \| applied` → Αναφέρθηκε / Ερμηνεύθηκε / Εφαρμόστηκε. Old vs new Civil Procedure Rules must be distinguished (`Δ.35, Καν. 8` of the former CPR ≠ ΚΠΔ 2023) |
| `citedCases` (existing) | upgraded | **Parallel citations merged into one entry** (`[2004] UKHL 22; [2004] 16 BHRC 500`), one deduplicated principle sentence per authority, treatment always classified (`followed \| applied \| distinguished \| overruled \| considered \| cited \| indirect`) → never «Άγνωστο» by default; **books/textbooks excluded** from cited cases (Tugendhat, Gatley → separate `literature` list if kept at all) |

### 2.6 Taxonomy & quality

| Field | Type | Notes |
|---|---|---|
| `issueTags`, `keywords` (existing) | string[] | **Greek only** (αναγνωρισιμότητα, εύλογη προσδοκία ιδιωτικότητας, …) |
| `confidence` (existing) | number **0–100** | FIX: current code stores model 0–1 value divided by 100 (a live case shows `0.0086`); normalise scale once, everywhere |
| `strictReady`, `reviewFlags`, `bulkReadiness` (existing) | as today | strict-ready gate becomes reachable again once confidence scale is fixed |
| `evidence` (new, internal) | per-field verbatim quotes + paragraph ids | every load-bearing field grounded; unverified evidence blanks the field and flags it (kept from lite core, extended to all agents) |

## 3. Pipeline architecture

Stage 0 — **Source preparation** (deterministic): decode (UTF-8 / windows-1253 /
iso-8859-7), strip HTML, split into stable numbered paragraphs. No truncation for
extraction: long judgments are windowed per-agent, not cut.

Stage 1 — **Section map** (1 model call): partition the judgment (header / facts /
procedural history / grounds / analysis per issue / disposition), validated for full
coverage and no overlap. Each specialist receives only its sections plus the header —
this is what stops facts/holding cross-contamination and wrong-judge errors.

Stage 2 — **Specialist agents** (parallel, one model call each):

1. `identity-panel` — name, citation, ECLI, court, date, panel roles, author judge
   (with evidence quote from the delivery line, e.g. "Η απόφαση θα δοθεί από…").
2. `facts-procedure` — factsSummary, proceduralHistory, chronology.
3. `grounds` — every ground of appeal with topic, summary and per-ground result.
4. `issues-analysis` — numbered legal issues with rulings, dominant principle,
   secondary principles, tests applied.
5. `legislation-authorities` — instruments with per-article treatments; cited cases
   with treatments and principles; literature separated from case authorities.
6. `disposition-orders` — verbatim διατακτικό + structured orders (amounts, payer,
   payee, stage, VAT, Registrar assessment).

Stage 3 — **Deterministic verification** (no model): every evidence quote checked
against the source with Greek/Latin homoglyph-tolerant matching (reuse of the
existing `evidenceInSource`); parallel-citation merge; issue/principle dedup;
enum validation; ΚΠΔ-2023 vs former-CPR disambiguation guard.

Stage 4 — **Independent reviewer** (1 model call): cross-checks the merged record
against source paragraphs, flags identity mismatches, fabrications,
cross-contamination, missing orders. Only identity-level errors block.

Stage 5 — **Scoring & gate**: readiness score 0–100 (weighted field coverage minus
conflicts), strictReady threshold, human-review-first below the bar. Feeds the
existing bulk approve gate unchanged.

Model tiering (uses keys already configured in the function): mini-tier model for
agents 1, 2, 3, 6; stronger tier for 4, 5 and the reviewer. Roughly 8 model calls
per judgment instead of 1 — cost rises accordingly; an `economy` mode can skip the
reviewer for records that cannot reach the publish bar (same idea as V2).

## 4. Known bugs fixed as part of the build

1. Confidence scale 0–1 vs 0–100 (stored `0.0086`, shows "0/100", strict-ready unreachable).
2. ΚΠΔ-2023 regex tagging former-CPR provisions (`Δ.35, Καν. 8`) as 2023 rules; malformed `Δ.35 θ.θ. 8` duplicate emission.
3. Cited-case dedupe missing parallel citations (Campbell, McKennitt duplicated).
4. Textbooks extracted as case authorities.
5. English tags leaking into a Greek UI.
6. Duplicated issue blocks and duplicated principle sentences.
7. Garbled payer/payee fragments in costs (`"της Εφεσίβλητης για το ποσό των €25"`).

## 5. Integration & cleanup plan (executes when the frontend work is finished)

1. Re-download the **latest** deployed function source (it has moved past the
   version already audited) and re-audit which modules are actually routed.
2. Remove dead weight — candidates from the audit, each verified against the final
   bundle before deletion:
   - `route-case-parse.ts` legacy multi-agent branch (throws by design; replaced by the new pipeline)
   - disabled stubs in `route-case-search.ts` (`citation-verify` / `citation-repair` / `reparse-identity` currently always fail) — re-wire to the new pipeline or remove the routes
   - `golden-cases` endpoint remnants (already 410, file absent from bundle)
   - any module unreachable from the mounted routers in the final bundle
   - statute-side modules (law-fetcher, prometheus, metadata, treaties, forms, emails) are **kept** — they serve the statute product.
3. Implement the pipeline as new modules behind the existing endpoints
   (`POST /case-law/parse`, reparse endpoints), preserving the request/response
   envelope the bulk UI already uses.
4. Deploy to `make-server-a776a6d3` via Supabase; verify end-to-end by re-parsing
   the gold judgment and diffing against the gold rendering.
5. Commit the full function source under `supabase/functions/make-server-a776a6d3/`
   in this repo so GitHub is the durable source of truth.

## 6. Operational rule (important)

Figma Make owns this Edge Function: any "publish" from Make **overwrites** a direct
Supabase deploy. After the pipeline is deployed, backend changes must either be
made through this repo + redeploy, or pasted back into Make first. The full source
committed in step 5.5 guarantees nothing is ever lost either way.
