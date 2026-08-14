create table if not exists nomologies.search_query_events (
  id bigserial primary key,
  query_hash text not null,
  intent text not null,
  retrieval_mode text not null,
  result_count integer not null,
  duration_ms integer not null,
  semantic_used boolean not null default false,
  semantic_degraded boolean not null default false,
  top_score numeric,
  created_at timestamptz not null default now()
);
alter table nomologies.search_query_events enable row level security;
create index if not exists search_query_events_created_idx on nomologies.search_query_events(created_at desc);

create table if not exists nomologies.search_rate_limits (
  bucket_key text primary key,
  window_started_at timestamptz not null,
  request_count integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table nomologies.search_rate_limits enable row level security;

create or replace function nomologies.consume_search_rate_limit(
  p_bucket_key text,
  p_limit integer default 120,
  p_window_seconds integer default 60
) returns boolean
language plpgsql
security definer
set search_path = nomologies, public
as $$
declare
  allowed boolean;
begin
  insert into nomologies.search_rate_limits(bucket_key, window_started_at, request_count, updated_at)
  values (p_bucket_key, now(), 1, now())
  on conflict (bucket_key) do update set
    window_started_at = case when nomologies.search_rate_limits.window_started_at < now() - make_interval(secs => p_window_seconds) then now() else nomologies.search_rate_limits.window_started_at end,
    request_count = case when nomologies.search_rate_limits.window_started_at < now() - make_interval(secs => p_window_seconds) then 1 else nomologies.search_rate_limits.request_count + 1 end,
    updated_at = now();

  select request_count <= greatest(1, p_limit) into allowed
  from nomologies.search_rate_limits where bucket_key = p_bucket_key;
  return coalesce(allowed, false);
end;
$$;
revoke all on function nomologies.consume_search_rate_limit(text,integer,integer) from public;

create table if not exists nomologies.search_eval_queries (
  id uuid primary key default gen_random_uuid(),
  query_text text not null unique,
  language text not null default 'el',
  intent text not null,
  label_source text not null default 'system_seed',
  human_reviewed boolean not null default false,
  active boolean not null default true,
  notes text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists nomologies.search_eval_labels (
  query_id uuid not null references nomologies.search_eval_queries(id) on delete cascade,
  case_id uuid not null references nomologies.cases(id) on delete cascade,
  relevance smallint not null check (relevance between 0 and 3),
  primary key(query_id, case_id)
);

create table if not exists nomologies.search_eval_runs (
  id uuid primary key default gen_random_uuid(),
  search_version text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  metrics jsonb not null default '{}'::jsonb,
  passed boolean,
  notes text not null default ''
);

create table if not exists nomologies.search_eval_results (
  run_id uuid not null references nomologies.search_eval_runs(id) on delete cascade,
  query_id uuid not null references nomologies.search_eval_queries(id) on delete cascade,
  rank integer,
  reciprocal_rank numeric,
  recall_at_5 numeric,
  recall_at_10 numeric,
  ndcg_at_10 numeric,
  duration_ms integer,
  returned_case_ids uuid[] not null default '{}',
  primary key(run_id, query_id)
);

alter table nomologies.search_eval_queries enable row level security;
alter table nomologies.search_eval_labels enable row level security;
alter table nomologies.search_eval_runs enable row level security;
alter table nomologies.search_eval_results enable row level security;

with seed(query_text, language, intent, expected_case_id) as (
  values
  ('Alexander Keith Edward','en','identity','bed1353b-4fd5-44dc-9b32-e4b4ec7d07d3'::uuid),
  ('30/2016','el','identity','bed1353b-4fd5-44dc-9b32-e4b4ec7d07d3'::uuid),
  ('Κεφ. 224 άρθρο 61','el','provision','bed1353b-4fd5-44dc-9b32-e4b4ec7d07d3'::uuid),
  ('εχθρική κατοχή','el','concept','bed1353b-4fd5-44dc-9b32-e4b4ec7d07d3'::uuid),
  ('adverse possession','en','concept','bed1353b-4fd5-44dc-9b32-e4b4ec7d07d3'::uuid),
  ('echthriki katochi','greeklish','concept','bed1353b-4fd5-44dc-9b32-e4b4ec7d07d3'::uuid),
  ('Σωκράτους','el','identity','67c09376-96d6-413c-bfe4-ebefda68d3fb'::uuid),
  ('405/2016','el','identity','67c09376-96d6-413c-bfe4-ebefda68d3fb'::uuid),
  ('εύλογη προσδοκία ιδιωτικής ζωής','el','concept','67c09376-96d6-413c-bfe4-ebefda68d3fb'::uuid),
  ('reasonable expectation of privacy','en','concept','67c09376-96d6-413c-bfe4-ebefda68d3fb'::uuid),
  ('συμφωνία υπό αίρεση','el','concept','d48dd390-a9b2-4ab4-88ef-f9111d136e15'::uuid),
  ('conditional contract misrepresentation','en','natural_language','d48dd390-a9b2-4ab4-88ef-f9111d136e15'::uuid),
  ('δεδικασμένο ενοίκια','el','concept','0bd0e115-de6b-4bd2-a27b-cf0b59a82edf'::uuid),
  ('res judicata rent','en','concept','0bd0e115-de6b-4bd2-a27b-cf0b59a82edf'::uuid),
  ('γενικοί και αόριστοι λόγοι έφεσης','el','natural_language','e560fd6d-93fa-4a5e-9c18-657d6ab88cf7'::uuid),
  ('διαμεσολάβηση ασφαλιστήρια','el','concept','b0a6891a-d7a7-4a77-8d86-28ed8ae93c24'::uuid),
  ('φορολογική δήλωση δάνειο','el','concept','5c28bdde-c92f-4df0-9abc-3e24af8c55ac'::uuid),
  ('Mandamus δημόσιο καθήκον','mixed','concept','404d07fa-64bd-4204-978d-7af5b33c137c'::uuid)
), inserted as (
  insert into nomologies.search_eval_queries(query_text,language,intent,label_source,human_reviewed)
  select query_text,language,intent,'system_seed',false from seed
  on conflict (query_text) do update set language=excluded.language,intent=excluded.intent
  returning id,query_text
)
insert into nomologies.search_eval_labels(query_id,case_id,relevance)
select q.id, s.expected_case_id, 3
from seed s join nomologies.search_eval_queries q using(query_text)
on conflict (query_id,case_id) do update set relevance=excluded.relevance;

