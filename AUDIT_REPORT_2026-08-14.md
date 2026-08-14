# mynomosaigpt — Full Technical Audit & Rating

**Prepared for:** Marino · **Date:** 2026-08-14 · **Scope:** `marinos151111-del/mynomosgpt` (all branches) + Supabase project `Nomologies V2 Lab` (`btfggtdysjgdjgmvqdbt`, eu-central-1) + live frontend forensics.
**Nature:** Read-only audit. Nothing was deployed, migrated, deleted, renamed or modified. No secret values are reproduced (names and masked hashes only).

> One product: **mynomosaigpt**. "Nomologies V2", "Nomologies V2 Lab", "Elite", "Shalida", "Prometheus" and "Make server" are internal engine/deployment code-names, not separate products.

---

## 0. Executive summary

The **core legal technology is genuinely strong and defensible** — an evidence-first judgment-extraction engine and a hybrid legal-search stack that are well above typical "legal AI" wrappers. The **productization around it is fragmented and not reproducible from Git**. There are effectively **three parallel backends** in production, **four separate API credentials**, the **live frontend source is not in the repository at all**, and the **deployed case pipeline runs code that exists in no commit**. As a piece of technology it rates highly; as a clean, sellable, rebuildable software asset it does not yet.

**Overall score: 5.5 / 10** against a serious commercial legal-research SaaS bar — held down almost entirely by fragmentation, deployment drift, reproducibility and the live backend's security posture, **not** by the quality of the core engine (which alone rates ~9).

Five things that matter most:
1. **Production case pipeline (`nomologies-worker`/`nomologies-api`) is deployed from uncommitted code** — 12 file-contents exist in no Git branch or history. You cannot currently rebuild production from the repo.
2. **The live lawyer-facing frontend is not in Git on any branch.** It lives only in the OpenAI/ChatGPT-Sites project. `apps/mynomos/` is an *English admin console*, not the live app.
3. **`make-server-3acdf682` is a real, large, live backend** (51 files, 2.25 MB, 106 routes — the MyNomos AI "v9.0.0" server), not a historical leftover. Its only auth is the platform JWT gate, so **any holder of the project anon key can reach every route, including destructive DELETEs**.
4. **Three overlapping legislation/search stacks** and **duplicate intake/search endpoints** exist; the newer structured legislation engine (`legislation-api-next`) is fully built and indexed but **served zero live traffic** in the audit window.
5. **Data-layer security is actually good** (RLS deny-all + service-role-only, hashed gateway keys, SSRF allow-listed to cylaw.org, no hardcoded secrets), but it is undermined by the JWT-only make-server, `verify_jwt=false` public functions, wildcard CORS, and a **public GitHub repository** holding the whole proprietary engine.

---

## 1. What is actually LIVE today (ground truth)

Determined from deployed Edge Function source (fetched verbatim), DB introspection, storage contents and 24h edge logs.

### 1.1 Deployed Edge Functions (11 active)

| Function | Ver | verify_jwt | Auth in code | Live role | Git parity |
|---|---|---|---|---|---|
| `make-server-3acdf682` | 1 | **true** | **none** (JWT gate only) | **MyNomos AI product backend** — legal chat (Opus 4.8 / GPT-5.4-mini / Grok), legislation Q&A (KV-based), case parse/deploy/search, forms, treaties. 106 routes. Highest traffic. | **None** (0/51 files in Git) |
| `nomologies-worker` | 37 | true | service-role bearer == key | **Live V2 case pipeline** worker (durable queue) | **Drifted / deployed-ahead** of `claude/prod-elite` + uncommitted layer |
| `nomologies-api` | 38 | **false** | gateway key `x-nomologies-key` (sha256 in code) | **Live case admin + search + chat** API | **Drifted / deployed-ahead**; not on `main` at all |
| `nomologies-search` | 13 | false | gateway key (same hash as api) | **Live case-law search** (index-first hybrid) | None (library lives in `src/nomologies-search`, function does not) |
| `nomologies-intake` | 5 | true | `NOMOLOGIES_ADMIN_KEY` (2nd credential) | Admin judgment intake (duplicates api `/intake`,`/bulk`) | None |
| `nomologies-health` | 4 | false | none (public) | Liveness/config probe | None |
| `nomologies-reset-current-manifest` | 3 | true | — | **Tombstoned** — body is `410 FUNCTION_DISABLED` | None |
| `legislation-api-next` | 10 | false | gateway key `bf81f9…` (3rd credential) | **Structured legislation engine** (built, indexed) — **0 live requests in window** | None |
| `legislation-api` | 29 | false | gateway key `bf81f9…` | Older near-duplicate of `-next` — 0 live requests | None |
| `legislation-answer-original-canary` | 5 | false | `x-canary-key` (4th credential) | Migration A/B verifier (original "Prometheus" engine) — 0 live requests | None |

