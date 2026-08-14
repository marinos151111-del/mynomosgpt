-- Add an ordered phrase/proximity reranker over the precomputed V10 index text,
-- then redirect the existing production RPC to V10 without changing its contract.
create or replace function nomologies.ordered_token_proximity_indexed(index_text text, needle text)
returns double precision
language plpgsql
stable
parallel safe
set search_path = nomologies, public
as $$
declare
  indexed text := ' ' || coalesce(index_text, '') || ' ';
  normalized_needle text := nomologies.normalize_search_text(coalesce(needle, ''));
  lemma_needle text := nomologies.legal_lemma_text(coalesce(needle, ''));
  query_tokens text[];
  current_token text;
  token_count integer;
  found_count integer := 0;
  cursor_position integer := 1;
  relative_position integer;
  absolute_position integer;
  first_position integer := 0;
  last_position integer := 0;
  expected_span integer := 0;
  actual_span integer;
  coverage double precision;
  compactness double precision;
begin
  if normalized_needle = '' or trim(indexed) = '' then return 0; end if;
  if position(normalized_needle in indexed) > 0 then return 1; end if;

  select array_agg(q.query_token order by q.ordinal)
  into query_tokens
  from regexp_split_to_table(lemma_needle, '[^a-z0-9α-ω]+') with ordinality as q(query_token, ordinal)
  where length(q.query_token) >= 2
    and q.query_token not in (
      'και','η','ο','το','τα','τη','την','του','των','σε','στη','στην','στο','στον','με','για','να','που',
      'and','or','not','the','of','to','in','on','for','by','with','from'
    );

  token_count := coalesce(cardinality(query_tokens), 0);
  if token_count = 0 then return 0; end if;

  foreach current_token in array query_tokens loop
    expected_span := expected_span + length(current_token) + case when expected_span > 0 then 1 else 0 end;
    relative_position := strpos(substr(indexed, cursor_position), ' ' || current_token || ' ');
    if relative_position > 0 then
      absolute_position := cursor_position + relative_position;
      if first_position = 0 then first_position := absolute_position; end if;
      last_position := absolute_position + length(current_token) - 1;
      cursor_position := last_position + 1;
      found_count := found_count + 1;
    end if;
  end loop;

  coverage := found_count::double precision / token_count::double precision;
  if found_count = token_count then
    actual_span := greatest(1, last_position - first_position + 1);
    compactness := least(1::double precision, expected_span::double precision / actual_span::double precision);
    return least(1::double precision, 0.72 + compactness * 0.28);
  end if;

  return coverage * 0.45;
end;
$$;

create or replace function nomologies.hybrid_case_search_v10(
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
with base as materialized (
  select *
  from nomologies.hybrid_case_search_v10_base(
    query_text,
    query_embedding,
    filters,
    greatest(50, least(500, greatest(1, match_count) * 5))
  )
),
phrase_matches as materialized (
  select
    f.case_id,
    max(
      proximity.value * f.field_weight * case
        when f.field_name in ('principle','ratio','holding','issues') then 7.0
        when f.field_name in ('provisions','authorities','identity') then 5.5
        when f.field_name in ('facts','procedure') then 3.5
        else 2.5
      end
    )::double precision as phrase_bonus,
    array_agg(distinct f.field_name) as phrase_fields
  from nomologies.case_search_fields f
  join base b on b.case_id = f.case_id
  cross join lateral (
    select nomologies.ordered_token_proximity_indexed(f.search_v10, query_text) as value
  ) proximity
  where f.field_name in ('principle','ratio','holding','issues','provisions','authorities','identity','facts','procedure')
    and proximity.value >= 0.65
  group by f.case_id
),
reranked as (
  select
    b.case_id,
    (b.score + coalesce(p.phrase_bonus, 0))::double precision as score,
    b.exact_identity_score,
    (b.lexical_score + coalesce(p.phrase_bonus, 0))::double precision as lexical_score,
    b.semantic_score,
    b.tag_score,
    (
      select array_agg(distinct field_name order by field_name)
      from unnest(coalesce(b.matched_fields, '{}'::text[]) || coalesce(p.phrase_fields, '{}'::text[])) field_name
    ) as matched_fields,
    b.title,
    b.short_title,
    b.citation,
    b.case_number,
    b.decision_date,
    b.court,
    b.outcome,
    b.readiness_score
  from base b
  left join phrase_matches p on p.case_id = b.case_id
)
select *
from reranked
order by score desc, decision_date desc nulls last
limit greatest(1, least(match_count, 200));
$$;

create or replace function nomologies.hybrid_case_search(
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
  select *
  from nomologies.hybrid_case_search_v10(query_text, query_embedding, filters, match_count);
$$;

revoke all on function nomologies.ordered_token_proximity_indexed(text,text) from public;
revoke all on function nomologies.hybrid_case_search_v10(text,vector,jsonb,integer) from public;
revoke all on function nomologies.hybrid_case_search(text,vector,jsonb,integer) from public;
grant execute on function nomologies.ordered_token_proximity_indexed(text,text) to service_role;
grant execute on function nomologies.hybrid_case_search_v10(text,vector,jsonb,integer) to service_role;
grant execute on function nomologies.hybrid_case_search(text,vector,jsonb,integer) to service_role;
