-- Nomologies V2 elite search persistence layer.
-- Run only in a development Supabase project until the benchmark gates pass.

create extension if not exists vector;
create extension if not exists pg_trgm;
create extension if not exists unaccent;

create schema if not exists nomologies;

create or replace function nomologies.normalize_search_text(input text)
returns text
language sql
stable
parallel safe
as $$
  select trim(regexp_replace(
    lower(unaccent(coalesce(input, ''))),
    '[^[:alnum:]α-ωΑ-Ωάέήίόύώϊϋΐΰ/().:%+€$''"-]+',
    ' ',
    'g'
  ));
$$;

create table if not exists nomologies.case_search_documents (
  case_id text primary key,
  run_id uuid,
  source_hash text not null unique,
  source_url text not null default '',
  title text not null,
  short_title text not null default '',
  citation text not null default '',
  case_number text not null default '',
  ecli text not null default '',
  decision_date date,
  decision_year integer,
  court text not null default '',
  court_level text not null default '',
  case_family text not null default '',
  primary_legal_area text not null default '',
  legal_areas text[] not null default '{}',
  proceeding_type text not null default '',
  procedural_posture text not null default '',
  outcome text not null default '',
  judges text[] not null default '{}',
  authoring_judges text[] not null default '{}',
  aliases text[] not null default '{}',
  exact_terms text[] not null default '{}',
  law_ids text[] not null default '{}',
  provision_keys text[] not null default '{}',
  authority_treatments text[] not null default '{}',
  authority_contexts text[] not null default '{}',
  readiness_score integer not null default 0 check (readiness_score between 0 and 100),
  strict_ready boolean not null default false,
  human_review_required boolean not null default true,
  critical_conflicts integer not null default 0,
  material_conflicts integer not null default 0,
  evidence_count integer not null default 0,
  canonical_record jsonb not null,
  indexed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists case_search_documents_case_number_idx
  on nomologies.case_search_documents (case_number);
create index if not exists case_search_documents_citation_trgm_idx
  on nomologies.case_search_documents using gin (citation gin_trgm_ops);
create index if not exists case_search_documents_title_trgm_idx
  on nomologies.case_search_documents using gin (title gin_trgm_ops);
create index if not exists case_search_documents_year_idx
  on nomologies.case_search_documents (decision_year desc);
create index if not exists case_search_documents_facets_idx
  on nomologies.case_search_documents (case_family, primary_legal_area, proceeding_type, court_level, outcome);
create index if not exists case_search_documents_legal_areas_idx
  on nomologies.case_search_documents using gin (legal_areas);
create index if not exists case_search_documents_judges_idx
  on nomologies.case_search_documents using gin (judges);
create index if not exists case_search_documents_laws_idx
  on nomologies.case_search_documents using gin (law_ids);
create index if not exists case_search_documents_provisions_idx
  on nomologies.case_search_documents using gin (provision_keys);
create index if not exists case_search_documents_record_idx
  on nomologies.case_search_documents using gin (canonical_record jsonb_path_ops);

create table if not exists nomologies.case_search_fields (
  case_id text not null references nomologies.case_search_documents(case_id) on delete cascade,
  field_name text not null check (field_name in (
    'identity','principle','ratio','holding','issues','provisions','authorities',
    'outcome','procedure','facts','evidence','chronology'
  )),
  field_weight numeric(5,2) not null check (field_weight > 0),
  field_text text not null,
  normalized_text text not null default '',
  paragraph_ids text[] not null default '{}',
  lexical tsvector,
  embedding vector(1024),
  embedding_model text not null default '',
  embedding_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (case_id, field_name)
);

create or replace function nomologies.prepare_search_field()
returns trigger
language plpgsql
as $$
begin
  new.normalized_text := nomologies.normalize_search_text(new.field_text);
  new.lexical := to_tsvector('simple', new.normalized_text);
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists prepare_search_field_trigger on nomologies.case_search_fields;
create trigger prepare_search_field_trigger
before insert or update of field_text
on nomologies.case_search_fields
for each row execute function nomologies.prepare_search_field();

create index if not exists case_search_fields_lexical_idx
  on nomologies.case_search_fields using gin (lexical);
create index if not exists case_search_fields_trgm_idx
  on nomologies.case_search_fields using gin (normalized_text gin_trgm_ops);
create index if not exists case_search_fields_embedding_hnsw_idx
  on nomologies.case_search_fields using hnsw (embedding vector_cosine_ops);
create index if not exists case_search_fields_case_field_idx
  on nomologies.case_search_fields (case_id, field_name, field_weight desc);

create table if not exists nomologies.smart_tags (
  tag_id text primary key,
  label text not null,
  normalized text not null,
  kind text not null check (kind in (
    'identity','legal_area','procedure','issue','principle','outcome',
    'provision','authority','evidence','fact','remedy'
  )),
  aliases text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kind, normalized)
);

