-- Preserve the production V9 scorer as a rollback target, then build the V10
-- query-expansion/RRF layer on top of that proven scorer.
do $migration$
declare
  live_definition text;
begin
  if to_regprocedure('nomologies.hybrid_case_search_v9_rollback(text,vector,jsonb,integer)') is null then
    live_definition := pg_get_functiondef('nomologies.hybrid_case_search(text,vector,jsonb,integer)'::regprocedure);
    live_definition := replace(
      live_definition,
      'FUNCTION nomologies.hybrid_case_search(',
      'FUNCTION nomologies.hybrid_case_search_v9_rollback('
    );
    execute live_definition;
  end if;
end;
$migration$;

create or replace function nomologies.hybrid_case_search_v10_base(
  query_text text,
  query_embedding vector default null::vector,
  filters jsonb default '{}'::jsonb,
  match_count integer default 30
)
returns table(
  case_id uuid,
  score double precision,
  exact_identity_score double precision,
  lexical_score double precision,
  semantic_score double precision,
  tag_score double precision,
  matched_fields text[],
  title text,
  short_title text,
  citation text,
  case_number text,
  decision_date date,
  court text,
  outcome text,
  readiness_score integer
)
language sql
stable
set search_path = nomologies, public
as $$
with params as materialized (
  select
    nomologies.normalize_search_text(query_text) as nq,
    nomologies.greek_to_latin_search(query_text) as latin_q,
    greatest(20, least(200, greatest(1, match_count) * 5)) as candidate_limit
),
matched_groups as materialized (
  select s.canonical_key, s.weight::double precision as group_weight, s.terms
  from nomologies.legal_search_synonyms s
  cross join params p
  where s.active
    and exists (
      select 1
      from unnest(s.terms) term
      where (
        length(p.nq) >= 4
        and (
          p.nq like '%' || nomologies.normalize_search_text(term) || '%'
          or nomologies.normalize_search_text(term) like '%' || p.nq || '%'
        )
      )
      or (
        length(p.latin_q) >= 4
        and nomologies.greek_to_latin_search(term) = p.latin_q
      )
    )
),
ranked_synonyms as materialized (
  select
    group_row.canonical_key,
    term,
    group_row.group_weight,
    row_number() over (
      partition by group_row.canonical_key
      order by
        case when term ~ '[α-ωΑ-Ω]' then 0 else 1 end,
        ordinality
    ) as synonym_rank
  from matched_groups group_row
  cross join lateral unnest(group_row.terms) with ordinality as expanded(term, ordinality)
  cross join params p
  where nomologies.normalize_search_text(term) <> p.nq
),
expansion_source as materialized (
  select query_text as expanded_query, 3.0::double precision as lane_weight, true as primary_lane, 0 as lane_order
  union all
  select term, greatest(0.8, group_weight)::double precision, false, 10 + row_number() over (order by canonical_key, synonym_rank)
  from ranked_synonyms
  where synonym_rank <= 2
),
deduplicated_expansions as materialized (
  select distinct on (nomologies.normalize_search_text(expanded_query))
    expanded_query,
    lane_weight,
    primary_lane,
    lane_order,
    nomologies.normalize_search_text(expanded_query) as normalized_query
  from expansion_source
  where trim(expanded_query) <> ''
  order by nomologies.normalize_search_text(expanded_query), primary_lane desc, lane_weight desc, lane_order
),
expanded_queries as materialized (
  select *
  from deduplicated_expansions
  order by primary_lane desc, lane_order, lane_weight desc, normalized_query
  limit 7
),
lane_results as materialized (
  select
    eq.expanded_query,
    eq.lane_weight,
    eq.primary_lane,
    r.*,
    row_number() over (
      partition by eq.normalized_query
      order by r.score desc, r.decision_date desc nulls last, r.case_id
    ) as lane_rank
  from expanded_queries eq
  cross join params p
  cross join lateral nomologies.hybrid_case_search_v9_rollback(
    eq.expanded_query,
    case when eq.primary_lane then query_embedding else null::vector end,
    filters,
    p.candidate_limit
  ) r
),
combined as materialized (
  select
    lr.case_id,
    coalesce(max(lr.exact_identity_score) filter (where lr.primary_lane), 0)::double precision as exact_score,
    coalesce(max(lr.score) filter (where lr.primary_lane), 0)::double precision as primary_score,
    coalesce(max(lr.score) filter (where not lr.primary_lane), 0)::double precision as expansion_score,
    coalesce(max(lr.lexical_score), 0)::double precision as lexical_score,
    coalesce(max(lr.semantic_score), 0)::double precision as semantic_score,
    coalesce(max(lr.tag_score), 0)::double precision as tag_score,
    sum(lr.lane_weight / (60.0 + lr.lane_rank))::double precision as rrf_score,
    array_agg(distinct field_name order by field_name) as matched_fields
  from lane_results lr
  cross join lateral unnest(lr.matched_fields) field_name
  group by lr.case_id
),
current_docs as not materialized (
  select d.*
  from nomologies.case_search_documents d
  join nomologies.cases c
    on c.id = d.case_id
   and c.publication_status = 'published'
   and c.current_version_id = d.case_version_id
)
select
  d.case_id,
  (
    case when c.exact_score >= 150 then 10000 + c.exact_score else 0 end
    + c.rrf_score * 1000
    + c.primary_score * 0.35
    + c.expansion_score * 0.18
    + c.semantic_score * 8
    + least(100, coalesce(d.precedential_score, 0)) * 0.02
  )::double precision as score,
  c.exact_score,
  c.lexical_score,
  c.semantic_score,
  c.tag_score,
  c.matched_fields,
  d.title,
  d.short_title,
  d.citation,
  d.case_number,
  d.decision_date,
  d.court,
  d.outcome,
  d.readiness_score
from combined c
join current_docs d on d.case_id = c.case_id
order by score desc, d.precedential_score desc, d.decision_date desc nulls last
limit greatest(1, least(match_count, 200));
$$;

revoke all on function nomologies.hybrid_case_search_v9_rollback(text,vector,jsonb,integer) from public;
revoke all on function nomologies.hybrid_case_search_v10_base(text,vector,jsonb,integer) from public;
grant execute on function nomologies.hybrid_case_search_v9_rollback(text,vector,jsonb,integer) to service_role;
grant execute on function nomologies.hybrid_case_search_v10_base(text,vector,jsonb,integer) to service_role;
