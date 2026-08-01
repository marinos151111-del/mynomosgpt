import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { fetchCyLawJudgment } from "../../../src/nomologies-v2/cylaw.ts";
import { prepareJudgmentSource } from "../../../src/nomologies-v2/source.ts";
import { buildSectionMap } from "../../../src/nomologies-v2/sections.ts";
import { runSpecialistAgents } from "../../../src/nomologies-v2/agents.ts";
import { finalizeNomologiesRecordV2 } from "../../../src/nomologies-v2/staged-finalize.ts";
import { buildSearchDocument } from "../../../src/nomologies-search/document.ts";
import { embedTexts, embeddingModel } from "../../../src/nomologies-search/embeddings.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const MODEL = Deno.env.get("NOMOLOGIES_V2_MODEL") || undefined;
const db = createClient(SUPABASE_URL,SERVICE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const workerName = `edge-${crypto.randomUUID().slice(0,8)}`;

type Row = Record<string,any>;
type Task = Row & { id:string; run_id:string; batch_id?:string; bulk_item_id?:string; stage:string; payload:Row; attempt_count:number; max_attempts:number };

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
  const {data,error}=await db.schema("nomologies").rpc("claim_pipeline_task",{worker_name:workerName,lease_seconds:140});
  if(error)throw new Error(`TASK_CLAIM_FAILED:${error.message}`);
  const row=Array.isArray(data)?data[0]:data;
  return row?.id?row as Task:null;
}
async function finish(task:Task,result:Row={}){
  const {error}=await db.schema("nomologies").rpc("finish_pipeline_task",{task_id:task.id,task_result:result});
  if(error)throw new Error(`TASK_FINISH_FAILED:${error.message}`);
}
async function fail(task:Task,error:unknown){
  const message=error instanceof Error?error.message:String(error);
  await db.schema("nomologies").rpc("fail_pipeline_task",{task_id:task.id,error_code:message.split(":")[0].slice(0,200),error_message:message,retry_delay_seconds:Math.min(300,20*Math.max(1,task.attempt_count))});
  await db.schema("nomologies").from("pipeline_events").insert({run_id:task.run_id,task_id:task.id,batch_id:task.batch_id||null,bulk_item_id:task.bulk_item_id||null,level:"error",event_type:"task_failed",message,data:{stage:task.stage,attempt:task.attempt_count}});
  await db.schema("nomologies").from("pipeline_runs").update({error_code:message.split(":")[0].slice(0,200),error_message:message,current_stage:task.stage,updated_at:new Date().toISOString()}).eq("id",task.run_id);
  if(task.bulk_item_id)await db.schema("nomologies").from("bulk_items").update({last_error_code:message.split(":")[0].slice(0,200),last_error_message:message,attempt_count:task.attempt_count,current_stage:task.stage,updated_at:new Date().toISOString()}).eq("id",task.bulk_item_id);
}
async function enqueue(task:Task,stage:string,payload:Row={},priority=100){
  const {error}=await db.schema("nomologies").from("pipeline_tasks").upsert({run_id:task.run_id,batch_id:task.batch_id||null,bulk_item_id:task.bulk_item_id||null,stage,status:"queued",priority,payload,available_at:new Date().toISOString(),last_error_code:"",last_error_message:""},{onConflict:"run_id,stage"});
  if(error)throw new Error(`TASK_ENQUEUE_FAILED:${error.message}`);
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
  await db.schema("nomologies").from("pipeline_runs").update({status:"running",current_stage:stage,started_at:new Date().toISOString(),...extra}).eq("id",task.run_id);
  if(task.bulk_item_id)await db.schema("nomologies").from("bulk_items").update({status:"processing",current_stage:stage,progress}).eq("id",task.bulk_item_id);
}
async function processSource(task:Task){
  await stageUpdate(task,"source",5);
  const row=await sourceRow(task);const payload=object(task.payload);
  let text=String(payload.cleanText||row.clean_text||"");let html="";let sourceUrl=String(payload.sourceUrl||row.source_url||"");let title=String(payload.sourceTitle||row.source_title||"Uploaded judgment");let sourceDatabase=row.source_database||"uploaded_text";let charset=row.charset||"utf-8";
  if(!text&&row.original_storage_path){const {data,error}=await db.storage.from("nomologies-sources").download(row.original_storage_path);if(error||!data)throw new Error(`SOURCE_DOWNLOAD_FAILED:${error?.message||"missing"}`);text=await data.text();}
  if(sourceUrl){const fetched=await fetchCyLawJudgment(sourceUrl);text=fetched.text;html=fetched.html;title=fetched.sourceTitle||title;sourceUrl=fetched.sourceUrl;sourceDatabase=fetched.sourceDatabase;charset=fetched.charset;}
  const source=await prepareJudgmentSource({text,html,sourceTitle:title,sourceUrl,sourceDatabase,charset,mode:"full"});
  const base=`runs/${task.run_id}`;
  const originalPath=html?await uploadSource(`${base}/original.html`,html,"text/html"):await uploadSource(`${base}/original.txt`,text,"text/plain");
  const normalizedPath=await uploadSource(`${base}/normalized.txt`,source.cleanText,"text/plain");
  const artifactPath=await uploadJson(`${base}/source.json`,source);
  await db.schema("nomologies").from("source_documents").update({source_url:source.sourceUrl,source_title:source.sourceTitle,source_database:source.sourceDatabase,charset:source.charset,language_hint:source.languageHint,original_storage_path:originalPath,normalized_storage_path:normalizedPath,clean_text:source.cleanText.length<=500000?source.cleanText:"",character_count:source.characterCount,paragraph_count:source.paragraphs.length,metadata:{canonicalSourceHash:source.sourceHash,retrievedAt:source.retrievedAt}}).eq("id",row.id);
  await db.schema("nomologies").from("pipeline_runs").update({source_artifact_path:artifactPath,current_stage:"sections",stage_state:{source:{status:"completed",artifactPath,paragraphCount:source.paragraphs.length}}}).eq("id",task.run_id);
  await finish(task,{artifactPath,paragraphCount:source.paragraphs.length});await enqueue(task,"sections",{sourceArtifactPath:artifactPath});await event(task,"source_completed",title,{paragraphs:source.paragraphs.length});
}
async function processSections(task:Task){
  await stageUpdate(task,"sections",18);const run=await runRow(task);const source=await downloadJson(run.source_artifact_path);
  const sections=await buildSectionMap(source,{model:MODEL});const path=await uploadJson(`runs/${task.run_id}/sections.json`,sections);
  await db.schema("nomologies").from("pipeline_runs").update({section_artifact_path:path,current_stage:"specialists",stage_state:{...object(run.stage_state),sections:{status:"completed",artifactPath:path,spanCount:sections.map.spans.length}}}).eq("id",task.run_id);
  await finish(task,{artifactPath:path,spanCount:sections.map.spans.length});await enqueue(task,"specialists",{sourceArtifactPath:run.source_artifact_path,sectionArtifactPath:path});await event(task,"sections_completed","Section map completed",{spans:sections.map.spans.length});
}
async function processSpecialists(task:Task){
  await stageUpdate(task,"specialists",42);const run=await runRow(task);const source=await downloadJson(run.source_artifact_path);const sections=await downloadJson(run.section_artifact_path);
  const specialists=await runSpecialistAgents(source,sections.map,{model:MODEL});const path=await uploadJson(`runs/${task.run_id}/specialists.json`,specialists);
  await db.schema("nomologies").from("pipeline_runs").update({specialist_artifact_path:path,current_stage:"review",stage_state:{...object(run.stage_state),specialists:{status:"completed",artifactPath:path}}}).eq("id",task.run_id);
  await finish(task,{artifactPath:path});await enqueue(task,"review",{});await event(task,"specialists_completed","Specialist extraction completed");
}
async function processReview(task:Task){
  await stageUpdate(task,"review",70);const run=await runRow(task);const source=await downloadJson(run.source_artifact_path);const sections=await downloadJson(run.section_artifact_path);const specialists=await downloadJson(run.specialist_artifact_path);
  const finalized=await finalizeNomologiesRecordV2(source,sections.map,specialists,{runId:task.run_id,createdAt:run.created_at,priorStages:[],model:MODEL});
  const recordPath=await uploadJson(`runs/${task.run_id}/record.json`,finalized.record);const reviewerPath=await uploadJson(`runs/${task.run_id}/reviewer.json`,finalized.reviewer);
  const critical=finalized.record.conflicts.filter((x:any)=>x.severity==="critical").length;const material=finalized.record.conflicts.filter((x:any)=>x.severity==="material").length;const minor=finalized.record.conflicts.filter((x:any)=>x.severity==="minor").length;
  await db.schema("nomologies").from("pipeline_runs").update({reviewer_artifact_path:reviewerPath,record_artifact_path:recordPath,readiness_score:finalized.record.readinessScore,strict_ready:finalized.record.strictReady,human_review_required:true,critical_conflicts:critical,material_conflicts:material,minor_conflicts:minor,current_stage:"persist",stage_state:{...object(run.stage_state),review:{status:"completed",recordPath,reviewerPath}}}).eq("id",task.run_id);
  await finish(task,{recordPath,reviewerPath,readinessScore:finalized.record.readinessScore});await enqueue(task,"persist",{});await event(task,"review_completed","Independent review completed",{readinessScore:finalized.record.readinessScore,strictReady:finalized.record.strictReady});
}
const GREEK_MONTHS:Record<string,string>={ιανουαριου:"01",φεβρουαριου:"02",μαρτιου:"03",απριλιου:"04",μαιου:"05",ιουνιου:"06",ιουλιου:"07",αυγουστου:"08",σεπτεμβριου:"09",οκτωβριου:"10",νοεμβριου:"11",δεκεμβριου:"12"};
function fold(s:string){return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");}
function dateValue(raw:string):string|null{const iso=raw.match(/\b(20\d{2}|19\d{2})-(\d{2})-(\d{2})\b/);if(iso)return `${iso[1]}-${iso[2]}-${iso[3]}`;const m=fold(raw).match(/\b(\d{1,2})\s+([α-ω]+)[,\s]+(20\d{2}|19\d{2})\b/u);if(m&&GREEK_MONTHS[m[2]])return `${m[3]}-${GREEK_MONTHS[m[2]]}-${m[1].padStart(2,"0")}`;return null;}
async function processPersist(task:Task){
  await stageUpdate(task,"persist",86);const run=await runRow(task);const record=await downloadJson(run.record_artifact_path);const reviewer=await downloadJson(run.reviewer_artifact_path);const source=record.source;
  const casePayload={source_hash:source.sourceHash,publication_status:"review",case_name:value(record.identity.caseName,source.sourceTitle),short_name:value(record.identity.shortName,""),citation:value(record.identity.citation,""),ecli:value(record.identity.ecli,""),case_number:value(record.identity.caseNumber,""),docket:value(record.identity.docket,""),decision_date:dateValue(value(record.identity.decisionDate,"")),decision_date_text:value(record.identity.decisionDate,""),decision_year:Number((value(record.identity.decisionDate,"").match(/(19|20)\d{2}/)||[])[0])||null,court:value(record.identity.court,""),court_level:value(record.classification.courtLevel,""),jurisdiction:value(record.identity.jurisdiction,"Cyprus"),case_family:value(record.classification.caseFamily,""),primary_legal_area:value(record.classification.primaryLegalArea,""),legal_areas:value(record.classification.legalAreas,[]),proceeding_type:value(record.classification.proceedingType,""),procedural_posture:value(record.classification.proceduralPosture,""),outcome:value(record.outcome.overallOutcome,""),judges:value(record.identity.judges,[]).map((j:any)=>j.name),authoring_judges:value(record.identity.authoringJudges,[]),source_url:source.sourceUrl,readiness_score:record.readinessScore,strict_ready:record.strictReady,human_review_required:true};
  const {data:caseRow,error:caseError}=await db.schema("nomologies").from("cases").upsert(casePayload,{onConflict:"source_hash"}).select("id,current_version_id").single();if(caseError)throw new Error(`CASE_UPSERT_FAILED:${caseError.message}`);
  const {data:versions}=await db.schema("nomologies").from("case_versions").select("version_no").eq("case_id",caseRow.id).order("version_no",{ascending:false}).limit(1);const versionNo=(versions?.[0]?.version_no||0)+1;
  const {data:version,error:versionError}=await db.schema("nomologies").from("case_versions").insert({case_id:caseRow.id,run_id:task.run_id,version_no:versionNo,schema_version:record.schemaVersion,canonical_record:record,reviewer_record:reviewer,record_artifact_path:run.record_artifact_path,readiness_score:record.readinessScore,strict_ready:record.strictReady,human_review_required:true,conflict_summary:{conflicts:record.conflicts,reviewFlags:record.reviewFlags}}).select("id").single();if(versionError)throw new Error(`CASE_VERSION_FAILED:${versionError.message}`);
  await db.schema("nomologies").from("cases").update({current_version_id:version.id,...casePayload}).eq("id",caseRow.id);
  const paragraphs=array(source.paragraphs).map((p:any)=>({case_version_id:version.id,paragraph_id:p.id,ordinal:p.ordinal,paragraph_text:p.text,start_offset:p.startOffset||0,end_offset:p.endOffset||0,relative_position:p.relativePosition||0,formatting:p.formatting||{}}));
  const sections=array(record.sectionMap?.spans).map((s:any)=>({case_version_id:version.id,section_id:s.id,start_paragraph_id:s.startParagraphId,end_paragraph_id:s.endParagraphId,section_type:s.sectionType,speaker_role:s.speakerRole,heading:s.heading||"",is_quoted_material:Boolean(s.isQuotedMaterial),quoted_source_type:s.quotedSourceType||"none",confidence:s.confidence||0,rationale:s.rationale||""}));
  const evidence=array(record.allEvidence).map((e:any)=>({case_version_id:version.id,evidence_id:e.id,field_path:array(e.supports)[0]||"",paragraph_ids:e.paragraphIds||[],quote:e.quote,section_type:e.sectionType||"",speaker_role:e.speakerRole||"",supports:e.supports||[],exact_match:Boolean(e.exactMatch)}));
  for(let i=0;i<paragraphs.length;i+=500){const {error}=await db.schema("nomologies").from("case_paragraphs").insert(paragraphs.slice(i,i+500));if(error)throw new Error(`PARAGRAPH_PERSIST_FAILED:${error.message}`);}
  if(sections.length){const {error}=await db.schema("nomologies").from("case_sections").insert(sections);if(error)throw new Error(`SECTION_PERSIST_FAILED:${error.message}`);}
  for(let i=0;i<evidence.length;i+=500){const {error}=await db.schema("nomologies").from("evidence_anchors").insert(evidence.slice(i,i+500));if(error)throw new Error(`EVIDENCE_PERSIST_FAILED:${error.message}`);}
  await db.schema("nomologies").from("pipeline_runs").update({status:record.strictReady?"strict_ready":"review",current_stage:"review",completed_at:new Date().toISOString()}).eq("id",task.run_id);
  if(task.bulk_item_id)await db.schema("nomologies").from("bulk_items").update({case_id:caseRow.id,status:record.strictReady?"strict_ready":"review",current_stage:"review",progress:100,result_summary:{caseName:casePayload.case_name,caseNumber:casePayload.case_number,readinessScore:record.readinessScore,strictReady:record.strictReady}}).eq("id",task.bulk_item_id);
  if(task.batch_id)await db.schema("nomologies").from("bulk_batches").update({status:"reviewing"}).eq("id",task.batch_id);
  await finish(task,{caseId:caseRow.id,caseVersionId:version.id,readinessScore:record.readinessScore,strictReady:record.strictReady});await event(task,"record_persisted","Canonical case version persisted",{caseId:caseRow.id,caseVersionId:version.id});
}
async function processEmbeddings(task:Task){
  await stageUpdate(task,"embeddings",92);const payload=object(task.payload);const caseId=String(payload.caseId||"");const versionId=String(payload.caseVersionId||"");
  const {data:version,error}=await db.schema("nomologies").from("case_versions").select("canonical_record").eq("id",versionId).single();if(error)throw new Error(`VERSION_READ_FAILED:${error.message}`);const record=version.canonical_record;const doc=buildSearchDocument(record);
  const vectors=await embedTexts(doc.fields.map((f:any)=>f.text),{dimensions:1024});
  const searchDoc={case_id:caseId,case_version_id:versionId,run_id:task.run_id,source_hash:doc.sourceHash,source_url:doc.sourceUrl,title:doc.title,short_title:doc.shortTitle,citation:doc.citation,case_number:doc.caseNumber,ecli:value(record.identity.ecli,""),decision_date:dateValue(doc.decisionDate),decision_year:doc.year,court:doc.court,court_level:doc.facets.courtLevel,case_family:doc.facets.caseFamily,primary_legal_area:doc.facets.primaryLegalArea,legal_areas:doc.facets.legalAreas,proceeding_type:doc.facets.proceedingType,procedural_posture:doc.facets.proceduralPosture,outcome:doc.outcome,judges:doc.judges,authoring_judges:doc.authoringJudges,aliases:doc.aliases,exact_terms:doc.exactTerms,law_ids:doc.facets.lawIds,provision_keys:doc.facets.provisionKeys,authority_treatments:doc.facets.authorityTreatments,authority_contexts:doc.facets.authorityContexts,readiness_score:doc.quality.readinessScore,strict_ready:doc.quality.strictReady,human_review_required:doc.quality.humanReviewRequired,critical_conflicts:doc.quality.criticalConflicts,material_conflicts:doc.quality.materialConflicts,evidence_count:doc.quality.evidenceCount,canonical_record:record,indexed_at:new Date().toISOString()};
  const {error:docError}=await db.schema("nomologies").from("case_search_documents").upsert(searchDoc,{onConflict:"case_id"});if(docError)throw new Error(`SEARCH_DOCUMENT_FAILED:${docError.message}`);
  await db.schema("nomologies").from("case_search_fields").delete().eq("case_id",caseId);
  const fields=doc.fields.map((f:any,i:number)=>({case_id:caseId,field_name:f.name,field_weight:f.weight,field_text:f.text,paragraph_ids:f.paragraphIds,embedding:vectors[i],embedding_model:embeddingModel(),embedding_updated_at:new Date().toISOString()}));if(fields.length){const {error}=await db.schema("nomologies").from("case_search_fields").insert(fields);if(error)throw new Error(`SEARCH_FIELDS_FAILED:${error.message}`);}
  await db.schema("nomologies").from("case_smart_tags").delete().eq("case_id",caseId);
  for(const tag of doc.smartTags){const {data:t,error}=await db.schema("nomologies").from("smart_tags").upsert({tag_key:tag.id,label:tag.label,normalized:tag.normalized,kind:tag.kind,aliases:tag.aliases},{onConflict:"tag_key"}).select("id").single();if(error)throw new Error(`SMART_TAG_FAILED:${error.message}`);await db.schema("nomologies").from("case_smart_tags").upsert({case_id:caseId,tag_id:t.id,confidence:tag.confidence,boost:tag.boost,evidence_paragraph_ids:tag.evidenceParagraphIds,source_field:tag.sourceField},{onConflict:"case_id,tag_id"});}
  await db.schema("nomologies").from("provision_links").delete().eq("case_id",caseId);const legislation:any[]=value<any[]>(record.authorities.legislation,[]);for(const instrument of legislation){for(const provision of instrument.provisions||[]){await db.schema("nomologies").from("provision_links").upsert({case_id:caseId,law_id:instrument.lawId||instrument.lawLabel||"unknown",law_label:instrument.lawLabel||instrument.instrumentName||"",provision_key:provision.normalized||provision.display,instrument_role:instrument.role||"unknown",application:provision.application||"unknown",is_primary:Boolean(instrument.primary),display:provision.display||provision.normalized||"",proposition:instrument.proposition||"",evidence_paragraph_ids:record.authorities.legislation.evidence.flatMap((e:any)=>e.paragraphIds||[])},{onConflict:"case_id,law_id,provision_key"});}}
  await db.schema("nomologies").from("authority_edges").delete().eq("source_case_id",caseId);const authorities:any[]=value<any[]>(record.authorities.authorities,[]);for(const authority of authorities){const key=authority.ecli||authority.citation||authority.name;await db.schema("nomologies").from("authority_edges").upsert({source_case_id:caseId,cited_case_key:key,cited_name:authority.name,cited_citation:authority.citation||"",cited_ecli:authority.ecli||"",treatment:authority.treatment||"unknown",citation_context:authority.citationContext||"unknown",legal_point:authority.legalPoint||"",evidence_paragraph_ids:record.authorities.authorities.evidence.flatMap((e:any)=>e.paragraphIds||[])},{onConflict:"source_case_id,cited_case_key,treatment,citation_context"});}
  const {data:caseRow}=await db.schema("nomologies").from("cases").select("publication_status").eq("id",caseId).single();await db.schema("nomologies").from("pipeline_runs").update({status:caseRow?.publication_status==="published"?"published":"strict_ready",current_stage:caseRow?.publication_status==="published"?"publish":"embeddings",completed_at:new Date().toISOString()}).eq("id",task.run_id);
  await finish(task,{caseId,indexed:true,fields:fields.length,tags:doc.smartTags.length});await event(task,"search_index_completed","Global lexical and vector index completed",{caseId,fields:fields.length,tags:doc.smartTags.length});
}
async function processTask(task:Task){
  await event(task,"task_started",`Stage ${task.stage} started`,{attempt:task.attempt_count});
  if(task.stage==="source")return processSource(task);
  if(task.stage==="sections")return processSections(task);
  if(task.stage==="specialists")return processSpecialists(task);
  if(task.stage==="review")return processReview(task);
  if(task.stage==="persist")return processPersist(task);
  if(task.stage==="embeddings"||task.stage==="reindex")return processEmbeddings(task);
  throw new Error(`UNSUPPORTED_STAGE:${task.stage}`);
}
async function invokeNext(){await fetch(`${SUPABASE_URL}/functions/v1/nomologies-worker`,{method:"POST",headers:{Authorization:`Bearer ${SERVICE_KEY}`,"Content-Type":"application/json"},body:'{"action":"claim"}'}).catch(()=>undefined);}

Deno.serve(async(req:Request)=>{
  if(!authorized(req))return json({ok:false,code:"UNAUTHORIZED"},401);
  try{
    const task=await claim();if(!task)return json({ok:true,status:"idle",worker:workerName});
    try{await processTask(task);}catch(error){await fail(task,error);throw error;}finally{waitUntil(invokeNext());}
    return json({ok:true,status:"processed",taskId:task.id,runId:task.run_id,stage:task.stage},202);
  }catch(error){console.error(error);return json({ok:false,code:"WORKER_ERROR",message:error instanceof Error?error.message:String(error)},500);}
});