create index if not exists smart_tags_normalized_trgm_idx
  on nomologies.smart_tags using gin (normalized gin_trgm_ops);
create index if not exists smart_tags_aliases_idx
  on nomologies.smart_tags using gin (aliases);

create table if not exists nomologies.case_smart_tags (
  case_id text not null references nomologies.case_search_documents(case_id) on delete cascade,
  tag_id text not null references nomologies.smart_tags(tag_id) on delete cascade,
  confidence numeric(5,4) not null check (confidence between 0 and 1),
  boost numeric(7,3) not null default 1,
  evidence_paragraph_ids text[] not null default '{}',
  source_field text not null default '',
  created_at timestamptz not null default now(),
  primary key (case_id, tag_id)
);

create index if not exists case_smart_tags_tag_idx
  on nomologies.case_smart_tags (tag_id, boost desc, confidence desc);

create table if not exists nomologies.authority_edges (
  source_case_id text not null references nomologies.case_search_documents(case_id) on delete cascade,
  cited_case_key text not null,
  cited_name text not null,
  cited_citation text not null default '',
  cited_ecli text not null default '',
  treatment text not null default 'unknown',
  citation_context text not null default 'unknown',
  legal_point text not null default '',
  evidence_paragraph_ids text[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (source_case_id, cited_case_key, treatment, citation_context)
);

create index if not exists authority_edges_cited_key_idx
  on nomologies.authority_edges (cited_case_key, treatment, citation_context);
create index if not exists authority_edges_name_trgm_idx
  on nomologies.authority_edges using gin (cited_name gin_trgm_ops);

create table if not exists nomologies.provision_links (
  case_id text not null references nomologies.case_search_documents(case_id) on delete cascade,
  law_id text not null,
  law_label text not null default '',
  provision_key text not null,
  display text not null default '',
  instrument_role text not null default 'unknown',
  application text not null default 'unknown',
  is_primary boolean not null default false,
  proposition text not null default '',
  evidence_paragraph_ids text[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (case_id, law_id, provision_key)
);

create index if not exists provision_links_lookup_idx
  on nomologies.provision_links (law_id, provision_key, is_primary desc);
create index if not exists provision_links_display_trgm_idx
  on nomologies.provision_links using gin (display gin_trgm_ops);

create or replace function nomologies.hybrid_case_search(
  query_text text,
  query_embedding vector(1024) default null,
  filters jsonb default '{}'::jsonb,
  match_count integer default 50
)
returns table (
  case_id text,
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
as $$
with params as (
  select
    nomologies.normalize_search_text(query_text) as normalized_query,
    plainto_tsquery('simple', nomologies.normalize_search_text(query_text)) as ts_query
),
eligible as (
  select d.*
  from nomologies.case_search_documents d
  where
    (coalesce(filters->>'caseFamily','') = '' or d.case_family = filters->>'caseFamily')
    and (coalesce(filters->>'legalArea','') = '' or d.primary_legal_area = filters->>'legalArea' or d.legal_areas @> array[filters->>'legalArea'])
    and (coalesce(filters->>'proceedingType','') = '' or d.proceeding_type = filters->>'proceedingType')
    and (coalesce(filters->>'proceduralPosture','') = '' or d.procedural_posture = filters->>'proceduralPosture')
    and (coalesce(filters->>'courtLevel','') = '' or d.court_level = filters->>'courtLevel')
    and (coalesce(filters->>'court','') = '' or nomologies.normalize_search_text(d.court) like '%' || nomologies.normalize_search_text(filters->>'court') || '%')
    and (coalesce(filters->>'judge','') = '' or exists (
      select 1 from unnest(d.judges) judge
      where nomologies.normalize_search_text(judge) like '%' || nomologies.normalize_search_text(filters->>'judge') || '%'
    ))
    and (coalesce(filters->>'outcome','') = '' or d.outcome = filters->>'outcome')
    and (coalesce(filters->>'lawId','') = '' or exists (
      select 1 from unnest(d.law_ids) law
      where nomologies.normalize_search_text(law) like '%' || nomologies.normalize_search_text(filters->>'lawId') || '%'
    ))
    and (coalesce(filters->>'yearFrom','') = '' or d.decision_year >= (filters->>'yearFrom')::integer)
    and (coalesce(filters->>'yearTo','') = '' or d.decision_year <= (filters->>'yearTo')::integer)
),
field_scores as (
  select
    f.case_id,
    f.field_name,
    f.field_weight,
    ts_rank_cd(f.lexical, p.ts_query, 32)::double precision as lexical_rank,
    similarity(f.normalized_text, p.normalized_query)::double precision as trigram_rank,
    case
      when query_embedding is null or f.embedding is null then 0::double precision
      else greatest(0::double precision, 1 - (f.embedding <=> query_embedding))
    end as semantic_rank
  from nomologies.case_search_fields f
  join eligible d on d.case_id = f.case_id
  cross join params p
  where
    f.lexical @@ p.ts_query
    or similarity(f.normalized_text, p.normalized_query) > 0.08
    or (query_embedding is not null and f.embedding is not null)
),
tag_scores as (
  select
    cst.case_id,
    sum(cst.boost * cst.confidence * case
      when st.normalized = p.normalized_query then 4.5
      when st.normalized like '%' || p.normalized_query || '%' then 2.5
      when exists (
        select 1 from unnest(st.aliases) alias
        where nomologies.normalize_search_text(alias) like '%' || p.normalized_query || '%'
      ) then 2.2
      else 1
    end)::double precision as tag_score
  from nomologies.case_smart_tags cst
  join nomologies.smart_tags st on st.tag_id = cst.tag_id
  join eligible d on d.case_id = cst.case_id
  cross join params p
  where
    st.normalized % p.normalized_query
    or st.normalized like '%' || p.normalized_query || '%'
    or exists (
      select 1 from unnest(st.aliases) alias
      where nomologies.normalize_search_text(alias) % p.normalized_query
    )
  group by cst.case_id
),
aggregated as (
  select
    d.case_id,
    case
      when upper(replace(d.case_number, ' ', '')) = upper(replace(query_text, ' ', '')) then 240
      when nomologies.normalize_search_text(d.title) = p.normalized_query then 230
      when p.normalized_query = any(select nomologies.normalize_search_text(alias) from unnest(d.aliases) alias) then 205
      when nomologies.normalize_search_text(d.title) like '%' || p.normalized_query || '%' then 110
      else 0
    end::double precision as exact_identity_score,
    coalesce(sum(fs.field_weight * (fs.lexical_rank * 5 + fs.trigram_rank * 1.5)), 0)::double precision as lexical_score,
    coalesce(max(fs.semantic_rank * fs.field_weight), 0)::double precision as semantic_score,
    coalesce(max(ts.tag_score), 0)::double precision as tag_score,
    coalesce(array_agg(distinct fs.field_name) filter (where fs.field_name is not null), '{}') as matched_fields,
    d.title,
    d.short_title,
    d.citation,
    d.case_number,
    d.decision_date,
    d.court,
    d.outcome,
    d.readiness_score,
    d.critical_conflicts
  from eligible d
  cross join params p
  left join field_scores fs on fs.case_id = d.case_id
  left join tag_scores ts on ts.case_id = d.case_id
  group by d.case_id, d.title, d.short_title, d.citation, d.case_number,
    d.decision_date, d.court, d.outcome, d.readiness_score, d.critical_conflicts,
    p.normalized_query, ts.tag_score
)
select
  a.case_id,
  (
    a.exact_identity_score
    + a.lexical_score
    + a.semantic_score * 62
    + a.tag_score
    + greatest(-8, least(8, (a.readiness_score - 70)::double precision / 5))
    - a.critical_conflicts * 3
  )::double precision as score,
  a.exact_identity_score,
  a.lexical_score,
  a.semantic_score,
  a.tag_score,
  a.matched_fields,
  a.title,
  a.short_title,
  a.citation,
  a.case_number,
  a.decision_date,
  a.court,
  a.outcome,
  a.readiness_score
from aggregated a
where a.exact_identity_score > 0
   or a.lexical_score > 0
   or a.semantic_score > 0.25
   or a.tag_score > 0
order by score desc, a.decision_date desc nulls last
limit greatest(1, least(match_count, 200));
$$;

alter table nomologies.case_search_documents enable row level security;
alter table nomologies.case_search_fields enable row level security;
alter table nomologies.smart_tags enable row level security;
alter table nomologies.case_smart_tags enable row level security;
alter table nomologies.authority_edges enable row level security;
alter table nomologies.provision_links enable row level security;

-- Intentionally no anon/authenticated policies. The Edge Function owns writes and
-- search RPC execution through the service role until publication rules are final.
comment on schema nomologies is 'Evidence-grounded Cyprus case-law search index';
comment on function nomologies.hybrid_case_search is
  'Hybrid exact, lexical, trigram, semantic and smart-tag retrieval for validated Nomologies V2 records.';
