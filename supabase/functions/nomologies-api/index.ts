import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const GATEWAY_KEY_SHA256 = "ccdd163b7b8dc97769daa52fe656fad4202a966ff78c2999173b5970cfa8a174";
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const EMBEDDING_MODEL = Deno.env.get("NOMOLOGIES_EMBEDDING_MODEL") || "text-embedding-3-large";
const MAX_TEXT = 1_800_000;
const MAX_BULK = 2500;
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, x-nomologies-key",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
function pathOf(req: Request): string {
  const path = new URL(req.url).pathname.replace(/^\/nomologies-api\/?/, "/");
  return path === "" ? "/" : path;
}
function string(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
async function body(req: Request): Promise<Record<string, unknown>> {
  const length = Number(req.headers.get("content-length") || 0);
  if (length > 2_500_000) throw new ApiError(413, "REQUEST_TOO_LARGE", "The request body is too large.");
  try { return object(await req.json()); }
  catch { throw new ApiError(400, "INVALID_JSON", "The request body is not valid JSON."); }
}
class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
function safeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left); const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let mismatch = 0; for (let i=0;i<a.length;i++) mismatch |= a[i]^b[i];
  return mismatch === 0;
}
async function requireGateway(req: Request): Promise<void> {
  const supplied = req.headers.get("x-nomologies-key") || "";
  if (!supplied || !safeEqual(await sha256(supplied), GATEWAY_KEY_SHA256)) {
    throw new ApiError(401, "UNAUTHORIZED", "Invalid production gateway credential.");
  }
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2,"0")).join("");
}
function edgeRuntimeWaitUntil(promise: Promise<unknown>): void {
  const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(promise);
  else void promise;
}
async function kickWorker(): Promise<void> {
  if (!SUPABASE_URL || !SERVICE_KEY) return;
  await fetch(`${SUPABASE_URL}/functions/v1/nomologies-worker`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "claim" }),
  }).catch(() => undefined);
}
async function uploadText(hash: string, title: string, text: string): Promise<string> {
  const path = `intake/${hash}/${title.replace(/[^\p{L}\p{N}._-]+/gu,"_").slice(0,100) || "judgment"}.txt`;
  const { error } = await db.storage.from("nomologies-sources").upload(path, new TextEncoder().encode(text), {
    contentType: "text/plain", upsert: true,
  });
  if (error) throw new ApiError(500, "SOURCE_UPLOAD_FAILED", error.message);
  return path;
}
async function createIntake(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sourceUrl = string(payload.sourceUrl);
  const text = string(payload.text);
  const sourceTitle = string(payload.sourceTitle) || (sourceUrl ? "CyLaw judgment" : "Uploaded judgment");
  if (!sourceUrl && !text) throw new ApiError(400, "SOURCE_REQUIRED", "Provide a CyLaw URL or judgment text.");
  if (text.length > MAX_TEXT) throw new ApiError(413, "SOURCE_TOO_LARGE", `Judgment text must be below ${MAX_TEXT.toLocaleString()} characters.`);
  if (sourceUrl) {
    const url = new URL(sourceUrl);
    if (url.protocol !== "https:" || !["cylaw.org","www.cylaw.org"].includes(url.hostname)) throw new ApiError(400,"CYLAW_URL_NOT_ALLOWED","Only official HTTPS CyLaw URLs are accepted in URL mode.");
  }
  const hash = await sha256(text || sourceUrl);
  const storagePath = text ? await uploadText(hash, sourceTitle, text) : "";
  const { data, error } = await db.schema("nomologies").rpc("create_intake", {
    p_source_hash: hash,
    p_source_url: sourceUrl,
    p_source_title: sourceTitle,
    p_source_kind: sourceUrl ? "cylaw_url" : "uploaded_text",
    p_clean_text: text.length <= 200000 ? text : "",
    p_original_storage_path: storagePath,
    p_batch_id: null,
    p_ordinal: null,
  });
  if (error) throw new ApiError(500,"INTAKE_CREATE_FAILED",error.message);
  edgeRuntimeWaitUntil(kickWorker());
  return object(data);
}
function decodeHtml(buffer: ArrayBuffer): string {
  for (const charset of ["windows-1253","utf-8"]) {
    try {
      const decoded = new TextDecoder(charset).decode(buffer);
      if (decoded.includes("CyLaw") || decoded.includes("open.pl") || decoded.includes("Απόφαση")) return decoded;
    } catch { /* next */ }
  }
  return new TextDecoder().decode(buffer);
}
async function discoverCyLaw(indexUrl: string): Promise<Array<{sourceUrl:string;sourceTitle:string}>> {
  const url = new URL(indexUrl);
  if (url.protocol !== "https:" || !["cylaw.org","www.cylaw.org"].includes(url.hostname)) throw new ApiError(400,"CYLAW_URL_NOT_ALLOWED","Only official CyLaw index URLs are accepted.");
  const response = await fetch(url, { headers: { "user-agent": "NomologiesV2/1.0" } });
  if (!response.ok) throw new ApiError(502,"CYLAW_FETCH_FAILED",`CyLaw returned HTTP ${response.status}.`);
  const html = decodeHtml(await response.arrayBuffer());
  const results = new Map<string,string>();
  const anchor = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu;
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(html))) {
    const href = match[1].replace(/&amp;/g,"&");
    if (!/open\.pl\?file=|\/supreme\/.*\.html/i.test(href)) continue;
    try {
      const absolute = new URL(href,url).toString();
      const parsed = new URL(absolute);
      if (!["cylaw.org","www.cylaw.org"].includes(parsed.hostname)) continue;
      const title = match[2].replace(/<[^>]+>/g," ").replace(/&nbsp;|&#160;/g," ").replace(/\s+/g," ").trim();
      results.set(absolute,title);
    } catch { /* ignore malformed link */ }
  }
  return [...results].slice(0,MAX_BULK).map(([sourceUrl,sourceTitle]) => ({sourceUrl,sourceTitle}));
}
async function createBulk(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const discoverUrl = string(payload.discoverUrl || payload.sourceUrl);
  let rawItems = Array.isArray(payload.items) ? payload.items : [];
  if (discoverUrl) rawItems = await discoverCyLaw(discoverUrl);
  if (!rawItems.length) throw new ApiError(400,"BULK_ITEMS_REQUIRED","Provide a CyLaw index URL or an items array.");
  if (rawItems.length > MAX_BULK) throw new ApiError(413,"BULK_TOO_LARGE",`A batch may contain at most ${MAX_BULK} judgments.`);
  const items: Record<string,unknown>[] = [];
  for (const raw of rawItems) {
    const row = object(raw);
    const sourceUrl = string(row.sourceUrl || row.url);
    const text = string(row.text);
    if (!sourceUrl && !text) continue;
    const sourceTitle = string(row.sourceTitle || row.title) || (sourceUrl ? "CyLaw judgment" : "Uploaded judgment");
    const hash = await sha256(text || sourceUrl);
    let originalStoragePath = "";
    if (text) originalStoragePath = await uploadText(hash,sourceTitle,text);
    items.push({ sourceHash:hash,sourceUrl,sourceTitle,sourceKind:sourceUrl?"cylaw_url":"uploaded_text",text:text.length<=200000?text:"",originalStoragePath });
  }
  const { data, error } = await db.schema("nomologies").rpc("create_bulk_batch", {
    p_name: string(payload.name) || `Bulk ${new Date().toISOString()}`,
    p_source_url: discoverUrl,
    p_source_type: discoverUrl ? "cylaw_index" : "manual",
    p_options: object(payload.options),
    p_items: items,
  });
  if (error) throw new ApiError(500,"BULK_CREATE_FAILED",error.message);
  edgeRuntimeWaitUntil(kickWorker());
  return object(data);
}
async function embedding(text: string): Promise<number[] | null> {
  if (!OPENAI_KEY || !text.trim()) return null;
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method:"POST",
    headers:{Authorization:`Bearer ${OPENAI_KEY}`,"Content-Type":"application/json"},
    body:JSON.stringify({model:EMBEDDING_MODEL,input:text.slice(0,30000),dimensions:1024,encoding_format:"float"}),
  });
  if (!response.ok) throw new ApiError(502,"EMBEDDING_FAILED",`OpenAI embeddings returned HTTP ${response.status}.`);
  const result = object(await response.json());
  const first = Array.isArray(result.data) ? object(result.data[0]) : {};
  return Array.isArray(first.embedding) ? first.embedding.map(Number) : null;
}
async function search(payload: Record<string, unknown>): Promise<unknown> {
  const query = string(payload.query || payload.text);
  if (!query) throw new ApiError(400,"QUERY_REQUIRED","Search query is required.");
  const vector = payload.semantic === false ? null : await embedding(query);
  const { data, error } = await db.schema("nomologies").rpc("hybrid_case_search", {
    query_text: query,
    query_embedding: vector,
    filters: object(payload.filters),
    match_count: Math.max(1,Math.min(100,Number(payload.limit)||20)),
  });
  if (error) throw new ApiError(500,"SEARCH_FAILED",error.message);
  return { ok:true, query, semanticUsed:Boolean(vector), cases:data || [] };
}
async function runStatus(runId: string): Promise<unknown> {
  const { data:run,error } = await db.schema("nomologies").from("pipeline_runs").select("*").eq("id",runId).maybeSingle();
  if (error) throw new ApiError(500,"RUN_READ_FAILED",error.message);
  if (!run) throw new ApiError(404,"RUN_NOT_FOUND","Pipeline run not found.");
  const { data:tasks } = await db.schema("nomologies").from("pipeline_tasks").select("id,stage,status,attempt_count,max_attempts,last_error_code,last_error_message,created_at,started_at,completed_at").eq("run_id",runId).order("created_at");
  if (["queued","running"].includes(run.status)) edgeRuntimeWaitUntil(kickWorker());
  return {ok:true,run,tasks:tasks||[]};
}
async function batchStatus(batchId: string): Promise<unknown> {
  const { data:batch,error } = await db.schema("nomologies").from("bulk_batches").select("*").eq("id",batchId).maybeSingle();
  if (error) throw new ApiError(500,"BATCH_READ_FAILED",error.message);
  if (!batch) throw new ApiError(404,"BATCH_NOT_FOUND","Bulk batch not found.");
  const { data:items } = await db.schema("nomologies").from("bulk_items").select("id,ordinal,source_url,source_title,status,current_stage,progress,attempt_count,last_error_code,last_error_message,case_id,pipeline_run_id,updated_at").eq("batch_id",batchId).order("ordinal");
  if (["queued","running","fetching"].includes(batch.status)) edgeRuntimeWaitUntil(kickWorker());
  return {ok:true,batch,items:items||[]};
}
async function approveCase(caseId: string, payload: Record<string, unknown>, req: Request): Promise<unknown> {
  const decision = string(payload.decision) || "approve";
  if (!['approve','request_changes','reject','withdraw'].includes(decision)) throw new ApiError(400,"INVALID_DECISION","Invalid review decision.");
  const { data:caseRow,error } = await db.schema("nomologies").from("cases").select("*").eq("id",caseId).maybeSingle();
  if (error) throw new ApiError(500,"CASE_READ_FAILED",error.message);
  if (!caseRow) throw new ApiError(404,"CASE_NOT_FOUND","Case not found.");
  if (!caseRow.current_version_id) throw new ApiError(409,"CASE_VERSION_MISSING","Case has no current extraction version.");
  await db.schema("nomologies").from("review_decisions").insert({
    case_id:caseId,case_version_id:caseRow.current_version_id,decision,
    reviewer_name:string(payload.reviewerName) || "Nomologies reviewer",notes:string(payload.notes),corrections:object(payload.corrections),
    signature_hash:await sha256(`${caseId}|${caseRow.current_version_id}|${decision}|${new Date().toISOString()}|${req.headers.get("authorization")||""}`),
  });
  const publicationStatus = decision === "approve" ? (payload.publish === false ? "approved" : "published") : decision === "withdraw" ? "withdrawn" : "review";
  const update: Record<string,unknown> = {publication_status:publicationStatus,approved_at:decision==="approve"?new Date().toISOString():null};
  if (publicationStatus === "published") update.published_at = new Date().toISOString();
  const { error:updateError } = await db.schema("nomologies").from("cases").update(update).eq("id",caseId);
  if (updateError) throw new ApiError(500,"CASE_APPROVAL_FAILED",updateError.message);
  if (decision === "approve") {
    const { data:run } = await db.schema("nomologies").from("case_versions").select("run_id").eq("id",caseRow.current_version_id).maybeSingle();
    if (run?.run_id) {
      await db.schema("nomologies").from("pipeline_tasks").upsert({run_id:run.run_id,stage:"embeddings",status:"queued",priority:90,payload:{caseId,caseVersionId:caseRow.current_version_id,publish:publicationStatus==="published"}}, {onConflict:"run_id,stage"});
      edgeRuntimeWaitUntil(kickWorker());
    }
  }
  return {ok:true,caseId,decision,publicationStatus};
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null,{status:204,headers:CORS});
  const path = pathOf(req);
  try {
    if (req.method === "GET" && path === "/health") return json({
      ok:true,service:"nomologies-api",databaseConfigured:Boolean(SUPABASE_URL&&SERVICE_KEY),openaiConfigured:Boolean(OPENAI_KEY),gatewayKeyConfigured:Boolean(GATEWAY_KEY_SHA256),projectRef:SUPABASE_URL.match(/https:\/\/([^.]+)/)?.[1]||"",timestamp:new Date().toISOString(),
    });
    await requireGateway(req);
    if (req.method === "POST" && path === "/intake") return json({ok:true,...await createIntake(await body(req))},202);
    if (req.method === "POST" && ["/bulk","/bulk/discover"].includes(path)) return json({ok:true,...await createBulk(await body(req))},202);
    if (req.method === "POST" && path === "/search") return json(await search(await body(req)));
    if (req.method === "POST" && path === "/worker/kick") { edgeRuntimeWaitUntil(kickWorker()); return json({ok:true,status:"worker_invoked"},202); }
    const runMatch = path.match(/^\/runs\/([0-9a-f-]{36})$/i);
    if (req.method === "GET" && runMatch) return json(await runStatus(runMatch[1]));
    const batchMatch = path.match(/^\/batches\/([0-9a-f-]{36})$/i);
    if (req.method === "GET" && batchMatch) return json(await batchStatus(batchMatch[1]));
    const approveMatch = path.match(/^\/cases\/([0-9a-f-]{36})\/review$/i);
    if (req.method === "POST" && approveMatch) return json(await approveCase(approveMatch[1],await body(req),req));
    const caseMatch = path.match(/^\/cases\/([0-9a-f-]{36})$/i);
    if (req.method === "GET" && caseMatch) {
      const { data,error }=await db.schema("nomologies").from("cases").select("*,case_versions!cases_current_version_fk(*)").eq("id",caseMatch[1]).maybeSingle();
      if (error) throw new ApiError(500,"CASE_READ_FAILED",error.message); if (!data) throw new ApiError(404,"CASE_NOT_FOUND","Case not found."); return json({ok:true,case:data});
    }
    if (req.method === "GET" && path === "/cases") {
      const status = string(new URL(req.url).searchParams.get("status")) || "published";
      const { data,error }=await db.schema("nomologies").from("cases").select("*").eq("publication_status",status).order("decision_date",{ascending:false}).limit(200);
      if (error) throw new ApiError(500,"CASES_READ_FAILED",error.message); return json({ok:true,cases:data||[]});
    }
    return json({ok:false,code:"NOT_FOUND",message:"Route not found."},404);
  } catch (error) {
    if (error instanceof ApiError) return json({ok:false,code:error.code,message:error.message},error.status);
    console.error(error);
    return json({ok:false,code:"SERVER_ERROR",message:error instanceof Error?error.message:"Unexpected server error."},500);
  }
});
