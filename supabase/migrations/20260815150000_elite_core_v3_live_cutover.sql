-- Elite Core V3 live reprocess cutover.
--
-- This migration is deliberately rollback-safe:
--   * the existing /cases/:id/reprocess API contract remains unchanged;
--   * the existing V2 pipeline run becomes a status/progress shadow;
--   * the current canonical case version is never overwritten automatically;
--   * the feature can be disabled instantly through system_controls.

create table if not exists nomologies.core_v3_live_links (
  core_run_id uuid primary key references nomologies.core_v3_runs(id) on delete cascade,
  v2_run_id uuid not null unique references nomologies.pipeline_runs(id) on delete cascade,
  case_id uuid not null references nomologies.cases(id) on delete cascade,
  batch_id uuid references nomologies.bulk_batches(id) on delete set null,
  bulk_item_id uuid references nomologies.bulk_items(id) on delete set null,
  baseline_version_id uuid references nomologies.case_versions(id) on delete set null,
  candidate_version_id uuid references nomologies.case_versions(id) on delete set null,
  auto_publish boolean not null default false,
  status text not null default 'queued'
    check (status in ('queued','running','review','completed','failed','cancelled')),
  phase text not null default 'worker',
  attempt_count integer not null default 0,
  max_attempts integer not null default 8,
  driver_token text not null default '',
  orchestrator_locked_at timestamptz,
  orchestrator_locked_until timestamptz,
  orchestrator_locked_by text not null default '',
  result jsonb not null default '{}'::jsonb,
  error_code text not null default '',
  error_message text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists core_v3_live_links_status_idx
  on nomologies.core_v3_live_links(status,updated_at)
  where status in ('queued','running');
create index if not exists core_v3_live_links_case_idx
  on nomologies.core_v3_live_links(case_id,created_at desc);

alter table nomologies.core_v3_live_links enable row level security;
revoke all on nomologies.core_v3_live_links from public,anon,authenticated;
grant all on nomologies.core_v3_live_links to service_role;

insert into nomologies.system_controls(control_key,enabled,reason,updated_at)
values
  ('elite_core_v3_live_enabled',true,'Route existing-case reprocessing through elite-core-v3 while preserving the current canonical version.',now()),
  ('elite_core_v3_auto_publish_enabled',false,'Core V3 candidates require review by default. Automatic publication remains disabled until an explicit production decision.',now())
on conflict(control_key) do update
set enabled=excluded.enabled,
    reason=excluded.reason,
    updated_at=excluded.updated_at;

create or replace function nomologies.claim_core_v3_live_link(
  p_core_run_id uuid,
  p_worker_name text,
  p_lease_seconds integer default 120
)
returns setof nomologies.core_v3_live_links
language plpgsql
security definer
set search_path=nomologies,public
as $$
declare
  claimed_id uuid;
begin
  select core_run_id into claimed_id
  from nomologies.core_v3_live_links
  where core_run_id=p_core_run_id
    and status in ('queued','running')
    and phase <> 'done'
    and (
      orchestrator_locked_until is null
      or orchestrator_locked_until < now()
      or orchestrator_locked_by=p_worker_name
    )
  for update skip locked;

  if claimed_id is null then
    return;
  end if;

  return query
  update nomologies.core_v3_live_links
  set status='running',
      orchestrator_locked_at=now(),
      orchestrator_locked_until=now()+make_interval(secs=>greatest(60,p_lease_seconds)),
      orchestrator_locked_by=p_worker_name,
      updated_at=now()
  where core_run_id=claimed_id
  returning *;
end;
$$;

revoke all on function nomologies.claim_core_v3_live_link(uuid,text,integer) from public,anon,authenticated;
grant execute on function nomologies.claim_core_v3_live_link(uuid,text,integer) to service_role;

create or replace function nomologies.redirect_case_reprocess_to_core_v3()
returns trigger
language plpgsql
security definer
set search_path=nomologies,public,extensions,net
as $$
declare
  run_row nomologies.pipeline_runs%rowtype;
  case_row nomologies.cases%rowtype;
  case_uuid uuid;
  core_uuid uuid;
  driver_token_value text;
  feature_enabled boolean := false;
  baseline_score_value integer := 0;
  requested_auto_publish boolean := false;
  request_id bigint;
begin
  if new.stage <> 'source' or new.status <> 'queued' then
    return new;
  end if;

  select * into run_row
  from nomologies.pipeline_runs
  where id=new.run_id;

  if not found
     or coalesce(run_row.stage_state #>> '{createdBy}','') <> 'case-reprocess'
     or coalesce(run_row.stage_state #>> '{coreV3,bypass}','false')='true'
     or coalesce(new.payload->>'pipeline','')='v2' then
    return new;
  end if;

  select enabled into feature_enabled
  from nomologies.system_controls
  where control_key='elite_core_v3_live_enabled';

  if not coalesce(feature_enabled,false) then
    return new;
  end if;

  begin
    case_uuid := nullif(run_row.stage_state #>> '{reprocess,caseId}','')::uuid;
  exception when others then
    case_uuid := null;
  end;

  if case_uuid is null then
    return new;
  end if;

  if exists (
    select 1 from nomologies.core_v3_live_links
    where v2_run_id=new.run_id
  ) then
    update nomologies.pipeline_tasks
    set status='cancelled',
        completed_at=coalesce(completed_at,now()),
        last_error_code='',
        last_error_message='',
        updated_at=now()
    where id=new.id;
    return new;
  end if;

  select * into case_row
  from nomologies.cases
  where id=case_uuid;

  if not found or case_row.current_version_id is null then
    return new;
  end if;

  select coalesce(readiness_score,0) into baseline_score_value
  from nomologies.case_versions
  where id=case_row.current_version_id;

  requested_auto_publish := lower(coalesce(run_row.stage_state #>> '{reprocess,autoPublish}','')) in ('true','1','yes');
  driver_token_value := encode(gen_random_bytes(32),'hex');

  insert into nomologies.core_v3_runs(
    case_id,
    label,
    benchmark_suite,
    baseline_version_id,
    baseline_score,
    source_url,
    model,
    status,
    current_stage,
    blockers,
    metrics,
    created_at,
    updated_at
  ) values (
    case_uuid,
    case_row.case_name,
    'elite-core-v3-live',
    case_row.current_version_id,
    baseline_score_value,
    case_row.source_url,
    'gpt-5.4-mini',
    'queued',
    'source',
    '[]'::jsonb,
    jsonb_build_object(
      'live',true,
      'v2RunId',new.run_id,
      'requestedAt',now(),
      'candidateOnly',not requested_auto_publish
    ),
    now(),
    now()
  ) returning id into core_uuid;

  insert into nomologies.core_v3_tasks(
    run_id,stage,status,priority,payload,available_at,created_at,updated_at
  ) values (
    core_uuid,
    'source',
    'queued',
    250,
    jsonb_build_object(
      'live',true,
      'v2RunId',new.run_id,
      'caseId',case_uuid,
      'sourceUrl',case_row.source_url
    ),
    now(),
    now(),
    now()
  );

  insert into nomologies.core_v3_live_links(
    core_run_id,
    v2_run_id,
    case_id,
    batch_id,
    bulk_item_id,
    baseline_version_id,
    auto_publish,
    status,
    phase,
    driver_token,
    result,
    created_at,
    updated_at
  ) values (
    core_uuid,
    new.run_id,
    case_uuid,
    run_row.batch_id,
    run_row.bulk_item_id,
    case_row.current_version_id,
    requested_auto_publish,
    'queued',
    'worker',
    driver_token_value,
    jsonb_build_object('redirectedFrom','nomologies-v2-reprocess'),
    now(),
    now()
  );

  update nomologies.pipeline_tasks
  set status='cancelled',
      result=jsonb_build_object(
        'redirected',true,
        'pipeline','elite-core-v3',
        'coreRunId',core_uuid
      ),
      completed_at=now(),
      locked_at=null,
      locked_until=null,
      locked_by='',
      last_error_code='',
      last_error_message='',
      updated_at=now()
  where id=new.id;

  update nomologies.pipeline_runs
  set schema_version='elite-core-v3.9',
      status='running',
      current_stage='core_v3_source',
      model='gpt-5.4-mini',
      readiness_score=0,
      strict_ready=false,
      human_review_required=true,
      error_code='',
      error_message='',
      started_at=coalesce(started_at,now()),
      completed_at=null,
      stage_state=coalesce(stage_state,'{}'::jsonb) || jsonb_build_object(
        'coreV3',jsonb_build_object(
          'enabled',true,
          'coreRunId',core_uuid,
          'pipeline','elite-core-v3.9',
          'model','gpt-5.4-mini',
          'phase','worker',
          'baselineVersionId',case_row.current_version_id,
          'baselineScore',baseline_score_value,
          'candidateOnly',not requested_auto_publish,
          'redirectedAt',now()
        )
      ),
      updated_at=now()
  where id=new.run_id;

  update nomologies.cases
  set pending_version_id=null,
      pending_run_id=new.run_id,
      pending_readiness_score=null,
      pending_strict_ready=null,
      pending_created_at=now(),
      human_review_required=true,
      updated_at=now()
  where id=case_uuid;

  if run_row.bulk_item_id is not null then
    update nomologies.bulk_items
    set pipeline_run_id=new.run_id,
        status='processing',
        current_stage='core_v3_source',
        progress=2,
        attempt_count=0,
        last_error_code='',
        last_error_message='',
        result_summary=coalesce(result_summary,'{}'::jsonb) || jsonb_build_object(
          'reprocess',jsonb_build_object(
            'runId',new.run_id,
            'coreRunId',core_uuid,
            'pipeline','elite-core-v3.9',
            'requestedAt',now(),
            'autoPublish',requested_auto_publish
          )
        ),
        updated_at=now()
    where id=run_row.bulk_item_id;
  end if;

  insert into nomologies.pipeline_events(
    run_id,batch_id,bulk_item_id,level,event_type,message,data
  ) values (
    new.run_id,
    run_row.batch_id,
    run_row.bulk_item_id,
    'info',
    'core_v3_live_redirected',
    'Case reprocessing was routed to the elite Core V3 pipeline.',
    jsonb_build_object(
      'caseId',case_uuid,
      'coreRunId',core_uuid,
      'model','gpt-5.4-mini',
      'baselineVersionId',case_row.current_version_id
    )
  );

  select net.http_post(
    url:='https://btfggtdysjgdjgmvqdbt.supabase.co/functions/v1/nomologies-core-v3-live-driver',
    headers:=jsonb_build_object('content-type','application/json'),
    body:=jsonb_build_object('coreRunId',core_uuid,'driverToken',driver_token_value),
    timeout_milliseconds:=5000
  ) into request_id;

  update nomologies.core_v3_live_links
  set result=result || jsonb_build_object('driverRequestId',request_id),
      updated_at=now()
  where core_run_id=core_uuid;

  return new;
end;
$$;

revoke all on function nomologies.redirect_case_reprocess_to_core_v3() from public,anon,authenticated;
grant execute on function nomologies.redirect_case_reprocess_to_core_v3() to service_role;

drop trigger if exists redirect_case_reprocess_to_core_v3_trigger on nomologies.pipeline_tasks;
create trigger redirect_case_reprocess_to_core_v3_trigger
after insert on nomologies.pipeline_tasks
for each row execute function nomologies.redirect_case_reprocess_to_core_v3();

comment on table nomologies.core_v3_live_links is
  'Rollback-safe link between the existing Nomologies API run contract and elite Core V3 candidate extraction.';
comment on function nomologies.redirect_case_reprocess_to_core_v3() is
  'Routes only existing-case reprocessing into Core V3. Disable with system_controls.elite_core_v3_live_enabled=false to restore the V2 route immediately.';
