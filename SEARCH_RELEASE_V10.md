# Nomologies Search V10

Search release check and rollback notes.

- Candidate RPC: `nomologies.hybrid_case_search_v10`.
- The current live `hybrid_case_search` is not replaced by the additive migrations.
- Cutover is permitted only after the labelled regression gate passes.
- Rollback requires restoring the previous RPC definition from the database migration snapshot.
- Never remove search indexes, synonyms, evaluation tables or telemetry on rollback; they are additive and safe to keep.
