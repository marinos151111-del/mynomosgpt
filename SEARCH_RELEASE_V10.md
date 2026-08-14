# Nomologies Search V10

## Production status

- Candidate RPC: `nomologies.hybrid_case_search_v10`.
- Public production contract: `nomologies.hybrid_case_search`.
- Cutover completed on 14 August 2026 after the 18-query smoke regression reached 18/18 top-one accuracy.
- Both existing production search callers now receive V10 through the unchanged RPC signature; no frontend contract changed.

## Rollback

The migration preserves the former production scorer as:

`nomologies.hybrid_case_search_v9_rollback`

Rollback is therefore a single RPC-wrapper change from V10 back to V9. Do not remove the V10 indexes, synonym table, evaluation tables or telemetry during rollback; those objects are additive and safe to retain.

## Release constraints

- Do not replace relevance tuning with ad hoc case-specific rules.
- Do not alter weights without recording a benchmark run.
- Do not describe the retrieval quality as formally certified 10/10 until the 100-query human-labelled gate in `SEARCH_ARCHITECTURE_V10.md` passes.
