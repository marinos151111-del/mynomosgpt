# Nomologies Search V10

## Production status

- Candidate RPC: `nomologies.hybrid_case_search_v10`.
- Public production contract: `nomologies.hybrid_case_search`.
- Database cutover completed on 14 August 2026 after the 18-query smoke regression reached 18/18 top-one accuracy.
- `nomologies-search` Edge Function version 14 is active and reports `nomologies-v10.0.0`.
- The Edge Function source is preserved under `supabase/functions/nomologies-search/index.ts` on `search/nomologies-v10`.
- Existing frontend/API request and response contracts were preserved.

## Production controls

V10 adds:

- controlled Greek/English/Greeklish concept expansion;
- Greek legal lemmatisation and precomputed search columns;
- reciprocal-rank fusion across independent retrieval lanes;
- ordered phrase/proximity reranking;
- strict current-published-version gating;
- DB-backed rate limiting;
- query-hash-only telemetry; and
- a persistent relevance-evaluation schema.

## Rollback

The migration preserves the former production scorer as:

`nomologies.hybrid_case_search_v9_rollback`

Rollback is therefore a single RPC-wrapper change from V10 back to V9. Do not remove the V10 indexes, synonym table, evaluation tables or telemetry during rollback; those objects are additive and safe to retain.

## Remaining parity item

`nomologies-api` still contains a secondary JavaScript reranker after the database RPC. A safe one-shot recovery/patch workflow was added, but it did not deploy because the repository has no `SUPABASE_ACCESS_TOKEN` secret. No unverified `nomologies-api` change was attempted. The dedicated live `nomologies-search` route is fully V10; controlled evidence-supported concept aliases also reduce divergence in the duplicate API route until its exact deployed source can be recovered and reconciled.

## Release constraints

- Do not replace relevance tuning with ad hoc case-specific rules.
- Do not alter weights without recording a benchmark run.
- Do not describe the retrieval quality as formally certified 10/10 until the 100-query human-labelled gate in `SEARCH_ARCHITECTURE_V10.md` passes.
