import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { fetchCyLawJudgment } from "../../../src/nomologies-v2/cylaw.ts";
import { prepareJudgmentSource } from "../../../src/nomologies-v2/source.ts";
import { buildSectionMap } from "../../../src/nomologies-v2/sections.ts";
import {
  combineSpecialistAgentResults,
  runSpecialistAgent,
  type SpecialistAgentKindV2,
  type SpecialistAgentRunV2,
} from "../../../src/nomologies-v2/agents.ts";
import { finalizeNomologiesRecordV2 } from "../../../src/nomologies-v2/staged-finalize.ts";
import { applyDeterministicBaseline } from "../../../src/nomologies-v2/deterministic-baseline.ts";
import { runWholeJudgmentSynthesis } from "../../../src/nomologies-v2/whole-judgment.ts";
import { buildSearchDocument } from "../../../src/nomologies-search/document.ts";
import { embedTexts, embeddingModel } from "../../../src/nomologies-search/embeddings.ts";
import { buildPrincipleArchitecture } from "../../../src/nomologies-v2/principle-architecture.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
// Model selection: NOMOLOGIES_V2_MODEL pins one model for every stage;
// otherwise the pipeline's elite tiering picks per stage (flagship for legal
// nuance, mini for mechanical work).
const MODEL = (Deno.env.get("NOMOLOGIES_V2_MODEL") || "").trim() || undefined;
const db = createClient(SUPABASE_URL,SERVICE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const workerName = `edge-${crypto.randomUUID().slice(0,8)}`;

type Row = Record<string,any>;
type Task = Row & { id:string; run_id:string; batch_id?:string; bulk_item_id?:string; stage:string; payload:Row; attempt_count:number; max_attempts:number };

const SPECIALIST_KINDS:SpecialistAgentKindV2[]=["identity","facts","procedure","analysis","authorities","outcome"];
const INITIAL_AGENT_STAGES=SPECIALIST_KINDS.map((kind)=>`agent-${kind}`);
const SUCCESS_TASK_STATUSES=new Set(["succeeded","completed","ready"]);
const AGENT_PROGRESS:Record<SpecialistAgentKindV2,number>={identity:26,facts:32,procedure:38,analysis:44,authorities:50,outcome:56};
const AGENT_AUDIT_STAGE:Record<SpecialistAgentKindV2,string>={identity:"identity-classification",facts:"material-facts",procedure:"procedure-grounds",analysis:"judicial-analysis",authorities:"legislation-authorities",outcome:"outcome-orders"};

function json(value:unknown,status=200){return new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});}
function object(value:unknown):Row{return value&&typeof value==="object"&&!Array.isArray(value)?value as Row:{};}
function array(value:unknown):any[]{return Array.isArray(value)?value:[];}
function value<T>(field:any,fallback:T):T{return field?.status==="available"?field.value as T:fallback;}
function cleanFile(value:string):string{return String(value||"").replace(/[^\p{L}\p{N}._-]+/gu,"_").slice(0,120)||"artifact";}
function waitUntil(p:Promise<unknown>){const r=(globalThis as any).EdgeRuntime;if(r?.waitUntil)r.waitUntil(p);else void p;}
function authorized(req:Request):boolean{
  const token=(req.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");
  return Boolean(SERVICE_KEY&&token===SERVICE_KEY);
}
async function uploadJson(path:string,payload:unknown):Promise<string>{
  const {error}=await db.storage.from("nomologies-artifacts").upload(path,new TextEncoder().encode(JSON.stringify(payload)),{contentType:"application/json",upsert:true});
  if(error)throw new Error(`ARTIFACT_UPLOAD_FAILED:${error.message}`);return path;
}
async function downloadJson(path:string):Promise<any>{
  const {data,error}=await db.storage.from("nomologies-artifacts").download(path);
  if(error||!data)throw new Error(`ARTIFACT_DOWNLOAD_FAILED:${error?.message||path}`);
  return JSON.parse(await data.text());
}
async function uploadSource(path:string,content:string,contentType:string):Promise<string>{
  const {error}=await db.storage.from("nomologies-sources").upload(path,new TextEncoder().encode(content),{contentType,upsert:true});
  if(error)throw new Error(`SOURCE_UPLOAD_FAILED:${error.message}`);return path;
}
async function claim():Promise<Task|null>{
  // Specialist extraction may legitimately run longer than an HTTP request.
  // Keep the lease beyond the background execution budget so a second worker
  // cannot reclaim the same task while the first one is still finishing it.
  const {data,error}=await db.schema("nomologies").rpc("claim_pipeline_task",{worker_name:workerName,lease_seconds:360});
  if(error)throw new Error(`TASK_CLAIM_FAILED:${error.message}`);
  const row=Array.isArray(data)?data[0]:data;
  return row?.id?row as Task:null;
}
async function finish(task:Task,result:Row={}){
  const {error}=await db.schema("nomologies").rpc("finish_pipeline_task",{task_id:task.id,task_result:result});
  if(error)throw new Error(`TASK_FINISH_FAILED:${error.message}`);
  // A successful retry is authoritative. Do not leave the prior transient
  // provider error attached to a task that ultimately succeeded.
  await db.schema("nomologies").from("pipeline_tasks").update({last_error_code:"",last_error_message:""}).eq("id",task.id);
}
async function fail(task:Task,error:unknown){
  const message=error instanceof Error?error.message:String(error);
  const code=String((error as {code?:unknown})?.code||message.split(":")[0]||"PIPELINE_ERROR").slice(0,200);
  await db.schema("nomologies").rpc("fail_pipeline_task",{task_id:task.id,error_code:code,error_message:message,retry_delay_seconds:Math.min(300,20*Math.max(1,task.attempt_count))});
  const terminal=task.attempt_count>=task.max_attempts;
  await db.schema("nomologies").from("pipeline_events").insert({run_id:task.run_id,task_id:task.id,batch_id:task.batch_id||null,bulk_item_id:task.bulk_item_id||null,level:terminal?"error":"warning",event_type:terminal?"task_failed":"task_retry_scheduled",message,data:{stage:task.stage,attempt:task.attempt_count,maxAttempts:task.max_attempts,retrying:!terminal}});
  // fail_pipeline_task owns terminal failure state. A retryable provider
  // timeout is an internal attempt, not a failed case, and must not be exposed
  // on the operator's case card while the automatic retry is queued.
  if(!terminal){
    await db.schema("nomologies").from("pipeline_runs").update({status:"running",error_code:"",error_message:"",current_stage:task.stage,completed_at:null,updated_at:new Date().toISOString()}).eq("id",task.run_id);
    if(task.bulk_item_id)await db.schema("nomologies").from("bulk_items").update({status:"processing",last_error_code:"",last_error_message:"",attempt_count:task.attempt_count,current_stage:task.stage,updated_at:new Date().toISOString()}).eq("id",task.bulk_item_id);
  }
}
async function enqueue(task:Task,stage:string,payload:Row={},priority=100,delaySeconds=0){
  const availableAt=new Date(Date.now()+Math.max(0,delaySeconds)*1000).toISOString();
  const {error}=await db.schema("nomologies").from("pipeline_tasks").upsert({run_id:task.run_id,batch_id:task.batch_id||null,bulk_item_id:task.bulk_item_id||null,stage,status:"queued",priority,payload,available_at:availableAt,last_error_code:"",last_error_message:""},{onConflict:"run_id,stage"});
  if(error)throw new Error(`TASK_ENQUEUE_FAILED:${error.message}`);
}
function agentKind(stage:string):SpecialistAgentKindV2{
  const kind=stage.replace(/^(?:agent|repair)-/,"") as SpecialistAgentKindV2;
  if(!SPECIALIST_KINDS.includes(kind))throw new Error(`UNSUPPORTED_AGENT_STAGE:${stage}`);
  return kind;
}
async function recoverRunBarrier(task:Task):Promise<boolean>{
  const {data,error}=await db.schema("nomologies").from("pipeline_tasks").select("stage,status,payload").eq("run_id",task.run_id);
  if(error)throw new Error(`TASK_BARRIER_RECOVERY_FAILED:${error.message}`);
  const rows=array(data);const stages=new Map(rows.map((row:any)=>[String(row.stage),row]));
  if(!stages.has("agents-merge")&&INITIAL_AGENT_STAGES.every((stage)=>SUCCESS_TASK_STATUSES.has(String(stages.get(stage)?.status||"")))){
    await enqueue(task,"agents-merge",{},120);
    await event(task,"agent_barrier_recovered","All six specialist agents succeeded; missing merge task restored",{stages:INITIAL_AGENT_STAGES});
    return true;
  }
  const repairRows=rows.filter((row:any)=>/^repair-(?:identity|facts|procedure|analysis|authorities|outcome)$/.test(String(row.stage)));
  const repairStages=[...new Set(repairRows.map((row:any)=>String(row.stage)))];
  if(repairStages.length&&!stages.has("repair-merge")&&repairStages.every((stage)=>SUCCESS_TASK_STATUSES.has(String(stages.get(stage)?.status||"")))){
    const requestedTargets=array(object(repairRows[0]?.payload).targets).map(String).filter((target)=>SPECIALIST_KINDS.includes(target as SpecialistAgentKindV2));
    const targets=requestedTargets.length?requestedTargets:repairStages.map((stage)=>stage.replace(/^repair-/,""));
    await enqueue(task,"repair-merge",{targets},120);
    await event(task,"repair_barrier_recovered","All targeted repair agents succeeded; missing repair merge task restored",{stages:repairStages,targets});
    return true;
  }
  return false;
}
async function recoverOrphanedBarriers():Promise<number>{
  const {data,error}=await db.schema("nomologies").from("pipeline_runs").select("id,batch_id,bulk_item_id,status,current_stage").in("status",["queued","running"]).order("updated_at",{ascending:false}).limit(25);
  if(error)throw new Error(`BARRIER_RUN_SCAN_FAILED:${error.message}`);
  let recovered=0;
  for(const run of array(data)){
    const context={id:"",run_id:String(run.id),batch_id:run.batch_id||undefined,bulk_item_id:run.bulk_item_id||undefined,stage:String(run.current_stage||""),payload:{},attempt_count:0,max_attempts:0} as Task;
    if(await recoverRunBarrier(context))recovered+=1;
  }
  return recovered;
}
function repairTargets(record:Row):SpecialistAgentKindV2[]{
  const targets=new Set<SpecialistAgentKindV2>();
  for(const conflict of array(record.conflicts)){
    if(!["critical","material"].includes(String(conflict?.severity||"")))continue;
    const path=String(conflict?.fieldPath||"");
    if(path.startsWith("identity.")||path==="identity"||path.startsWith("classification."))targets.add("identity");
    else if(path.startsWith("facts."))targets.add("facts");
    else if(path.startsWith("procedure."))targets.add("procedure");
    else if(path.startsWith("analysis."))targets.add("analysis");
    else if(path.startsWith("authorities."))targets.add("authorities");
    else if(path.startsWith("outcome."))targets.add("outcome");
  }
  return SPECIALIST_KINDS.filter((kind)=>targets.has(kind));
}
function conflictsFor(record:Row,kind:SpecialistAgentKindV2):Row[]{
  return array(record.conflicts).filter((conflict:any)=>{
    const path=String(conflict?.fieldPath||"");
    if(kind==="identity")return path==="identity"||path.startsWith("identity.")||path.startsWith("classification.");
    return path.startsWith(`${kind}.`);
  }).map((conflict:any)=>({
    code:String(conflict?.code||"REVIEW_CONFLICT"),severity:String(conflict?.severity||"material"),
    fieldPath:String(conflict?.fieldPath||""),message:String(conflict?.message||""),
  }));
}
async function runRow(task:Task):Promise<Row>{
  const {data,error}=await db.schema("nomologies").from("pipeline_runs").select("*").eq("id",task.run_id).single();
  if(error)throw new Error(`RUN_READ_FAILED:${error.message}`);return data;
}
async function sourceRow(task:Task):Promise<Row>{
  const run=await runRow(task);
  const {data,error}=await db.schema("nomologies").from("source_documents").select("*").eq("id",run.source_document_id).single();
  if(error)throw new Error(`SOURCE_READ_FAILED:${error.message}`);return data;
}
async function event(task:Task,eventType:string,message:string,data:Row={}){
  await db.schema("nomologies").from("pipeline_events").insert({run_id:task.run_id,task_id:task.id,batch_id:task.batch_id||null,bulk_item_id:task.bulk_item_id||null,level:"info",event_type:eventType,message,data});
}
async function stageUpdate(task:Task,stage:string,progress:number,extra:Row={}){
  await db.schema("nomologies").from("pipeline_runs").update({status:"running",current_stage:stage,error_code:"",error_message:"",completed_at:null,started_at:new Date().toISOString(),...extra}).eq("id",task.run_id);
  // Parallel specialists must never move the operator-facing progress bar
  // backwards when a lower-percentage agent starts after a later one.
  if(task.bulk_item_id)await db.schema("nomologies").from("bulk_items").update({status:"processing",current_stage:stage,progress,last_error_code:"",last_error_message:""}).eq("id",task.bulk_item_id).lte("progress",progress);
}
async function processSource(task:Task){
  await stageUpdate(task,"source",5);
  const run=await runRow(task);const row=await sourceRow(task);const payload=object(task.payload);
  let text=String(payload.cleanText||row.clean_text||"");let html="";let sourceUrl=String(payload.sourceUrl||row.source_url||"");let title=String(payload.sourceTitle||row.source_title||"Uploaded judgment");let sourceDatabase=row.source_database||"uploaded_text";let charset=row.charset||"utf-8";
  if(!text&&row.original_storage_path){const {data,error}=await db.storage.from("nomologies-sources").download(row.original_storage_path);if(error||!data)throw new Error(`SOURCE_DOWNLOAD_FAILED:${error?.message||"missing"}`);text=await data.text();}
  if(sourceUrl){const fetched=await fetchCyLawJudgment(sourceUrl);text=fetched.text;html=fetched.html;title=fetched.sourceTitle||title;sourceUrl=fetched.sourceUrl;sourceDatabase=fetched.sourceDatabase;charset=fetched.charset;}
  const source=await prepareJudgmentSource({text,html,sourceTitle:title,sourceUrl,sourceDatabase,charset,mode:"full"});
  const base=`runs/${task.run_id}`;
  const originalPath=html?await uploadSource(`${base}/original.html`,html,"text/html"):await uploadSource(`${base}/original.txt`,text,"text/plain");
  const normalizedPath=await uploadSource(`${base}/normalized.txt`,source.cleanText,"text/plain");
  const artifactPath=await uploadJson(`${base}/source.json`,source);
  await db.schema("nomologies").from("source_documents").update({source_url:source.sourceUrl,source_title:source.sourceTitle,source_database:source.sourceDatabase,charset:source.charset,language_hint:source.languageHint,original_storage_path:originalPath,normalized_storage_path:normalizedPath,clean_text:source.cleanText.length<=500000?source.cleanText:"",character_count:source.characterCount,paragraph_count:source.paragraphs.length,metadata:{canonicalSourceHash:source.sourceHash,retrievedAt:source.retrievedAt}}).eq("id",row.id);
  // Preserve the immutable reprocess contract and any earlier stage metadata.
  // Replacing stage_state here previously erased reprocess.caseId/autoPublish,
  // which allowed duplicate restarts and prevented automatic republication.
  await db.schema("nomologies").from("pipeline_runs").update({source_artifact_path:artifactPath,current_stage:"sections",stage_state:{...object(run.stage_state),source:{status:"completed",artifactPath,paragraphCount:source.paragraphs.length}}}).eq("id",task.run_id);
  await enqueue(task,"sections",{sourceArtifactPath:artifactPath},100,1);await finish(task,{artifactPath,paragraphCount:source.paragraphs.length});await event(task,"source_completed",title,{paragraphs:source.paragraphs.length});
}
async function processSections(task:Task){
  await stageUpdate(task,"sections",18);const run=await runRow(task);const source=await downloadJson(run.source_artifact_path);
  const sections=await buildSectionMap(source,{model:MODEL});const path=await uploadJson(`runs/${task.run_id}/sections.json`,sections);
  await db.schema("nomologies").from("pipeline_runs").update({section_artifact_path:path,current_stage:"agents",stage_state:{...object(run.stage_state),sections:{status:"completed",artifactPath:path,spanCount:sections.map.spans.length},orchestration:{version:"elite-hybrid-v1",specialists:SPECIALIST_KINDS,wholeJudgmentSynthesis:true,deterministicBaseline:true,repairPasses:1}}}).eq("id",task.run_id);
  for(let i=0;i<SPECIALIST_KINDS.length;i+=1){await enqueue(task,`agent-${SPECIALIST_KINDS[i]}`,{},100-i);}
  await finish(task,{artifactPath:path,spanCount:sections.map.spans.length});
  await event(task,"sections_completed","Section map completed; six durable specialists queued",{spans:sections.map.spans.length,specialists:SPECIALIST_KINDS});
}
function rawForKind(specialists:Row,kind:SpecialistAgentKindV2):Row{
  const raw=object(specialists.raw);
  if(kind==="facts")return {facts:object(object(raw.factsProcedure).facts)};
  if(kind==="procedure")return {procedure:object(object(raw.factsProcedure).procedure)};
  return object(raw[kind]);
}
async function processLegacySpecialists(task:Task){
  await stageUpdate(task,"agents",22);
  for(let i=0;i<SPECIALIST_KINDS.length;i+=1){await enqueue(task,`agent-${SPECIALIST_KINDS[i]}`,{},100-i);}
  await finish(task,{migratedTo:"multi-agent-v1"});
  await event(task,"specialists_migrated","Legacy specialist stage expanded into durable agent tasks",{specialists:SPECIALIST_KINDS});
}
async function processAgentTask(task:Task,repair:boolean){
  const kind=agentKind(task.stage);const run=await runRow(task);
  await stageUpdate(task,repair?`repair-${kind}`:`agent-${kind}`,repair?72+SPECIALIST_KINDS.indexOf(kind)*2:AGENT_PROGRESS[kind]);
  const source=await downloadJson(run.source_artifact_path);const sections=await downloadJson(run.section_artifact_path);
  let repairBrief:any=undefined;
  if(repair){
    const initialRecord=await downloadJson(`runs/${task.run_id}/verification/initial-record.json`);
    const initialSpecialists=await downloadJson(run.specialist_artifact_path);
    repairBrief={previousOutput:rawForKind(initialSpecialists,kind),conflicts:conflictsFor(initialRecord,kind)};
  }
  const result=await runSpecialistAgent(kind,source,sections.map,{model:MODEL,repair:repairBrief});
  const path=await uploadJson(`runs/${task.run_id}/${repair?"repairs":"agents"}/${kind}.json`,result);
  await finish(task,{artifactPath:path,kind,repair});
  // Mark the current agent successful before testing the barrier. This avoids
  // the two-last-agents race where each could observe the other as running.
  await recoverRunBarrier(task);
  await event(task,repair?"repair_agent_completed":"specialist_agent_completed",`${kind} agent completed`,{kind,artifactPath:path});
}
async function processAgentMerge(task:Task,repair:boolean){
  await stageUpdate(task,repair?"repair-merge":"agents-merge",repair?83:59);
  const run=await runRow(task);const source=await downloadJson(run.source_artifact_path);const sections=await downloadJson(run.section_artifact_path);
  const targets=new Set<SpecialistAgentKindV2>(array(object(task.payload).targets).map(String).filter((value)=>SPECIALIST_KINDS.includes(value as SpecialistAgentKindV2)) as SpecialistAgentKindV2[]);
  const initial=repair?await downloadJson(run.specialist_artifact_path):null;
  const runs:SpecialistAgentRunV2[]=[];const repairAudits:any[]=[];
  for(const kind of SPECIALIST_KINDS){
    if(repair&&!targets.has(kind)){
      const audit=array(initial.audits).find((item:any)=>String(item.stage||"")===AGENT_AUDIT_STAGE[kind]);
      if(!audit)throw new Error(`SPECIALIST_AUDIT_MISSING:${kind}`);
      runs.push({kind,raw:rawForKind(initial,kind),audit});
      continue;
    }
    const envelope=await downloadJson(`runs/${task.run_id}/${repair?"repairs":"agents"}/${kind}.json`) as SpecialistAgentRunV2;
    runs.push(envelope);if(repair)repairAudits.push(envelope.audit);
  }
  const combined=combineSpecialistAgentResults(source,sections.map,runs);
  const baseline=applyDeterministicBaseline(combined,source,sections.map);
  const specialists=baseline.specialists;
  if(repair)specialists.audits=[...array(initial.audits),...repairAudits];
  const path=await uploadJson(`runs/${task.run_id}/${repair?"specialists-repaired":"specialists"}.json`,specialists);
  const nextStage=repair?"verify-final":"whole-synthesis";
  await db.schema("nomologies").from("pipeline_runs").update({specialist_artifact_path:path,current_stage:nextStage,stage_state:{...object(run.stage_state),[repair?"repair":"specialists"]:{status:"completed",artifactPath:path,targets:[...targets],deterministicFindings:baseline.findings.length}}}).eq("id",task.run_id);
  await enqueue(task,nextStage,repair?{}:{deterministicFindings:baseline.findings},130,1);await finish(task,{artifactPath:path,repair,targets:[...targets],deterministicFindings:baseline.findings.length});
  await event(task,repair?"repair_merge_completed":"specialists_completed",repair?"Repaired specialist record assembled":"Six specialist records assembled",{artifactPath:path,targets:[...targets]});
}
async function processWholeSynthesis(task:Task){
  await stageUpdate(task,"whole-synthesis",61);const run=await runRow(task);
  const source=await downloadJson(run.source_artifact_path);const sections=await downloadJson(run.section_artifact_path);const current=await downloadJson(run.specialist_artifact_path);
  const deterministicFindings=array(object(task.payload).deterministicFindings);
  try{
    const synthesized=await runWholeJudgmentSynthesis(source,sections.map,current,deterministicFindings,{model:MODEL});
    const baseline=applyDeterministicBaseline(synthesized,source,sections.map);
    const path=await uploadJson(`runs/${task.run_id}/specialists-elite.json`,baseline.specialists);
    await db.schema("nomologies").from("pipeline_runs").update({specialist_artifact_path:path,current_stage:"verify-initial",stage_state:{...object(run.stage_state),wholeSynthesis:{status:"completed",artifactPath:path,deterministicFindings:baseline.findings.length}}}).eq("id",task.run_id);
    await enqueue(task,"verify-initial",{},135,1);await finish(task,{artifactPath:path,synthesized:true,deterministicFindings:baseline.findings.length});
    await event(task,"whole_synthesis_completed","Whole-judgment legal synthesis reconciled the six specialists",{artifactPath:path,deterministicFindings:baseline.findings.length});
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    await db.schema("nomologies").from("pipeline_runs").update({current_stage:"verify-initial",stage_state:{...object(run.stage_state),wholeSynthesis:{status:"skipped",reason:message.slice(0,300),fallbackArtifactPath:run.specialist_artifact_path}}}).eq("id",task.run_id);
    await enqueue(task,"verify-initial",{},135,1);await finish(task,{artifactPath:run.specialist_artifact_path,synthesized:false,fallback:true});
    await event(task,"whole_synthesis_fallback","Whole-judgment synthesis was unavailable; deterministic and specialist results preserved",{reason:message.slice(0,200)});
  }
}
async function processVerification(task:Task,finalPass:boolean){
  await stageUpdate(task,finalPass?"verify-final":"verify-initial",finalPass?87:64);const run=await runRow(task);
  const source=await downloadJson(run.source_artifact_path);const sections=await downloadJson(run.section_artifact_path);const specialists=await downloadJson(run.specialist_artifact_path);
  let priorStages:any[]=[];
  if(finalPass){
    const initialRecord=await downloadJson(`runs/${task.run_id}/verification/initial-record.json`);
    priorStages=array(initialRecord.stages).filter((stage:any)=>stage?.stage==="independent-verification");
  }
  const finalized=await finalizeNomologiesRecordV2(source,sections.map,specialists,{runId:task.run_id,createdAt:run.created_at,priorStages,model:MODEL,reviewPass:finalPass?"final":"initial"});
  const recordPath=await uploadJson(finalPass?`runs/${task.run_id}/record.json`:`runs/${task.run_id}/verification/initial-record.json`,finalized.record);
  const reviewerPath=await uploadJson(finalPass?`runs/${task.run_id}/reviewer.json`:`runs/${task.run_id}/verification/initial-reviewer.json`,finalized.reviewer);
  if(!finalPass){
    const targets=repairTargets(finalized.record);
    await db.schema("nomologies").from("pipeline_runs").update({current_stage:targets.length?"repair":"verify-final",stage_state:{...object(run.stage_state),initialVerification:{status:"completed",recordPath,reviewerPath,readinessScore:finalized.record.readinessScore,repairTargets:targets}}}).eq("id",task.run_id);
    if(targets.length){for(let i=0;i<targets.length;i+=1)await enqueue(task,`repair-${targets[i]}`,{targets},150-i);}
    else await enqueue(task,"verify-final",{},150,1);
    await finish(task,{recordPath,reviewerPath,readinessScore:finalized.record.readinessScore,repairTargets:targets});
    await event(task,"initial_verification_completed","Independent verifier completed; targeted repair scheduled",{readinessScore:finalized.record.readinessScore,repairTargets:targets});
    return;
  }
  const critical=finalized.record.conflicts.filter((x:any)=>x.severity==="critical").length;const material=finalized.record.conflicts.filter((x:any)=>x.severity==="material").length;const minor=finalized.record.conflicts.filter((x:any)=>x.severity==="minor").length;
  await db.schema("nomologies").from("pipeline_runs").update({reviewer_artifact_path:reviewerPath,record_artifact_path:recordPath,readiness_score:finalized.record.readinessScore,strict_ready:finalized.record.strictReady,human_review_required:true,critical_conflicts:critical,material_conflicts:material,minor_conflicts:minor,current_stage:"persist",stage_state:{...object(run.stage_state),finalVerification:{status:"completed",recordPath,reviewerPath,readinessScore:finalized.record.readinessScore}}}).eq("id",task.run_id);
  await enqueue(task,"persist",{},160,1);await finish(task,{recordPath,reviewerPath,readinessScore:finalized.record.readinessScore});
  await event(task,"final_verification_completed","Final legal verification completed",{readinessScore:finalized.record.readinessScore,strictReady:finalized.record.strictReady,critical,material,minor});
}
const GREEK_MONTHS:Record<string,string>={ιανουαριου:"01",φεβρουαριου:"02",μαρτιου:"03",απριλιου:"04",μαιου:"05",ιουνιου:"06",ιουλιου:"07",αυγουστου:"08",σεπτεμβριου:"09",οκτωβριου:"10",νοεμβριου:"11",δεκεμβριου:"12"};
function fold(s:string){return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");}
function dateValue(raw:string):string|null{const iso=raw.match(/\b(20\d{2}|19\d{2})-(\d{2})-(\d{2})\b/);if(iso)return `${iso[1]}-${iso[2]}-${iso[3]}`;const m=fold(raw).match(/\b(\d{1,2})\s+([α-ω]+)[,\s]+(20\d{2}|19\d{2})\b/u);if(m&&GREEK_MONTHS[m[2]])return `${m[3]}-${GREEK_MONTHS[m[2]]}-${m[1].padStart(2,"0")}`;return null;}
async function processPersist(task:Task){
  await stageUpdate(task,"persist",86);const run=await runRow(task);const record=await downloadJson(run.record_artifact_path);const reviewer=await downloadJson(run.reviewer_artifact_path);const source=record.source;
  const casePayload={source_hash:source.sourceHash,publication_status:"review",case_name:value(record.identity.caseName,source.sourceTitle),short_name:value(record.identity.shortName,""),citation:value(record.identity.citation,""),ecli:value(record.identity.ecli,""),case_number:value(record.identity.caseNumber,""),docket:value(record.identity.docket,""),decision_date:dateValue(value(record.identity.decisionDate,"")),decision_date_text:value(record.identity.decisionDate,""),decision_year:Number((value(record.identity.decisionDate,"").match(/(19|20)\d{2}/)||[])[0])||null,court:value(record.identity.court,""),court_level:value(record.classification.courtLevel,""),jurisdiction:value(record.identity.jurisdiction,"Cyprus"),case_family:value(record.classification.caseFamily,""),primary_legal_area:value(record.classification.primaryLegalArea,""),legal_areas:value(record.classification.legalAreas,[]),proceeding_type:value(record.classification.proceedingType,""),procedural_posture:value(record.classification.proceduralPosture,""),outcome:value(record.outcome.overallOutcome,""),judges:value(record.identity.judges,[]).map((j:any)=>j.name),authoring_judges:value(record.identity.authoringJudges,[]),source_url:source.sourceUrl,readiness_score:record.readinessScore,strict_ready:record.strictReady,human_review_required:true};
  const reprocess=object(object(run.stage_state).reprocess);
  const reprocessCaseId=String(reprocess.caseId||"");
  const preservePublished=Boolean(reprocessCaseId&&reprocess.previousPublicationStatus==="published"&&reprocess.autoPublish!==true);
  let caseRow:any=null;
  if(preservePublished){
    const {data,error}=await db.schema("nomologies").from("cases").select("id,current_version_id,publication_status").eq("id",reprocessCaseId).maybeSingle();
    if(error)throw new Error(`CASE_READ_FAILED:${error.message}`);
    if(!data)throw new Error("CASE_READ_FAILED:Published case no longer exists");
    caseRow=data;
  }else{
    const {data,error}=await db.schema("nomologies").from("cases").upsert(casePayload,{onConflict:"source_hash"}).select("id,current_version_id,publication_status").single();
    if(error)throw new Error(`CASE_UPSERT_FAILED:${error.message}`);
    caseRow=data;
  }
  const {data:versions}=await db.schema("nomologies").from("case_versions").select("version_no").eq("case_id",caseRow.id).order("version_no",{ascending:false}).limit(1);const versionNo=(versions?.[0]?.version_no||0)+1;
  const {data:version,error:versionError}=await db.schema("nomologies").from("case_versions").insert({case_id:caseRow.id,run_id:task.run_id,version_no:versionNo,schema_version:record.schemaVersion,canonical_record:record,reviewer_record:reviewer,record_artifact_path:run.record_artifact_path,readiness_score:record.readinessScore,strict_ready:record.strictReady,human_review_required:true,conflict_summary:{conflicts:record.conflicts,reviewFlags:record.reviewFlags}}).select("id").single();if(versionError)throw new Error(`CASE_VERSION_FAILED:${versionError.message}`);
  if(preservePublished){
    const {error}=await db.schema("nomologies").from("cases").update({pending_version_id:version.id,pending_run_id:task.run_id,pending_readiness_score:record.readinessScore,pending_strict_ready:record.strictReady,pending_created_at:new Date().toISOString(),human_review_required:true}).eq("id",caseRow.id);
    if(error)throw new Error(`CASE_PENDING_VERSION_FAILED:${error.message}`);
  }else{
    const {error}=await db.schema("nomologies").from("cases").update({current_version_id:version.id,pending_version_id:null,pending_run_id:null,pending_readiness_score:null,pending_strict_ready:null,pending_created_at:null,...casePayload}).eq("id",caseRow.id);
    if(error)throw new Error(`CASE_VERSION_ACTIVATE_FAILED:${error.message}`);
  }
  const paragraphs=array(source.paragraphs).map((p:any)=>({case_version_id:version.id,paragraph_id:p.id,ordinal:p.ordinal,paragraph_text:p.text,start_offset:p.startOffset||0,end_offset:p.endOffset||0,relative_position:p.relativePosition||0,formatting:p.formatting||{}}));
  const sections=array(record.sectionMap?.spans).map((s:any)=>({case_version_id:version.id,section_id:s.id,start_paragraph_id:s.startParagraphId,end_paragraph_id:s.endParagraphId,section_type:s.sectionType,speaker_role:s.speakerRole,heading:s.heading||"",is_quoted_material:Boolean(s.isQuotedMaterial),quoted_source_type:s.quotedSourceType||"none",confidence:s.confidence||0,rationale:s.rationale||""}));
  const evidence=array(record.allEvidence).map((e:any)=>({case_version_id:version.id,evidence_id:e.id,field_path:array(e.supports)[0]||"",paragraph_ids:e.paragraphIds||[],quote:e.quote,section_type:e.sectionType||"",speaker_role:e.speakerRole||"",supports:e.supports||[],exact_match:Boolean(e.exactMatch)}));
  for(let i=0;i<paragraphs.length;i+=500){const {error}=await db.schema("nomologies").from("case_paragraphs").insert(paragraphs.slice(i,i+500));if(error)throw new Error(`PARAGRAPH_PERSIST_FAILED:${error.message}`);}
  if(sections.length){const {error}=await db.schema("nomologies").from("case_sections").insert(sections);if(error)throw new Error(`SECTION_PERSIST_FAILED:${error.message}`);}
  for(let i=0;i<evidence.length;i+=500){const {error}=await db.schema("nomologies").from("evidence_anchors").insert(evidence.slice(i,i+500));if(error)throw new Error(`EVIDENCE_PERSIST_FAILED:${error.message}`);}
  await db.schema("nomologies").from("pipeline_runs").update({status:record.strictReady?"strict_ready":"review",current_stage:"review",completed_at:new Date().toISOString()}).eq("id",task.run_id);
  if(task.bulk_item_id)await db.schema("nomologies").from("bulk_items").update({case_id:caseRow.id,status:record.strictReady?"strict_ready":"review",current_stage:"review",progress:100,result_summary:{caseName:casePayload.case_name,caseNumber:casePayload.case_number,readinessScore:record.readinessScore,strictReady:record.strictReady}}).eq("id",task.bulk_item_id);
  if(task.batch_id)await db.schema("nomologies").from("bulk_batches").update({status:"reviewing"}).eq("id",task.batch_id);
  await finish(task,{caseId:caseRow.id,caseVersionId:version.id,pendingReview:preservePublished,readinessScore:record.readinessScore,strictReady:record.strictReady});await event(task,"record_persisted",preservePublished?"Candidate case version persisted for manual review":"Canonical case version persisted",{caseId:caseRow.id,caseVersionId:version.id,pendingReview:preservePublished});
}
async function processEmbeddings(task:Task){
  await stageUpdate(task,"embeddings",92);const payload=object(task.payload);const caseId=String(payload.caseId||"");const versionId=String(payload.caseVersionId||"");
  const {data:version,error}=await db.schema("nomologies").from("case_versions").select("canonical_record").eq("id",versionId).single();if(error)throw new Error(`VERSION_READ_FAILED:${error.message}`);const record=object(version.canonical_record);if(!object(record.principleArchitecture).version&&object(record.analysis).legalIssues){record.principleArchitecture=buildPrincipleArchitecture(record.analysis as any);const {error:architectureError}=await db.schema("nomologies").from("case_versions").update({canonical_record:record}).eq("id",versionId);if(architectureError)throw new Error(`PRINCIPLE_ARCHITECTURE_PERSIST_FAILED:${architectureError.message}`);}const doc=buildSearchDocument(record as any);
  const vectors=await embedTexts(doc.fields.map((f:any)=>f.text),{dimensions:1024});
  const searchDoc={case_id:caseId,case_version_id:versionId,run_id:task.run_id,source_hash:doc.sourceHash,source_url:doc.sourceUrl,title:doc.title,short_title:doc.shortTitle,citation:doc.citation,case_number:doc.caseNumber,ecli:value(record.identity.ecli,""),decision_date:dateValue(doc.decisionDate),decision_year:doc.year,court:doc.court,court_level:doc.facets.courtLevel,case_family:doc.facets.caseFamily,primary_legal_area:doc.facets.primaryLegalArea,legal_areas:doc.facets.legalAreas,proceeding_type:doc.facets.proceedingType,procedural_posture:doc.facets.proceduralPosture,outcome:doc.outcome,judges:doc.judges,authoring_judges:doc.authoringJudges,aliases:doc.aliases,exact_terms:doc.exactTerms,law_ids:doc.facets.lawIds,provision_keys:doc.facets.provisionKeys,authority_treatments:doc.facets.authorityTreatments,authority_contexts:doc.facets.authorityContexts,principle_ids:doc.facets.principleIds,precedential_score:doc.authority.score,precedential_tier:doc.authority.tier,precedential_factors:doc.authority.factors,readiness_score:doc.quality.readinessScore,strict_ready:doc.quality.strictReady,human_review_required:doc.quality.humanReviewRequired,critical_conflicts:doc.quality.criticalConflicts,material_conflicts:doc.quality.materialConflicts,evidence_count:doc.quality.evidenceCount,canonical_record:record,indexed_at:new Date().toISOString()};
  const {error:docError}=await db.schema("nomologies").from("case_search_documents").upsert(searchDoc,{onConflict:"case_id"});if(docError)throw new Error(`SEARCH_DOCUMENT_FAILED:${docError.message}`);
  await db.schema("nomologies").from("case_search_fields").delete().eq("case_id",caseId);
  const fields=doc.fields.map((f:any,i:number)=>({case_id:caseId,field_name:f.name,field_weight:f.weight,field_text:f.text,paragraph_ids:f.paragraphIds,embedding:vectors[i],embedding_model:embeddingModel(),embedding_updated_at:new Date().toISOString()}));if(fields.length){const {error}=await db.schema("nomologies").from("case_search_fields").insert(fields);if(error)throw new Error(`SEARCH_FIELDS_FAILED:${error.message}`);}
  await db.schema("nomologies").from("case_smart_tags").delete().eq("case_id",caseId);
  for(const tag of doc.smartTags){
    const {data:existing,error:lookupError}=await db.schema("nomologies").from("smart_tags").select("id").eq("kind",tag.kind).eq("normalized",tag.normalized).maybeSingle();if(lookupError)throw new Error(`SMART_TAG_FAILED:${lookupError.message}`);
    let tagId=existing?.id;
    if(tagId){const {error:updateError}=await db.schema("nomologies").from("smart_tags").update({label:tag.label,aliases:tag.aliases}).eq("id",tagId);if(updateError)throw new Error(`SMART_TAG_FAILED:${updateError.message}`);}
    else{const {data:created,error:createError}=await db.schema("nomologies").from("smart_tags").insert({tag_key:tag.id,label:tag.label,normalized:tag.normalized,kind:tag.kind,aliases:tag.aliases}).select("id").single();if(createError)throw new Error(`SMART_TAG_FAILED:${createError.message}`);tagId=created.id;}
    await db.schema("nomologies").from("case_smart_tags").upsert({case_id:caseId,tag_id:tagId,confidence:tag.confidence,boost:tag.boost,evidence_paragraph_ids:tag.evidenceParagraphIds,source_field:tag.sourceField},{onConflict:"case_id,tag_id"});
  }
  await db.schema("nomologies").from("provision_links").delete().eq("case_id",caseId);const legislation:any[]=value<any[]>(record.authorities.legislation,[]);for(const instrument of legislation){for(const provision of instrument.provisions||[]){await db.schema("nomologies").from("provision_links").upsert({case_id:caseId,law_id:instrument.lawId||instrument.lawLabel||"unknown",law_label:instrument.lawLabel||instrument.instrumentName||"",provision_key:provision.normalized||provision.display,instrument_role:instrument.role||"unknown",application:provision.application||"unknown",is_primary:Boolean(instrument.primary),display:provision.display||provision.normalized||"",proposition:instrument.proposition||"",evidence_paragraph_ids:record.authorities.legislation.evidence.flatMap((e:any)=>e.paragraphIds||[])},{onConflict:"case_id,law_id,provision_key"});}}
  await db.schema("nomologies").from("principle_assertions").delete().eq("case_id",caseId);const principleNodes:any[]=array(record.principleArchitecture?.nodes);if(principleNodes.length){const assertions=principleNodes.map((node:any)=>({case_id:caseId,node_id:node.id,principle_id:(array(node.conceptIds)[0]||node.id),layer:node.layer,principle_type:node.principleType,centrality:node.centrality,text:node.text,concept_ids:node.conceptIds||[],evidence_paragraph_ids:node.evidenceParagraphIds||[],source_field:node.sourceField||"",confidence:Number(node.confidence||0),conditions:node.conditions||[],exceptions:node.exceptions||[],application_to_facts:node.applicationToFacts||""}));const {error}=await db.schema("nomologies").from("principle_assertions").insert(assertions);if(error)throw new Error(`PRINCIPLE_ASSERTIONS_FAILED:${error.message}`);}
  await db.schema("nomologies").from("authority_edges").delete().eq("source_case_id",caseId);const authorities:any[]=value<any[]>(record.authorities.authorities,[]).filter((authority:any)=>(authority.sourceType||"decision")==="decision");for(const authority of authorities){const key=authority.ecli||authority.citation||authority.name;await db.schema("nomologies").from("authority_edges").upsert({source_case_id:caseId,cited_case_key:key,cited_name:authority.name,cited_citation:authority.citation||"",cited_ecli:authority.ecli||"",treatment:authority.treatment||"unknown",citation_context:authority.citationContext||"unknown",legal_point:authority.legalPoint||"",evidence_paragraph_ids:record.authorities.authorities.evidence.flatMap((e:any)=>e.paragraphIds||[])},{onConflict:"source_case_id,cited_case_key,treatment,citation_context"});}
  const {error:authorityMetricError}=await db.schema("nomologies").rpc("refresh_authority_metrics");if(authorityMetricError)throw new Error(`AUTHORITY_METRICS_FAILED:${authorityMetricError.message}`);
  const {data:caseRow}=await db.schema("nomologies").from("cases").select("publication_status").eq("id",caseId).single();
  const searchablePublished=caseRow?.publication_status==="published"&&Boolean(payload.publish);
  if(task.bulk_item_id)await db.schema("nomologies").from("bulk_items").update({status:searchablePublished?"published":"strict_ready",current_stage:searchablePublished?"publish":"review",progress:100,last_error_code:"",last_error_message:""}).eq("id",task.bulk_item_id);
  await db.schema("nomologies").from("pipeline_runs").update({status:searchablePublished?"published":"strict_ready",current_stage:searchablePublished?"publish":"embeddings",completed_at:new Date().toISOString()}).eq("id",task.run_id);
  await finish(task,{caseId,indexed:true,fields:fields.length,tags:doc.smartTags.length,principles:principleNodes.length});await event(task,"search_index_completed","Global lexical, principle and vector index completed",{caseId,fields:fields.length,tags:doc.smartTags.length,principles:principleNodes.length});
}
async function processTask(task:Task){
  await event(task,"task_started",`Stage ${task.stage} started`,{attempt:task.attempt_count});
  if(task.stage==="source")return processSource(task);
  if(task.stage==="sections")return processSections(task);
  if(task.stage==="specialists")return processLegacySpecialists(task);
  if(task.stage.startsWith("agent-"))return processAgentTask(task,false);
  if(task.stage==="agents-merge")return processAgentMerge(task,false);
  if(task.stage==="whole-synthesis")return processWholeSynthesis(task);
  if(task.stage==="verify-initial"||task.stage==="review")return processVerification(task,false);
  if(task.stage.startsWith("repair-")&&task.stage!=="repair-merge")return processAgentTask(task,true);
  if(task.stage==="repair-merge")return processAgentMerge(task,true);
  if(task.stage==="verify-final")return processVerification(task,true);
  if(task.stage==="persist")return processPersist(task);
  if(task.stage==="embeddings"||task.stage==="reindex")return processEmbeddings(task);
  throw new Error(`UNSUPPORTED_STAGE:${task.stage}`);
}
async function invokeNext(){await fetch(`${SUPABASE_URL}/functions/v1/nomologies-worker`,{method:"POST",headers:{Authorization:`Bearer ${SERVICE_KEY}`,"Content-Type":"application/json"},body:'{"action":"claim"}'}).catch(()=>undefined);}

Deno.serve(async(req:Request)=>{
  if(!authorized(req))return json({ok:false,code:"UNAUTHORIZED"},401);
  try{
    let task=await claim();
    if(!task){
      const recovered=await recoverOrphanedBarriers();
      if(recovered)task=await claim();
    }
    if(!task)return json({ok:true,status:"idle",worker:workerName});
    const work=(async()=>{
      try{await processTask(task);}
      catch(error){console.error(error);await fail(task,error);}
      finally{await invokeNext();}
    })();
    waitUntil(work);
    return json({ok:true,status:"accepted",taskId:task.id,runId:task.run_id,stage:task.stage},202);
  }catch(error){console.error(error);return json({ok:false,code:"WORKER_ERROR",message:error instanceof Error?error.message:String(error)},500);}
});
