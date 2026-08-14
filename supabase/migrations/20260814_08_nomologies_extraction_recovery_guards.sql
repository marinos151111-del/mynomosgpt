-- Global Nomologies extraction recovery guards.
-- Applied in production on 14 August 2026 after destructive elite-lean-v2
-- grouped repairs removed legally material fields and reduced readiness.

create table if not exists nomologies.engine_controls (
  control_key text primary key,
  enabled boolean not null,
  reason text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table nomologies.engine_controls enable row level security;
revoke all on table nomologies.engine_controls from anon,authenticated;
grant all on table nomologies.engine_controls to service_role;

insert into nomologies.engine_controls(control_key,enabled,reason,metadata,updated_at)
values(
  'elite_lean_v2_frozen',true,
  'Global production freeze after confirmed destructive grouped-repair regressions and loss of ratio, obiter, grounds and authorities.',
  jsonb_build_object('scope','nomologies extraction only','frontendUnaffected',true,'searchV10Unaffected',true),
  now()
)
on conflict(control_key) do update set
  enabled=excluded.enabled,reason=excluded.reason,metadata=excluded.metadata,updated_at=excluded.updated_at;

create or replace function nomologies.guard_lean_pipeline_task()
returns trigger
language plpgsql
security definer
set search_path=nomologies,public
as $$
declare
  frozen boolean;
  bypass boolean := coalesce(current_setting('nomologies.allow_engine_recovery',true),'')='on';
begin
  if bypass then return new; end if;
  select enabled into frozen from nomologies.engine_controls where control_key='elite_lean_v2_frozen';
  if coalesce(frozen,false)
     and new.stage in ('agent-facts-procedure','agent-analysis-authorities','repair-facts-procedure','repair-analysis-authorities')
     and new.status in ('queued','running','retrying') then
    raise exception using
      errcode='P0001',message='ELITE_LEAN_V2_FROZEN',
      detail='Grouped extraction/repair stages are frozen after confirmed global legal-record regressions.';
  end if;
  return new;
end;
$$;
revoke all on function nomologies.guard_lean_pipeline_task() from public;
drop trigger if exists guard_lean_pipeline_task_trigger on nomologies.pipeline_tasks;
create trigger guard_lean_pipeline_task_trigger
before insert or update of stage,status on nomologies.pipeline_tasks
for each row execute function nomologies.guard_lean_pipeline_task();

create or replace function nomologies.json_field_count(p_record jsonb,p_path text[])
returns integer
language plpgsql
immutable
parallel safe
set search_path=nomologies,public
as $$
declare value jsonb := p_record #> (p_path||array['value']);
begin
  if jsonb_typeof(value)='array' then return jsonb_array_length(value); end if;
  if jsonb_typeof(value)='string' then return length(trim(both '"' from value::text)); end if;
  if value is null then return 0; end if;
  return 1;
end;
$$;

create or replace function nomologies.field_available_but_empty(p_record jsonb,p_path text[])
returns boolean
language plpgsql
immutable
parallel safe
set search_path=nomologies,public
as $$
declare
  status text := p_record #>> (p_path||array['status']);
  value jsonb := p_record #> (p_path||array['value']);
begin
  if status is distinct from 'available' then return false; end if;
  if value is null or value='null'::jsonb then return true; end if;
  if jsonb_typeof(value)='array' then return jsonb_array_length(value)=0; end if;
  if jsonb_typeof(value)='string' then return length(trim(both '"' from value::text))=0; end if;
  if jsonb_typeof(value)='object' then return value='{}'::jsonb; end if;
  return false;
end;
$$;

create or replace function nomologies.guard_repair_score_monotonic()
returns trigger
language plpgsql
security definer
set search_path=nomologies,public
as $$
declare
  initial_score integer;
  initial_record_path text;
  initial_reviewer_path text;
  bypass boolean := coalesce(current_setting('nomologies.allow_engine_recovery',true),'')='on';
begin
  if bypass then return new; end if;
  if new.current_stage='persist'
     and new.stage_state #>> '{initialVerification,readinessScore}' is not null
     and new.stage_state #>> '{finalVerification,readinessScore}' is not null then
    initial_score := (new.stage_state #>> '{initialVerification,readinessScore}')::integer;
    initial_record_path := new.stage_state #>> '{initialVerification,recordPath}';
    initial_reviewer_path := new.stage_state #>> '{initialVerification,reviewerPath}';
    if coalesce(new.readiness_score,0)<initial_score
       and initial_record_path is not null and initial_reviewer_path is not null then
      new.record_artifact_path := initial_record_path;
      new.reviewer_artifact_path := initial_reviewer_path;
      new.readiness_score := initial_score;
      new.strict_ready := false;
      new.human_review_required := true;
      new.stage_state := jsonb_set(new.stage_state,'{repairRegressionFallback}',jsonb_build_object(
        'applied',true,'reason','final repair reduced readiness; initial verified record preserved',
        'initialScore',initial_score,'rejectedFinalScore',new.stage_state #>> '{finalVerification,readinessScore}',
        'recordPath',initial_record_path,'reviewerPath',initial_reviewer_path,'appliedAt',now()
      ),true);
    end if;
  end if;
  return new;
end;
$$;
revoke all on function nomologies.guard_repair_score_monotonic() from public;
drop trigger if exists guard_repair_score_monotonic_trigger on nomologies.pipeline_runs;
create trigger guard_repair_score_monotonic_trigger
before update of current_stage,readiness_score,record_artifact_path,reviewer_artifact_path,stage_state on nomologies.pipeline_runs
for each row execute function nomologies.guard_repair_score_monotonic();

create or replace function nomologies.guard_case_publication_regression()
returns trigger
language plpgsql
security definer
set search_path=nomologies,public
as $$
declare
  bypass boolean := coalesce(current_setting('nomologies.allow_engine_recovery',true),'')='on';
  target_version nomologies.case_versions%rowtype;
  previous_version nomologies.case_versions%rowtype;
  target_orchestration text := '';
  target_critical integer := 0;
  previous_critical integer := 0;
  target_ratio integer := 0;
  previous_ratio integer := 0;
  target_issues integer := 0;
  target_holding integer := 0;
  target_grounds integer := 0;
  previous_grounds integer := 0;
  target_authorities integer := 0;
  previous_authorities integer := 0;
  target_principle integer := 0;
  previous_principle integer := 0;
begin
  if bypass then return new; end if;
  if new.current_version_id is null then return new; end if;
  if new.current_version_id is not distinct from old.current_version_id
     and new.publication_status is not distinct from old.publication_status then return new; end if;

  select * into target_version from nomologies.case_versions where id=new.current_version_id and case_id=new.id;
  if not found then raise exception using errcode='P0001',message='INVALID_CASE_VERSION_POINTER'; end if;
  select coalesce(stage_state #>> '{orchestration,version}','') into target_orchestration
  from nomologies.pipeline_runs where id=target_version.run_id;

  if target_orchestration='elite-lean-v2'
     and (new.publication_status='published' or old.publication_status='published') then
    raise exception using errcode='P0001',message='ELITE_LEAN_V2_PUBLICATION_FROZEN',
      detail='A version produced by the frozen elite-lean-v2 profile cannot be the live published version.';
  end if;

  target_ratio := nomologies.json_field_count(target_version.canonical_record,array['analysis','ratioDecidendi']);
  target_issues := nomologies.json_field_count(target_version.canonical_record,array['analysis','legalIssues']);
  target_holding := nomologies.json_field_count(target_version.canonical_record,array['analysis','holding']);
  target_grounds := nomologies.json_field_count(target_version.canonical_record,array['procedure','groundsOrIssues']);
  target_authorities := nomologies.json_field_count(target_version.canonical_record,array['authorities','authorities']);
  target_principle := nomologies.json_field_count(target_version.canonical_record,array['analysis','legalPrincipleSummary']);

  if new.publication_status='published' then
    if nomologies.field_available_but_empty(target_version.canonical_record,array['analysis','legalPrincipleSummary'])
       or nomologies.field_available_but_empty(target_version.canonical_record,array['analysis','ratioDecidendi'])
       or nomologies.field_available_but_empty(target_version.canonical_record,array['authorities','authorities'])
       or nomologies.field_available_but_empty(target_version.canonical_record,array['procedure','groundsOrIssues']) then
      raise exception using errcode='P0001',message='AVAILABLE_FIELD_IS_EMPTY';
    end if;
    if target_principle=0 and target_ratio=0 then
      raise exception using errcode='P0001',message='MINIMUM_LEGAL_CORE_MISSING';
    end if;
    if target_issues=0 and target_holding=0 then
      raise exception using errcode='P0001',message='MINIMUM_DECISION_ANALYSIS_MISSING';
    end if;
  end if;

  if old.current_version_id is not null and old.publication_status='published'
     and new.current_version_id is distinct from old.current_version_id then
    select * into previous_version from nomologies.case_versions where id=old.current_version_id;
    target_critical := coalesce((select count(*) from jsonb_array_elements(coalesce(target_version.conflict_summary->'conflicts','[]'::jsonb)) x where x->>'severity'='critical'),0);
    previous_critical := coalesce((select count(*) from jsonb_array_elements(coalesce(previous_version.conflict_summary->'conflicts','[]'::jsonb)) x where x->>'severity'='critical'),0);
    previous_ratio := nomologies.json_field_count(previous_version.canonical_record,array['analysis','ratioDecidendi']);
    previous_grounds := nomologies.json_field_count(previous_version.canonical_record,array['procedure','groundsOrIssues']);
    previous_authorities := nomologies.json_field_count(previous_version.canonical_record,array['authorities','authorities']);
    previous_principle := nomologies.json_field_count(previous_version.canonical_record,array['analysis','legalPrincipleSummary']);
    if target_version.readiness_score<previous_version.readiness_score
       or target_critical>previous_critical
       or (previous_ratio>0 and target_ratio=0)
       or (previous_grounds>0 and target_grounds=0)
       or (previous_authorities>0 and target_authorities=0)
       or (previous_principle>0 and target_principle=0) then
      raise exception using errcode='P0001',message='PUBLISHED_CASE_REGRESSION_BLOCKED',
        detail=format('score %s→%s; critical %s→%s; ratio %s→%s; grounds %s→%s; authorities %s→%s; principle %s→%s',
          previous_version.readiness_score,target_version.readiness_score,previous_critical,target_critical,
          previous_ratio,target_ratio,previous_grounds,target_grounds,previous_authorities,target_authorities,
          previous_principle,target_principle);
    end if;
  end if;
  return new;
end;
$$;
revoke all on function nomologies.guard_case_publication_regression() from public;
drop trigger if exists guard_case_publication_regression_trigger on nomologies.cases;
create trigger guard_case_publication_regression_trigger
before update of current_version_id,publication_status on nomologies.cases
for each row execute function nomologies.guard_case_publication_regression();

create table if not exists nomologies.case_recovery_events (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references nomologies.cases(id) on delete cascade,
  from_version_id uuid references nomologies.case_versions(id) on delete set null,
  to_version_id uuid not null references nomologies.case_versions(id) on delete restrict,
  action text not null,
  reason text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists case_recovery_events_case_created_idx on nomologies.case_recovery_events(case_id,created_at desc);
alter table nomologies.case_recovery_events enable row level security;
revoke all on table nomologies.case_recovery_events from anon,authenticated;
grant all on table nomologies.case_recovery_events to service_role;
