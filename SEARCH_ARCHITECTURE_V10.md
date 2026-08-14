# mynomosaigpt — Nomologies Search Architecture V10

## Purpose

This branch establishes one authoritative search architecture for the commercial product **mynomosaigpt**. It does not create another product or frontend.

## Contract

Search is a two-stage system:

1. **Indexed candidate generation in PostgreSQL**
   - exact case identity;
   - party/title/citation matching;
   - Greek legal lemmatisation;
   - field-level full-text and trigram retrieval;
   - controlled concepts and aliases;
   - legislation/provision matching;
   - cited-authority matching;
   - pgvector semantic retrieval;
   - Reciprocal Rank Fusion across independent lanes.
2. **Deterministic application reranking**
   - Boolean/phrase semantics;
   - weighted legal fields;
   - exclusion enforcement;
   - evidence-linked snippets;
   - precedential weight only as a tie-breaker, never a substitute for relevance.

## Non-negotiable guarantees

- Only the published current case version is searchable.
- Exact case number, citation and ECLI are deterministic and rank first.
- No LLM is required for the lexical critical path.
- Semantic retrieval degrades safely to lexical retrieval.
- Result explanations identify the matched legal fields.
- Raw user queries are not persisted; telemetry stores a one-way hash only.
- Search changes are gated by a labelled regression suite.

## 10/10 acceptance gate

The architecture may be described as 10/10 only after the benchmark contains at least 100 human-reviewed queries across identity, provisions, authorities, Greek, English, Greeklish and natural-language issues, and achieves:

- identity/citation Precision@1: 100%;
- provision Recall@5: at least 95%;
- authority Recall@5: at least 95%;
- concept Recall@10: at least 92%;
- natural-language nDCG@10: at least 0.88;
- stale/unpublished result rate: 0%;
- lexical p95 latency: below 350 ms;
- hybrid p95 latency: below 1,200 ms;
- zero regression against the approved baseline.

## Migration sequence

1. Install the additive V10 SQL functions, indices, telemetry and evaluation tables.
2. Run the benchmark against `hybrid_case_search_v10` without changing live traffic.
3. Review failures and tune only from labelled evidence.
4. Redirect the existing `hybrid_case_search` RPC to V10 after the gate passes.
5. Deploy the V10 Edge Function and verify the live response contract.
6. Retire duplicate scoring implementations only after parity is proved.
