create table if not exists nomologies.core_v3_runs (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references nomologies.cases(id) on delete cascade,
  label text not null default '',
  benchmark_suite text not null default '',
  baseline_version_id uuid references nomologies.case_versions(id) on delete set null,
  baseline_score integer,
  source_url text not null,
  model text not null default 'gpt-5.4-mini',
  status text not null default 'queued' check (status in ('queued','running','completed','failed','cancelled')),
  current_stage text not null default 'source',
  core_status text check (core_status in ('pass','review')),
  source_artifact_path text not null default '',
  agents_artifact_path text not null default '',
  verification_artifact_path text not null default '',
  record_artifact_path text not null default '',
  candidate_record jsonb,
  verification_record jsonb,
  blockers jsonb not null default '[]'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  error_code text not null default '',
  error_message text not null default '',
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists nomologies.core_v3_tasks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references nomologies.core_v3_runs(id) on delete cascade,
  stage text not null check (stage in ('source','extract','verify')),
  status text not null default 'queued' check (status in ('queued','running','succeeded','retry','failed','cancelled')),
  priority integer not null default 100,
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_until timestamptz,
  locked_by text not null default '',
  last_error_code text not null default '',
  last_error_message text not null default '',
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(run_id,stage)
);

create index if not exists core_v3_runs_case_created_idx
  on nomologies.core_v3_runs(case_id,created_at desc);
create index if not exists core_v3_runs_suite_created_idx
  on nomologies.core_v3_runs(benchmark_suite,created_at desc);
create index if not exists core_v3_tasks_claim_idx
  on nomologies.core_v3_tasks(status,available_at,priority desc,created_at)
  where status in ('queued','retry');
create index if not exists core_v3_tasks_run_idx
  on nomologies.core_v3_tasks(run_id,created_at);

alter table nomologies.core_v3_runs enable row level security;
alter table nomologies.core_v3_tasks enable row level security;

revoke all on nomologies.core_v3_runs from anon, authenticated;
revoke all on nomologies.core_v3_tasks from anon, authenticated;

grant all on nomologies.core_v3_runs to service_role;
grant all on nomologies.core_v3_tasks to service_role;

create or replace function nomologies.claim_core_v3_task(
  worker_name text,
  lease_seconds integer default 240
)
returns setof nomologies.core_v3_tasks
language plpgsql
security definer
set search_path=nomologies,public
as $$
declare
  claimed_id uuid;
begin
  select id into claimed_id
  from nomologies.core_v3_tasks
  where status in ('queued','retry')
    and available_at <= now()
    and (locked_until is null or locked_until < now())
  order by priority desc, created_at asc
  for update skip locked
  limit 1;

  if claimed_id is null then
    return;
  end if;

  return query
  update nomologies.core_v3_tasks
  set status='running',
      attempt_count=attempt_count+1,
      locked_at=now(),
      locked_until=now()+make_interval(secs=>greatest(60,lease_seconds)),
      locked_by=worker_name,
      started_at=coalesce(started_at,now()),
      completed_at=null,
      updated_at=now()
  where id=claimed_id
  returning *;
end;
$$;

revoke all on function nomologies.claim_core_v3_task(text,integer) from public,anon,authenticated;
grant execute on function nomologies.claim_core_v3_task(text,integer) to service_role;

comment on table nomologies.core_v3_runs is
  'Candidate-only elite-core-v3 extraction runs. Never changes cases.current_version_id or public search.';
comment on table nomologies.core_v3_tasks is
  'Durable task queue for elite-core-v3 shadow extraction.';
