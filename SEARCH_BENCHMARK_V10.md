# Search V10 benchmark notes — 2026-08-14

## Corpus smoke benchmark

- Queries: 18.
- Languages/modes: Greek, English, mixed Greek/English and Greeklish.
- Intents: identity, case number, provision, legal concept and natural-language issue.
- V9 baseline: **16/18** expected cases ranked first.
- V10 production RPC after cutover: **18/18** expected cases ranked first.
- V10 corrected both baseline failures:
  - `conditional contract misrepresentation`;
  - `echthriki katochi`.

## Safety and filter checks

- Results inspected across the seed set: 31.
- Stale, unpublished or non-current results: **0**.
- Browse mode: passed.
- `proceedingType` filter: passed.
- `legalArea` filter: passed.

## Preliminary latency

Measured directly in PostgreSQL after warm-up, without an embedding request:

- Exact identity/case-number set, 20 runs: p50 **166.16 ms**; p95 **202.29 ms**; max **206.44 ms**.
- Mixed 10-query set, 20 runs: p50 **311.31 ms**; p95 **771.40 ms**; max **788.72 ms**.

The mixed set includes bilingual synonym expansion and Greeklish recovery. It remains below the V10 hybrid p95 target of 1,200 ms.

## Certification status

The production architecture and seed regression gate pass. A formal claim of 10/10 retrieval quality still requires at least 100 human-reviewed queries and the thresholds in `SEARCH_ARCHITECTURE_V10.md`. The current 18-query set is a smoke benchmark, not a substitute for a human-labelled legal-relevance evaluation.