**Successful live product traffic (24h):** `nomologies-search/search` → 200 (case-law search), `nomologies-api/cases/:id` → 200 (case reading). `make-server` had the most hits but the majority were `POST 401` (rejected at the JWT gate — likely bot probes to a `/wa…` path and/or a partially-reconfigured frontend) plus CORS preflights. **This ambiguity is itself a finding: the live frontend's exact backend wiring needs confirmation from the Sites project** (see §2).

### 1.2 Storage buckets (7)

| Bucket | Objects | Bytes | Purpose | Producer → Consumer | Verdict |
|---|---|---|---|---|---|
| `nomologies-artifacts` | 1,016 | 126 MB | Per-run V2 stage artifacts (`runs/<runId>/agents/*.json`, `sections.json`, `verification/*`, `record.json`, `reviewer.json`) | worker writes → api reads | **Production**, reproducible (re-derivable by re-running) |
| `nomologies-sources` | 170 | 11 MB | Original + normalized judgment text (`runs/<runId>/normalized.txt`, `intake/<hash>/*.txt`) | intake/worker write → worker reads | **Production**, semi-reproducible (CyLaw refetch) |
| `nomologies-exports` | 0 | 0 | Intended export target | — | Unused (keep as designed) |
| `nomologies-dead-letter` | 0 | 0 | Failed-pipeline DLQ | — | Unused; empty = no poison messages (good) |
| `legislation-sources` | 6 | 7 MB | Normalized statute source (`laws/kef113/normalized/<sha>.txt`) | legislation pipeline | **Production** (small corpus) |
| `make-3acdf682-law-storage` | 1 | 147 KB | make-server heavy JSON (`case-law/nomologies-v2/<uuid>.json`) | make-server writes/reads | **Live** (make-server's own case store) |
| `make-da6d5fe1-law-storage` | 2 | 2.4 MB | Older make deployment catalog (`catalog/<hash>.json`) | prior make deploy | **Legacy** — trace references before any action (see §5) |

### 1.3 Database (628 MB total)

Two application schemas, both **RLS-enabled with no policies and no anon/authenticated grants** = reachable only via the service-role key inside Edge Functions (correct deny-all posture).

- **`nomologies`** (48 MB): the V2 case corpus. 23 cases (11 published, 10 in review, 2 withdrawn), 86 case_versions (up to **28 versions on one case** — full canonical JSON retained per version → real rollback capability), 10,981 paragraphs, 8,925 evidence anchors, 3,741 sections, 143 search fields (**143/143 embedded**, 1024-dim), 429 smart tags, 290 principle assertions, 127 authority edges. Pipeline: 85 runs, 1,010 tasks (**all succeeded**), 2,772 events. Bulk: 4 batches, 315 items (288 held, 12 cancelled, 7 published).
- **`legislation`** (563 MB — 90% of the DB): 2 laws, 3 law_versions, 1,553 provisions, **11,863 legal_rules**, 11,106 provision_relations, 1,388 issue frames, 279 term definitions, and **22,792 retrieval_documents (22,792/22,792 embedded**, 1024-dim HNSW). Builds: metadata 2 completed/3 failed/1 running; embeddings 1 completed/3 failed/1 running; golden tests present. This is a **large, real, structured legislation knowledge base** — but currently exercised by zero live traffic.
- **`public.kv_store_3acdf682`** (1 row): make-server's KV table. The single row is a `nomologies:v2:parse-job:<uuid>` (58 KB). make-server also serves law content from KV, so the store is load-bearing for make-server even though it is nearly empty right now.

---

## 2. The frontend question (your #1 priority)

**Finding: the exact live lawyer-facing frontend source is NOT in this repository, on any of the 34 branches.** Evidence:

- Exhaustive fingerprint search across all branches for `chatgpt.site`, `marino-shalida`, `appgprj`, `Νομολογ`/Greek UI strings, `mynomosaigpt` → hits appear **only in `main`'s own documentation files**, never in shippable frontend source.
- `apps/mynomos/` (on `agent/full-mynomos-production`) is an **OpenAI-Sites Next.js/vinext admin console**, UI almost entirely **English** ("Cyprus legal intelligence", "Good morning, {firstName}" → literal fallback "Marino", "Global search / New judgment / Bulk intake / Review queue / Live corpus / System health"), one Greek `<h1>Νομολογίες</h1>`. Its `.openai/hosting.json` records project `appgprj_6a6d9de2b0588191908a26b979334811`. It is a same-platform, same-backend **sibling/admin app**, not the live product. Your own `DEPLOYMENT_INVENTORY.md` already records the visual mismatch.
- The closest Greek artifacts in Git are `web/search.html` (bilingual "Elite Legal Search" **lab** page) and `agent/e5-preview:case-preview/index.html` (a Greek bootloader that inflates a `payload.gz` which is **not committed**). Both are fragments/evidence, not the app.
- The live frontend is a **ChatGPT-Sites / Figma-Make-lineage app** (the "MyNomos AI v11" vocabulary and the `make-server-3acdf682` naming are the tells). Its source lives in the OpenAI Sites project, recoverable only by **exporting from that platform**, then committing under `apps/mynomosaigpt/`.

**Parity conclusion:** GitHub and the live Site have **no frontend parity**. Recovering the live frontend into Git is a required, currently-unmet step for reproducibility and sale-readiness. Do **not** substitute `apps/mynomos/` for the live app.

---

## 3. End-to-end architecture (traced to the running code)

### 3.1 Case-law pipeline (LIVE — the "Nomologies V2" path)

```
Live frontend (ChatGPT-Sites, Greek — NOT in Git)
   │  x-nomologies-key (gateway) / anon JWT
   ├─ search ──▶ nomologies-search v13  ─ RPC nomologies.hybrid_case_search ─▶ Postgres (tsvector + pgvector HNSW 1024d)
   │                                     └ (weak recall) ─▶ OpenAI text-embedding-3-large ─▶ retry hybrid
   ├─ read  ──▶ nomologies-api v38 GET /cases/:id ─▶ case_versions.canonical_record (+ search projection)
   └─ admin ─▶ nomologies-api /intake|/bulk|/review|/reprocess|/deferred
                      │ RPC create_intake / create_bulk_batch (SECURITY DEFINER)
                      │ Storage nomologies-sources (original/normalized text)
                      ▼ kicks worker
              nomologies-worker v37  (durable queue: nomologies.pipeline_tasks, 6-min leases, attempt caps, barrier recovery, self-invoke chain)
                 source(cylaw.ts) ─▶ sections(windowed voting) ─▶ 4 core agents (identity, facts-procedure, analysis-authorities, outcome)
                 ─▶ agents-merge (+deterministic-baseline regex cross-check) ─▶ [whole-judgment synthesis — complex cases only]
                 ─▶ verify-initial ─▶ [repair-<core> ─▶ verify-final]  ─▶ persist ─▶ embeddings/reindex
                      │ writes: cases, case_versions (versioned canonical JSON), case_paragraphs, case_sections,
                      │         evidence_anchors, case_search_documents, case_search_fields (embeddings),
                      │         smart_tags/case_smart_tags, principle_assertions, authority_edges, provision_links
                      ▼ Storage nomologies-artifacts (per-stage JSON)
              Human review ─▶ nomologies-api POST /cases/:id/review (publish gate readiness≥90 + strictReady, manual override w/ reason)
                      ▼
              case published (publication_status='published') ─▶ visible to nomologies-search
```
Models: all pipeline stages pinned to **`gpt-5.4-mini`** (reasoning effort "low") in the deployed lean profile; deferred detailed-analysis uses a **dynamically-discovered flagship gpt-5** model; embeddings `text-embedding-3-large` @1024.

### 3.2 Legislation — TWO live-capable stacks

```
A) make-server-3acdf682 (LIVE, KV-only)         B) legislation-api-next (BUILT, ~0 live traffic)
   frontend ─▶ /make-server-3acdf682/*             frontend ─▶ /legislation-api-next/*  (x-nomologies-key bf81f9…)
      chat: Opus 4.8 / GPT-5.4-mini / Grok 4.3        source→metadata→provisions→rules→embeddings→retrieval→answer
      laws from kv_store_3acdf682 + make bucket        Postgres schema `legislation` (1553 provisions, 11863 rules,
      "No embeddings/graph/semantic" (declared)        22792 retrieval docs HNSW, golden tests, audit_events)
                                                        RPC legislation.hybrid_legislation_search
   legislation-answer-original-canary = A/B verifier that replays the ORIGINAL make engine to prove B ≡ A on the corpus
```
The intended end-state is clearly **B replacing A**, with the canary proving equivalence — but the cutover has not happened; the live app still answers legislation from **A (make-server, KV)**.

---

## 4. What is genuinely excellent (preserve this)

1. **Evidence-first extraction contract, enforced in code (not prompts).** `evidence.ts` re-derives ground truth: verbatim-quote check after Unicode normalization, paragraph-contiguity requirement, and a per-field **section/speaker policy matrix** (analysis claims may not be sourced from party submissions or quoted authorities; facts may not come from the disposition). Anchors that fail attribution are destroyed and the field demoted to `indeterminate`. Four-valued field status (`available|unavailable|indeterminate|conflicted`) makes "not stated" vs "ambiguous" vs "contradicted" mechanical. This is the correct architecture for hallucination control in case-law and is rare in the market.
2. **Windowed section voting** (`sections.ts`): overlapping windows + per-paragraph confidence-weighted voting with edge penalties, ambiguity flags, separator smoothing, deterministic footnote reclassification — converts an unreliable long-document task into a stable, reviewable partition.
3. **Deterministic cross-verification** (`deterministic-baseline.ts`, prod-elite/deployed): an independent regex layer extracts case numbers, dates, per-ground results, costs (with VAT/stage/payer), and **statute-article ownership**, raising `PROVISION_WRONG_STATUTE` (critical) — a cheap detector for the single most damaging legal hallucination.
4. **Calibrated independent reviewer** (`agents.ts`/quality): the verifier is deliberately not trusted — only identity/fabrication codes can block publication, known false-positive codes are suppressed, circular conflicts collapsed. Second-order thinking most teams never reach.
5. **Greek-Cyprus legal domain depth**: submission verbs, judicial-voice markers, ground-result grammar incl. negation, Α.Α.Δ./C.L.R./ECLI derivation, windows-1253/iso-8859-7 charset triage, cumulative lower-court-order jurisprudence. Hardest part to replicate.
6. **Hybrid search done properly** (`src/nomologies-search`, SQL `hybrid_case_search`): real per-field **BM25** (k1=1.35, b=0.72), pgvector **HNSW** + tsvector + trigram fused in one RPC, per-field embeddings with 9-intent weighting, **explainable** results (`whyMatched`, score breakdown, evidence paragraph anchors), recall-protecting soft filters, authority-treatment citator edges.
7. **Durable, idempotent orchestration** (deployed worker): DB task queue with 6-min leases, attempt caps + backoff, barrier recovery after crashes, per-stage artifacts, self-invoking drain chain, `onConflict(run_id,stage)` idempotency, `source_hash` dedupe. `make-server`'s `kv_db.ts`/`heavy-storage.ts` add circuit breakers, keyset pagination and transient-lift retries — genuinely production-grade infrastructure code.
8. **Sound data model**: proper FK graph with sensible ON DELETE semantics, idempotency/unique keys everywhere (`cases.source_hash`, `pipeline_tasks(run_id,stage)`, `bulk_items(batch_id,ordinal|source_url)`, legislation `idempotency_key`, `law_versions(law_id,version_no)`), full canonical-JSON version retention (rollback), SECURITY DEFINER RPCs as the only write path.
9. **Zero-dependency extraction engine** (fetch/crypto/Intl only) — excellent supply-chain posture for legal software; JSON schemas generated from the same `as const` vocabularies as the TS types.

---

## 5. What is wrong or messy (prioritised)

### CRITICAL
- **C1 — Production case pipeline is not in Git.** `nomologies-worker` v37 / `nomologies-api` v38 are `claude/prod-elite` **plus an uncommitted "elite-lean-v2" layer**; 12 file-contents (incl. the two entrypoints, `agents.ts`, `prompts.ts`, `staged-finalize.ts`) exist in no commit. A deployed comment ("operators can override with `NOMOLOGIES_V2_MODEL`") is now false (model hardcoded), proving hand-editing. **Production cannot be rebuilt from source.** One drifted file (`sections.ts`) even regresses a prod-elite fix (provision regex `[^\[] {0,220}` matches spaces only vs the fixed `[^\[]{0,220}`) — a latent classification bug shipped to prod.
- **C2 — `make-server-3acdf682` has no application auth.** `verify_jwt=true` is the *only* gate, so **any valid project JWT (the public anon key) can call all 106 routes**, including `DELETE /case-law/case/:id`, `/law-storage/:id`, `/seed-laws/:id`, `/treaties/:id`, plus deploy/rebuild. With `ACAO:*` and the anon key embedded in a browser app, this is a full destructive surface. It also runs with the service-role key (RLS bypassed).
- **C3 — Live frontend source absent from Git** (see §2). Combined with C1, the product **cannot be rebuilt end-to-end from the repository** — the central blocker to it being a sellable asset.
- **C4 — Public repository holding the full proprietary engine.** `marinos151111-del/mynomosgpt` is **public** (confirmed via API). Prompts, schemas, legal taxonomy, deterministic-verification IP and gateway-key **hashes** are world-readable. Your own `ASSET_REGISTER.md` flags this; it remains unfixed.

### HIGH
- **H1 — Four independent shared credentials, no user identity.** nomologies gateway key (in api+search), `NOMOLOGIES_ADMIN_KEY` (intake), legislation gateway key, canary key — all single shared secrets behind `ACAO:*`. Reviewer/override attribution trusts a spoofable `x-nomologies-actor-email` header; `review_decisions.signature_hash` mixes in a usually-empty auth header (weak evidentiary value).
- **H2 — `verify_jwt=false` on `nomologies-api`** (the case admin plane) and on both legislation functions. The gateway hash is the *only* thing between the internet and publish/reprocess/deferred-flagship-spend. No rate limiting anywhere.
- **H3 — Three overlapping stacks / duplicated endpoints.** Case search exists in **two** live functions (`nomologies-search` and `nomologies-api /search`); intake/bulk exist in **two** (`nomologies-intake` and `nomologies-api`); legislation exists in **three** (make-server KV, `legislation-api`, `legislation-api-next`) — the latter two near-identical. This is drift waiting to diverge.
- **H4 — Branch sprawl / disjoint histories.** 34 remote branches; `main` (a "lab snapshot") shares **no history** with `agent/full-mynomos-production`, which shares none with `claude/prod-elite` (the actual deploy base). No single source of truth; ~20 `e5-*`/`case-preview*` branches are dead.
- **H5 — Near-zero automated test coverage of the engine.** The pure, high-risk cores (evidence validator, section voting, sentence segmentation, charset triage, deterministic baseline) have **no unit tests** on any branch. "Tests" are live, paid, non-deterministic LLM E2E runs against real CyLaw pages. Only `search.test.ts` (thin smoke tests) and legislation golden tests exist.

### MEDIUM
- **M1 — Schema drift with no migrations.** Deployed `case_search_documents` columns (`principle_ids`, `precedential_score/tier/factors`, `novelty_verified`) and `smart_tags.tag_key` have **no committed migration**; prod-elite's schema is ahead of `supabase/migrations/`.
- **M2 — CI writes generated reports into `main`** (`git push origin HEAD:main`), and `live-pipeline-lab.yml` runs a ~5h40m trycloudflare tunnel uploading `{url,password}` as an artifact — anyone with Actions-read on a public repo can reach a live server holding the OpenAI key (1-day retention mitigates).
- **M3 — E5/2025 benchmark overfit dressed as generic logic.** `quality-authorities.ts` hardcodes one case's legal hierarchy (CPR 2023 Part 41, Law 14/60 art. 32 with pre-written propositions) and rewrites one specific Greek sentence. Fine as a fixture; dangerous as "quality" logic applied corpus-wide.
- **M4 — 429 cascades under fan-out.** No global token/request limiter; a committed 20-case benchmark lost 40% of cases to HTTP 429. Hard 64-window cap throws on very long judgments while intake accepts 1.8 MB.
- **M5 — `main`'s lab server keeps job state in memory** (lost on restart) — only the deployed worker has the durable queue. `main` is not production-representative and its presence as the default branch misleads.
- **M6 — Search maintainability trap:** three scoring implementations (JS lab BM25, SQL `hybrid_case_search`, elite AST re-rank) with **no parity tests**; SQL path has no Greek stemming (`unaccent`+`simple`) so JS and SQL rankings diverge by design.

### LOW
- **L1 — `nomologies-health` public**, leaks config booleans + project ref (minor).
- **L2 — `make-da6d5fe1-law-storage`** (2 objects) and **`nomologies-reset-current-manifest`** (already `410`-tombstoned) are legacy; retire only after reference-tracing (make-da6d5fe1 is referenced by nothing in the current deployed code I inspected — confirm the older make deployment is gone first).
- **L3 — Non-constant-time key compare** in the worker (`token === SERVICE_ROLE_KEY`); low practical risk but sloppy.
- **L4 — Extensions `vector`/`pg_trgm`/`unaccent` in `public` schema** and two functions with mutable `search_path` (advisor WARNs; cosmetic hardening).
- **L5 — `kv_store_3acdf682` is in the `public` schema** (PostgREST-exposed) with RLS-enabled-no-policy; verify anon/authenticated have no grants on it (the other app schemas are clean; this one table sits in the exposed schema — worth a one-line check).
- **L6 — Captured OpenAI `usage` is never aggregated** into a cost report; no prompt-caching/batching despite heavy overlapping payloads across specialist agents.

---

## 6. Ratings (0–10, judged against a serious commercial legal-research SaaS)

| # | Category | Score | One-line basis |
|---|---|---|---|
| 1 | Overall architecture | **5.5** | Sophisticated designed system; actual runtime is 3 parallel backends + frontend outside Git |
| 2 | Backend engineering | **7.5** | Durable queue, leases, idempotency, circuit breakers, retries — genuinely strong |
| 3 | Nomologies V2 legal extraction | **9.0** | Evidence-first, windowed voting, deterministic cross-checks, calibrated review — top-decile |
| 4 | Evidence / provenance controls | **9.0** | Verbatim+contiguity+section/speaker policy, discard-and-demote, versioned anchors |
| 5 | Search & retrieval quality | **6.0** | Real BM25+HNSW+tsvector, explainable; but tiny vocab, no eval set, 3 impls, Greek stemming gap |
| 6 | Legislation engine | **6.0** | Large structured KB (11.8k rules, 22.8k vectors, golden tests) — but not the live path; duplicated |
| 7 | Database / data model | **8.0** | Clean FK graph, idempotency keys, versioning/rollback, HNSW+FTS, SECURITY DEFINER RPCs |
| 8 | Reliability & fault tolerance | **6.5** | Durable deployed path good; in-memory lab, 429 cascades, hard window cap, uncommitted prod |
| 9 | Security | **5.0** | Great data layer (RLS deny-all, SSRF allowlist, no hardcoded secrets) undone by JWT-only make-server, verify_jwt=false, 4 shared keys, public repo |
| 10 | API design | **5.0** | Duplicate endpoints, 4 credentials, mixed op-style/REST, inconsistent auth, no rate limiting |
| 11 | Performance / scalability | **5.5** | HNSW+FTS foundations fine; per-case fan-out, no limiter, O(N) df scans, only single-user scale proven |
| 12 | AI / API cost efficiency | **6.5** | Mini tiering, deferred fields, lean pipeline, effort tuning; offset by overlapping payloads, no caching/aggregation |
| 13 | Code quality | **6.5** | Strict zero-dep TS, disciplined; hurt by 3-way divergence, uncommitted prod, E5 hardcodes, patch-scripts |
| 14 | Test coverage | **2.5** | No engine unit tests; thin search smoke tests; live paid E2E; some legislation golden tests |
| 15 | Maintainability | **4.0** | Fragmentation, uncommitted prod, 4 keys, disjoint branches, no single source of truth |
| 16 | Deployment / reproducibility | **3.0** | Cannot rebuild prod (uncommitted) or frontend (absent) from Git; schema drift w/o migrations |
| 17 | Frontend / backend integration | **4.5** | Clean in-repo proxy chain, but live frontend not in Git and its live wiring is unconfirmed (401s) |
| 18 | Portability (off Supabase/OpenAI Sites) | **4.0** | Heavy lock-in: Supabase RPC/pgvector/storage/edge, OpenAI Sites hosting, provider-specific models |
| 19 | IP / product-sale readiness | **4.5** | Real proprietary IP + good awareness docs, but public repo, no parity, no contributor IP assignment, frontend unpreserved |
| 20 | Overall product engineering | **5.5** | Excellent core, unfinished productization |

### **Overall score: 5.5 / 10**

Read this as: **technology ≈ 8.5, productization ≈ 4.** The gap is the whole story. None of the deductions require weakening the legal technology — they are about consolidation, reproducibility and security posture.

---

## 7. Final architecture — how to consolidate to ONE clean asset

Target (no capability removed — the V2 pipeline, hybrid search, structured legislation engine and legal reasoning are all preserved):

```
ONE PRODUCT: mynomosaigpt
ONE GitHub repo: marinos151111-del/mynomosgpt  (PRIVATE, single canonical branch = main)
        │
        ├─ apps/mynomosaigpt/         ← exact live frontend, EXPORTED from the ChatGPT-Sites project (fills the §2 gap)
        │        │  one server-side proxy, one gateway credential, no key in the browser
        │        ▼
        ├─ ONE API boundary  (documented; one search route, one intake route, one case API, one legislation API)
        │        ▼
        └─ ONE Supabase project btfggtdysjgdjgmvqdbt
                 ├─ Nomologies V2      (nomologies-worker + nomologies-api)      ← canonicalise deployed source into Git first
                 ├─ Nomologies Search  (fold nomologies-search into the api, or keep one, delete the duplicate)
                 ├─ Legislation Engine (legislation-api-next only, after canary proves parity; retire make-server's KV legislation + legislation-api)
                 ├─ Database  (schemas nomologies + legislation, migrations regenerated to match deployed schema)
                 └─ Storage   (artifacts, sources, exports, dead-letter, legislation-sources; retire make-* buckets after reference-trace)
```

Sequenced, non-destructive (aligned to your existing `CONSOLIDATION_PLAN.md`):
1. **Recover source, don't delete anything.** Commit the deployed `nomologies-worker`/`nomologies-api` verbatim into Git (closes C1); export the live Sites frontend into `apps/mynomosaigpt/` (closes C3). Deployed source of all 11 functions is already archived in this audit for reference.
2. **Make the repo private** (closes C4); prune the ~20 dead `e5-*`/preview branches after confirming nothing deploys from them.
3. **Fix the make-server auth hole** (C2): add an application credential/allow-list in front of its routes, or move the live app onto the gateway-key functions, before anything else.
4. **Pick one route per capability** (H3): one search, one intake, one case API, one legislation API. Keep `make-server` running until the live frontend is proven to no longer depend on it (its traffic pattern must be resolved first — see §1.1).
5. **Regenerate migrations** to match the deployed schema (M1), then verify build/type-checks and a full functional pass (intake → extract → search → read → legislation answer → publish).
6. **Add unit tests** for the pure cores (H5) and a small labelled retrieval eval set (M6) — the cheapest large quality win available.
7. **Only then** classify `legislation-api`, the canary, `make-da6d5fe1-law-storage` and the reset tombstone for retirement, each behind a reference-trace + rollback tag.

---

*Prepared read-only. No functions, buckets, schemas, branches or Sites were modified. Deployed source of all 11 Edge Functions and the full DB/storage inventory were captured during this audit and are available to seed the recovery in step 1.*
