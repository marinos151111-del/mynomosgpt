import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { leafTerms, parseQuery, scoreMatch, scoreWeightedFields } from "../../../src/nomologies-search/elite-query.ts";
import { runDeferredFieldAgent } from "../../../src/nomologies-v2/agents.ts";
import { dedupeRecordPresentation } from "../../../src/nomologies-v2/quality-core.ts";
import type { JudgmentParagraphV2, JudgmentSourceV2, SectionMapV2 } from "../../../src/nomologies-v2/types.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const GATEWAY_KEY_SHA256 = "88de7c7705f60314aa8b23ae6045258e28991e965d825613bfe9a68baeb7aafa";
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const EMBEDDING_MODEL = Deno.env.get("NOMOLOGIES_EMBEDDING_MODEL") || "text-embedding-3-large";
const CHAT_MODEL = Deno.env.get("NOMOLOGIES_CHAT_MODEL") || "gpt-5.4-mini";
const V2_MODEL = Deno.env.get("NOMOLOGIES_V2_MODEL") || undefined;
const MAX_TEXT = 1_800_000;
const MAX_BULK = 2500;
const BULK_WINDOW_SIZE = 10;
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, x-nomologies-key, x-nomologies-actor-email",
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
function array(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(object) : [];
}

const PUBLIC_SMART_TAG_KINDS = new Set(["legal_area","procedure","issue","principle","evidence","remedy"]);
const PUBLIC_GREEK_STOPWORDS = new Set([
  "και","ή","η","ο","οι","τα","το","του","της","των","τον","την","τις","τους",
  "σε","στο","στη","στην","στον","στα","με","για","από","προς","κατά","περί",
  "ως","ότι","που","να","ένα","μια","ένας","αυτή","αυτό","άλλων","άλλου",
]);
const PUBLIC_LOW_VALUE_TAGS = new Set([
  "γνώση","δικαίωμα","ευχέρεια","επιτυχία","παράλειψη","πρωτόδικη",
  "διάκριση","διάταγμα","απόρριψη","μερική","έφεση","αίτηση",
]);

function publicSmartTags(tags: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const output = new Map<string, Record<string, unknown>>();
  for (const tag of tags) {
    const kind = string(tag.kind);
    if (!PUBLIC_SMART_TAG_KINDS.has(kind)) continue;
    const sourceField = string(tag.source_field || tag.sourceField);
    if (!sourceField.startsWith("concept.")) continue;
    const label = string(tag.label).normalize("NFC");
    if (!/^[Α-Ωα-ωΆ-Ώά-ώΐΰϊϋ][Α-Ωα-ωΆ-Ώά-ώΐΰϊϋ\s‑-]{2,80}$/u.test(label)) continue;
    if (label.split(/\s+/u).length > 5) continue;
    const lower = label.toLocaleLowerCase("el");
    const normalized = lower.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ς/g, "σ");
    if (PUBLIC_GREEK_STOPWORDS.has(lower) || PUBLIC_LOW_VALUE_TAGS.has(lower) || !normalized) continue;
    const key = normalized;
    const prior = output.get(key);
    if (prior) {
      prior.confidence = Math.max(Number(prior.confidence || 0),Number(tag.confidence || 0));
      prior.boost = Math.max(Number(prior.boost || 0),Number(tag.boost || 0));
      prior.aliases = [...new Set([
        ...(Array.isArray(prior.aliases) ? prior.aliases.map(String) : []),
        ...(Array.isArray(tag.aliases) ? tag.aliases.map(String) : []),
      ].filter(Boolean))];
      continue;
    }
    output.set(key,{
      ...tag,
      tag_key:`public_${kind}_${normalized}`,
      label,
      normalized,
      aliases:[...new Set([label, ...(Array.isArray(tag.aliases) ? tag.aliases.map(String) : [])].filter(Boolean))],
    });
  }
  return [...output.values()].sort((left,right) => Number(right.boost||0)-Number(left.boost||0) || String(left.label).localeCompare(String(right.label),"el")).slice(0,20);
}
const MATCH_GREEK_TO_LATIN: Record<string, string> = {
  α:"a",β:"v",γ:"g",δ:"d",ε:"e",ζ:"z",η:"i",θ:"th",ι:"i",κ:"k",λ:"l",μ:"m",ν:"n",
  ξ:"x",ο:"o",π:"p",ρ:"r",σ:"s",ς:"s",τ:"t",υ:"y",φ:"f",χ:"ch",ψ:"ps",ω:"o",
};
function searchMatchReasons(document: Record<string, unknown>, hit: Record<string, unknown>, query: string): string[] {
  const fold = (value: unknown) => String(value || "").toLocaleLowerCase("el").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ς/g, "σ").replace(/[^a-zα-ω0-9/]+/gu, " ").replace(/\s+/g, " ").trim();
  const latin = (value: unknown) => fold(value).split("").map((char) => MATCH_GREEK_TO_LATIN[char] ?? char).join("");
  const queryKey = fold(query);
  const fields = new Set(Array.isArray(hit.matched_fields) ? hit.matched_fields.map(String) : []);
  const reasons: string[] = [];
  if (fields.has("identity")) {
    const citations = fold(`${string(document.citation)} ${string(document.case_number)} ${string(document.ecli)}`);
    const parties = fold(`${string(document.title)} ${string(document.short_title)}`);
    if (queryKey && citations.includes(queryKey)) reasons.push("Ταίριασμα παραπομπής");
    else if (queryKey && (parties.includes(queryKey) || latin(parties).includes(latin(queryKey)))) reasons.push("Ταίριασμα διαδίκου");
  }
  if (fields.has("provisions")) reasons.push("Ταίριασμα νομοθετικής διάταξης");
  if (fields.has("authorities")) reasons.push("Ταίριασμα παραπεμπόμενης αρχής");
  if (fields.has("concepts")) reasons.push("Ταίριασμα νομικού θέματος");
  if ([...fields].some((field) => ["principle","ratio","holding","issues"].includes(field))) reasons.push("Ταίριασμα νομικής ανάλυσης");
  if ([...fields].some((field) => ["facts","procedure","submissions","full_text"].includes(field))) reasons.push("Ταίριασμα πλήρους κειμένου");
  return [...new Set(reasons.length ? reasons : ["Σημασιολογικό ταίριασμα"])];
}
async function body(req: Request): Promise<Record<string, unknown>> {
  const length = Number(req.headers.get("content-length") || 0);
  if (length > 2_500_000) throw new ApiError(413, "REQUEST_TOO_LARGE", "The request body is too large.");
  try { return object(await req.json()); }
  catch { throw new ApiError(400, "INVALID_JSON", "The request body is not valid JSON."); }
}
class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) { super(message); }
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
async function kickWorkerIfIdle(): Promise<void> {
  const now = new Date().toISOString();
  const { data, error } = await db.schema("nomologies").from("pipeline_tasks")
    .select("id")
    .eq("status", "running")
    .gte("locked_until", now)
    .limit(1);
  if (error || (data && data.length > 0)) return;
  await kickWorker();
}

type DeferredKind = "chronology" | "witnessesAndEvidence";

async function deferredCaseField(caseId: string, kind: DeferredKind, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const regenerate = payload.regenerate === true;
  const { data:caseRow,error:caseError } = await db.schema("nomologies").from("cases")
    .select("id,current_version_id,pending_version_id,case_name,source_hash,source_url")
    .eq("id",caseId).maybeSingle();
  if (caseError) throw new ApiError(500,"DEFERRED_CASE_READ_FAILED",caseError.message);
  if (!caseRow) throw new ApiError(404,"CASE_NOT_FOUND","Case not found.");
  const versionId = string(caseRow.pending_version_id || caseRow.current_version_id);
  if (!versionId) throw new ApiError(409,"CASE_VERSION_MISSING","The case has no analysable version.");

  const { data:version,error:versionError } = await db.schema("nomologies").from("case_versions")
    .select("id,canonical_record,created_at").eq("id",versionId).maybeSingle();
  if (versionError) throw new ApiError(500,"DEFERRED_VERSION_READ_FAILED",versionError.message);
  if (!version) throw new ApiError(404,"CASE_VERSION_NOT_FOUND","Case version not found.");
  const canonical = object(version.canonical_record);
  const facts = object(canonical.facts);
  const generated = object(canonical.deferredExtractions);
  if (!regenerate && generated[kind]) {
    return { ok:true,caseId,caseVersionId:versionId,kind,field:facts[kind] || null,cached:true,generatedAt:object(generated[kind]).generatedAt || null };
  }

  const [paragraphResult,sectionResult] = await Promise.all([
    db.schema("nomologies").from("case_paragraphs").select("*").eq("case_version_id",versionId).order("ordinal",{ascending:true}),
    db.schema("nomologies").from("case_sections").select("*").eq("case_version_id",versionId),
  ]);
  if (paragraphResult.error) throw new ApiError(500,"DEFERRED_PARAGRAPHS_READ_FAILED",paragraphResult.error.message);
  if (sectionResult.error) throw new ApiError(500,"DEFERRED_SECTIONS_READ_FAILED",sectionResult.error.message);
  const paragraphRows = paragraphResult.data || [];
  if (!paragraphRows.length) throw new ApiError(409,"DEFERRED_SOURCE_MISSING","The stored judgment paragraphs are unavailable.");

  const paragraphs = paragraphRows.map((row:Record<string,unknown>):JudgmentParagraphV2 => ({
    id:string(row.paragraph_id),ordinal:Number(row.ordinal||0),text:string(row.paragraph_text),
    startOffset:Number(row.start_offset||0),endOffset:Number(row.end_offset||0),relativePosition:Number(row.relative_position||0),
    parentBlockId:"",sourceLineStart:0,sourceLineEnd:0,formatting:object(row.formatting) as JudgmentParagraphV2["formatting"],
  }));
  const source:JudgmentSourceV2 = {
    sourceId:caseId,sourceHash:string(caseRow.source_hash),sourceUrl:string(caseRow.source_url),sourceTitle:string(caseRow.case_name),
    sourceDatabase:"CyLaw",retrievedAt:string(version.created_at),charset:"utf-8",languageHint:"el",originalHtml:"",
    cleanText:paragraphs.map((paragraph)=>paragraph.text).join("\n\n"),
    characterCount:paragraphs.reduce((sum,paragraph)=>sum+paragraph.text.length,0),paragraphs,
  };
  const spans = (sectionResult.data || []).map((row:Record<string,unknown>) => ({
    id:string(row.section_id),startParagraphId:string(row.start_paragraph_id),endParagraphId:string(row.end_paragraph_id),
    sectionType:string(row.section_type) as any,speakerRole:string(row.speaker_role) as any,heading:string(row.heading),
    isQuotedMaterial:Boolean(row.is_quoted_material),quotedSourceType:(string(row.quoted_source_type)||"none") as any,
    confidence:Number(row.confidence||0),boundaryEvidenceParagraphIds:[],rationale:string(row.rationale),
  }));
  const sectionMap:SectionMapV2 = {version:"stored-v2",paragraphCount:paragraphs.length,spans,coverageComplete:true,overlapFree:true,reviewFlags:[]};
  const extractedField = await runDeferredFieldAgent(kind,source,sectionMap,{model:V2_MODEL});
  const field = {
    ...extractedField,
    evidence:extractedField.evidence.map((anchor)=>({...anchor,id:`deferred:${kind}:${anchor.id}`})),
  };
  const generatedAt = new Date().toISOString();
  const nextCanonical = {
    ...canonical,
    facts:{...facts,[kind]:field},
    deferredExtractions:{...generated,[kind]:{generatedAt,modelProfile:V2_MODEL||"tiered",status:field.status}},
  };
  const { error:updateError } = await db.schema("nomologies").from("case_versions").update({canonical_record:nextCanonical}).eq("id",versionId);
  if (updateError) throw new ApiError(500,"DEFERRED_SAVE_FAILED",updateError.message);
  await db.schema("nomologies").from("evidence_anchors").delete().eq("case_version_id",versionId).eq("field_path",`facts.${kind}`);
  if (field.evidence.length) {
    const { error:evidenceError } = await db.schema("nomologies").from("evidence_anchors").insert(field.evidence.map((anchor)=>({
      case_version_id:versionId,evidence_id:anchor.id,field_path:`facts.${kind}`,paragraph_ids:anchor.paragraphIds,
      quote:anchor.quote,section_type:anchor.sectionType,speaker_role:anchor.speakerRole,supports:anchor.supports,exact_match:anchor.exactMatch,
    })));
    if (evidenceError) throw new ApiError(500,"DEFERRED_EVIDENCE_SAVE_FAILED",evidenceError.message);
  }
  return {ok:true,caseId,caseVersionId:versionId,kind,field,cached:false,generatedAt};
}
async function uploadText(hash: string, title: string, text: string): Promise<string> {
  const path = `intake/${hash}/${title.replace(/[^\p{L}\p{N}._-]+/gu,"_").slice(0,100) || "judgment"}.txt`;
  const { error } = await db.storage.from("nomologies-sources").upload(path, new TextEncoder().encode(text), {
    contentType: "text/plain", upsert: true,
  });
  if (error) throw new ApiError(500, "SOURCE_UPLOAD_FAILED", error.message);
  return path;
}

const CYLAW_HOSTS = new Set(["cylaw.org", "www.cylaw.org"]);

function officialCyLawUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new ApiError(400, "CYLAW_URL_INVALID", "The CyLaw URL is not valid."); }
  if (url.protocol !== "https:" || !CYLAW_HOSTS.has(url.hostname.toLowerCase())) {
    throw new ApiError(400, "CYLAW_URL_NOT_ALLOWED", "Only official HTTPS CyLaw URLs are accepted.");
  }
  url.hash = "";
  return url;
}

function canonicalJudgmentUrl(value: string): { url: string; year: number } {
  const parsed = officialCyLawUrl(value);
  let filePath = "";
  if (/^\/cgi-bin\/open\.pl$/i.test(parsed.pathname)) {
    filePath = string(parsed.searchParams.get("file"));
  } else {
    filePath = parsed.pathname;
  }

  const supreme = filePath.match(/^\/supreme\/((?:19|20)\d{2})\/([^/]+\.html?)$/i);
  const reports = filePath.match(/^\/apofaseis\/.*\/((?:19|20)\d{2})\/[^/]+\.html?$/i);
  const match = supreme || reports;
  if (!match || /^index(?:_|\.)/i.test(supreme?.[2] || "")) {
    throw new ApiError(400, "CYLAW_JUDGMENT_URL_REQUIRED", "Provide a direct CyLaw judgment URL, not an index, note-up, or cited-authority navigation page.");
  }

  return {
    url: `https://www.cylaw.org/cgi-bin/open.pl?file=${filePath}`,
    year: Number(match[1]),
  };
}

function canonicalAnnualIndex(value: string): { url: URL; year: number } {
  const parsed = officialCyLawUrl(value);
  const match = parsed.pathname.match(/^\/supreme\/index_((?:19|20)\d{2})\.html$/i);
  if (!match) {
    throw new ApiError(400, "CYLAW_YEAR_INDEX_REQUIRED", "Bulk discovery requires an official yearly CyLaw index such as /supreme/index_2026.html. A judgment page cannot be used as an index.");
  }
  parsed.search = "";
  parsed.hostname = "www.cylaw.org";
  return { url: parsed, year: Number(match[1]) };
}

async function createIntake(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const suppliedSourceUrl = string(payload.sourceUrl);
  const text = string(payload.text);
  const sourceTitle = string(payload.sourceTitle) || (suppliedSourceUrl ? "CyLaw judgment" : "Uploaded judgment");
  if (!suppliedSourceUrl && !text) throw new ApiError(400, "SOURCE_REQUIRED", "Provide a CyLaw URL or judgment text.");
  if (text.length > MAX_TEXT) throw new ApiError(413, "SOURCE_TOO_LARGE", `Judgment text must be below ${MAX_TEXT.toLocaleString()} characters.`);
  const sourceUrl = suppliedSourceUrl ? canonicalJudgmentUrl(suppliedSourceUrl).url : "";
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
  edgeRuntimeWaitUntil(kickWorkerIfIdle());
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
async function discoverCyLaw(indexUrl: string): Promise<{ indexUrl: string; year: number; items: Array<{sourceUrl:string;sourceTitle:string}> }> {
  const annual = canonicalAnnualIndex(indexUrl);
  const url = annual.url;
  const response = await fetch(url, { headers: { "user-agent": "NomologiesV2/1.0" } });
  if (!response.ok) throw new ApiError(502,"CYLAW_FETCH_FAILED",`CyLaw returned HTTP ${response.status}.`);
  const html = decodeHtml(await response.arrayBuffer());
  const results = new Map<string,string>();
  const anchor = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu;
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(html))) {
    const href = match[1].replace(/&amp;/g,"&");
    try {
      const absolute = new URL(href,url).toString();
      const judgment = canonicalJudgmentUrl(absolute);
      if (judgment.year !== annual.year || !judgment.url.includes(`/supreme/${annual.year}/`)) continue;
      const title = match[2].replace(/<[^>]+>/g," ").replace(/&nbsp;|&#160;/g," ").replace(/\s+/g," ").trim();
      if (!title || /κατάλογος αποφάσεων|noteup|υπογραμμίσ/i.test(title)) continue;
      results.set(judgment.url,title);
    } catch { /* ignore malformed link */ }
  }
  const items = [...results].slice(0,MAX_BULK).map(([sourceUrl,sourceTitle]) => ({sourceUrl,sourceTitle}));
  if (!items.length) throw new ApiError(422, "CYLAW_INDEX_EMPTY", `No ${annual.year} judgment links were found in the supplied yearly index.`);
  return { indexUrl: url.toString(), year: annual.year, items };
}
async function createBulk(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const suppliedDiscoverUrl = string(payload.discoverUrl || payload.sourceUrl);
  let discoverUrl = suppliedDiscoverUrl;
  let expectedYear: number | null = null;
  let rawItems = Array.isArray(payload.items) ? payload.items : [];
  if (discoverUrl) {
    const discovery = await discoverCyLaw(discoverUrl);
    discoverUrl = discovery.indexUrl;
    expectedYear = discovery.year;
    rawItems = discovery.items;

    const { data: existing, error: existingError } = await db.schema("nomologies").from("bulk_batches")
      .select("id,status,discovered_count,queued_count,processing_count,completed_count,review_count,published_count,failed_count,options")
      .eq("source_url", discoverUrl)
      .in("status", ["created", "queued", "running", "reviewing"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existingError) throw new ApiError(500, "BULK_IDEMPOTENCY_CHECK_FAILED", existingError.message);
    if (existing) return { ...existing, batchId: existing.id, existing: true, expectedYear };
  }
  if (!rawItems.length) throw new ApiError(400,"BULK_ITEMS_REQUIRED","Provide a CyLaw index URL or an items array.");
  if (rawItems.length > MAX_BULK) throw new ApiError(413,"BULK_TOO_LARGE",`A batch may contain at most ${MAX_BULK} judgments.`);
  const items: Record<string,unknown>[] = [];
  for (const raw of rawItems) {
    const row = object(raw);
    const suppliedSourceUrl = string(row.sourceUrl || row.url);
    const text = string(row.text);
    if (!suppliedSourceUrl && !text) continue;
    const sourceUrl = suppliedSourceUrl ? canonicalJudgmentUrl(suppliedSourceUrl).url : "";
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
    p_options: {
      ...object(payload.options),
      batchSize: BULK_WINDOW_SIZE,
      manualReviewGate: true,
      discoveryContract: discoverUrl ? "cylaw-year-index-v1" : "manual-judgments-v1",
      ...(expectedYear ? { expectedYear } : {}),
    },
    p_items: items,
  });
  if (error) throw new ApiError(500,"BULK_CREATE_FAILED",error.message);
  edgeRuntimeWaitUntil(kickWorkerIfIdle());
  return object(data);
}
async function embedding(text: string, timeoutMs = 900): Promise<number[] | null> {
  if (!OPENAI_KEY || !text.trim()) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("embedding-timeout"), timeoutMs);
  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method:"POST",
      headers:{Authorization:`Bearer ${OPENAI_KEY}`,"Content-Type":"application/json"},
      body:JSON.stringify({model:EMBEDDING_MODEL,input:text.slice(0,30000),dimensions:1024,encoding_format:"float"}),
      signal:controller.signal,
    });
    if (!response.ok) throw new ApiError(502,"EMBEDDING_FAILED",`OpenAI embeddings returned HTTP ${response.status}.`);
    const result = object(await response.json());
    const first = Array.isArray(result.data) ? object(result.data[0]) : {};
    return Array.isArray(first.embedding) ? first.embedding.map(Number) : null;
  } finally {
    clearTimeout(timeout);
  }
}
async function search(payload: Record<string, unknown>): Promise<unknown> {
  const query = string(payload.query || payload.text);
  if (!query) throw new ApiError(400,"QUERY_REQUIRED","Search query is required.");
  const queryAst = parseQuery(query);
  const leaves = leafTerms(queryAst);
  const requestedLimit = Math.max(1,Math.min(100,Number(payload.limit)||20));
  const precisionSyntax = /["()]|\b(?:AND|OR|NOT)\b|(?:^|\s)-\S/iu.test(query);
  const retrievalQuery = [...leaves.phrases, ...leaves.words].join(" ").trim() || query;
  const matchCount = Math.min(100, precisionSyntax ? Math.max(40,requestedLimit*5) : Math.max(20,requestedLimit*2));
  const filters = object(payload.filters);
  let vector: number[] | null = null;
  let semanticDegraded = false;
  // Identity and lexical retrieval are the production-critical path. It must
  // not wait for an external embedding provider: an earlier implementation
  // awaited OpenAI first and caused every ordinary search to terminate with
  // Edge Runtime status 546 when that subrequest stalled.
  let searchResult = await db.schema("nomologies").rpc("hybrid_case_search", {
    query_text: retrievalQuery,
    query_embedding: null,
    filters,
    match_count: matchCount,
  });
  if (searchResult.error) throw new ApiError(500,"SEARCH_FAILED",searchResult.error.message);

  // Semantic retrieval is a bounded fallback for weak recall, never a
  // prerequisite for an exact name/citation or ordinary lexical result.
  const lexicalHits = array(searchResult.data);
  const topLexical = object(lexicalHits[0]);
  const exactIdentityStrong = Number(topLexical.exact_identity_score || 0) >= 150;
  const weakLexicalRecall = lexicalHits.length <= 2 || Number(topLexical.score || 0) < 34;
  if (!exactIdentityStrong && weakLexicalRecall && payload.semantic !== false) {
    try {
      vector = await embedding(query);
      if (vector) {
        const semanticResult = await db.schema("nomologies").rpc("hybrid_case_search", {
          query_text: retrievalQuery,
          query_embedding: vector,
          filters,
          match_count: matchCount,
        });
        if (semanticResult.error) throw new ApiError(500,"SEARCH_FAILED",semanticResult.error.message);
        if (array(semanticResult.data).length || lexicalHits.length === 0) searchResult = semanticResult;
      }
    } catch (error) {
      // Search must remain available when the embedding provider is slow or
      // temporarily unavailable. The lexical/identity index is authoritative
      // and is sufficient to retrieve a published judgment by name, citation,
      // case number, legislation or legal proposition.
      semanticDegraded = true;
      console.warn("Nomologies semantic search degraded to lexical retrieval", error);
    }
  }
  const hits = array(searchResult.data);
  const ids = hits.map((hit) => string(hit.case_id)).filter(Boolean);
  if (!ids.length) return { ok:true, query, semanticUsed:Boolean(vector), semanticDegraded, cases:[] };

  const [documentsResult, casesResult, fieldsResult, tagLinksResult, tagsResult, provisionsResult] = await Promise.all([
    db.schema("nomologies").from("case_search_documents")
      .select("case_id,source_url,title,short_title,citation,case_number,ecli,decision_date,decision_year,court,court_level,case_family,primary_legal_area,legal_areas,proceeding_type,procedural_posture,outcome,judges,aliases,law_ids,provision_keys,principle_ids,precedential_score,precedential_tier,precedential_factors,readiness_score,strict_ready,human_review_required")
      .in("case_id", ids),
    db.schema("nomologies").from("cases")
      .select("id,publication_status")
      .in("id", ids)
      .eq("publication_status", "published"),
    db.schema("nomologies").from("case_search_fields")
      .select("case_id,field_name,field_text,paragraph_ids")
      .in("case_id", ids)
      .in("field_name", ["principle", "ratio", "holding", "issues", "facts"]),
    db.schema("nomologies").from("case_smart_tags")
      .select("case_id,tag_id,confidence,boost,source_field,evidence_paragraph_ids")
      .in("case_id", ids),
    db.schema("nomologies").from("smart_tags")
      .select("id,tag_key,label,normalized,kind,aliases"),
    db.schema("nomologies").from("provision_links")
      .select("case_id,law_id,law_label,provision_key,display,instrument_role,application,is_primary,proposition,evidence_paragraph_ids")
      .in("case_id", ids),
  ]);
  const lookupError = documentsResult.error || casesResult.error || fieldsResult.error || tagLinksResult.error || tagsResult.error || provisionsResult.error;
  if (lookupError) throw new ApiError(500, "SEARCH_ENRICHMENT_FAILED", lookupError.message);

  const published = new Set(array(casesResult.data).map((row) => string(row.id)));
  const documents = new Map(array(documentsResult.data).map((row) => [string(row.case_id), row]));
  const tagDefinitions = new Map(array(tagsResult.data).map((row) => [string(row.id), row]));
  const fieldsByCase = new Map<string, Record<string, unknown>>();
  for (const field of array(fieldsResult.data)) {
    const caseId = string(field.case_id);
    const current = fieldsByCase.get(caseId) || {};
    current[string(field.field_name)] = field.field_text;
    fieldsByCase.set(caseId, current);
  }
  const tagsByCase = new Map<string, Array<Record<string, unknown>>>();
  for (const link of array(tagLinksResult.data)) {
    const caseId = string(link.case_id);
    const definition = tagDefinitions.get(string(link.tag_id));
    if (!definition) continue;
    const values = tagsByCase.get(caseId) || [];
    values.push({ ...definition, confidence: link.confidence, boost: link.boost, sourceField: link.source_field, evidenceParagraphIds: link.evidence_paragraph_ids });
    tagsByCase.set(caseId, values);
  }
  const provisionsByCase = new Map<string, Array<Record<string, unknown>>>();
  for (const provision of array(provisionsResult.data)) {
    const caseId = string(provision.case_id);
    const values = provisionsByCase.get(caseId) || [];
    values.push(provision);
    provisionsByCase.set(caseId, values);
  }

  const cases = hits.flatMap((hit,index) => {
    const caseId = string(hit.case_id);
    if (!published.has(caseId)) return [];
    const document = documents.get(caseId) || {};
    const fields = fieldsByCase.get(caseId) || {};
    const smartTags = publicSmartTags(tagsByCase.get(caseId) || []);
    const provisions = provisionsByCase.get(caseId) || [];
    const issueTags = smartTags
      .filter((tag) => ["issue", "principle", "legal_area", "procedure", "outcome"].includes(string(tag.kind)))
      .map((tag) => string(tag.label))
      .filter(Boolean);
    const precisionText = [
      string(document.title),string(document.short_title),string(document.citation),string(document.case_number),string(document.ecli),
      string(document.court),string(document.case_family),string(document.primary_legal_area),
      ...Object.values(fields).map(String),
      ...smartTags.flatMap((tag) => [string(tag.label),...(Array.isArray(tag.aliases)?tag.aliases.map(String):[])]),
      ...provisions.flatMap((item) => [string(item.display),string(item.law_label),string(item.provision_key),string(item.proposition)]),
    ].filter(Boolean).join("\n");
    const exactScore=scoreMatch(queryAst,precisionText);
    const weighted=scoreWeightedFields(queryAst,[
      {name:"identity",text:[string(document.title),string(document.short_title),string(document.citation),string(document.case_number),string(document.ecli)].join(" "),weight:16},
      {name:"principle",text:string(fields.principle),weight:13},
      {name:"ratio",text:string(fields.ratio),weight:12},
      {name:"holding",text:string(fields.holding),weight:11},
      {name:"issues",text:string(fields.issues),weight:10},
      {name:"provisions",text:provisions.map((item)=>`${string(item.law_label)} ${string(item.display)} ${string(item.proposition)}`).join(" "),weight:12},
      {name:"concepts",text:smartTags.flatMap((tag)=>[string(tag.label),...(Array.isArray(tag.aliases)?tag.aliases.map(String):[])]).join(" "),weight:12},
      {name:"facts",text:string(fields.facts),weight:6},
    ]);
    if(precisionSyntax&&exactScore<=0)return [];
    return [{
      ...hit,
      ...document,
      id: caseId,
      caseId,
      name: string(document.title || hit.title),
      shortName: string(document.short_title || hit.short_title),
      decisionDate: document.decision_date,
      decisionYear: document.decision_year,
      caseNumber: string(document.case_number || hit.case_number),
      courtLevel: string(document.court_level),
      caseFamily: string(document.case_family),
      legalArea: string(document.primary_legal_area),
      legalAreas: document.legal_areas,
      proceedingType: string(document.proceeding_type),
      proceduralPosture: string(document.procedural_posture),
      readinessScore: Number(document.readiness_score || hit.readiness_score || 0),
      strictReady: Boolean(document.strict_ready),
      humanReviewRequired: Boolean(document.human_review_required),
      authorityTier: string(document.precedential_tier),
      precedentialWeight: {
        score: Number(document.precedential_score || 0),
        tier: string(document.precedential_tier || "Low"),
        factors: object(document.precedential_factors),
      },
      legalPrinciple: string(fields.principle || fields.ratio || fields.holding),
      legalIssue: string(fields.issues),
      factsSummary: string(fields.facts),
      snippet: string(fields.principle || fields.ratio || fields.holding || fields.issues || fields.facts),
      whyMatched: searchMatchReasons(document, hit, query),
      issueTags,
      smartTags,
      provisions,
      lawIds: document.law_ids,
      provisionKeys: document.provision_keys,
      lexicalPrecisionScore:Math.max(exactScore,weighted.score),
      _hybridRank:index,
    }];
  });
  const ranked=cases.sort((left,right)=>Number(right.lexicalPrecisionScore||0)-Number(left.lexicalPrecisionScore||0)||Number(left._hybridRank||0)-Number(right._hybridRank||0)).slice(0,requestedLimit).map(({_hybridRank,...item})=>item);
  return { ok:true, query, semanticUsed:Boolean(vector), semanticDegraded, precisionSyntax, cases:ranked };
}

type EvidencePassage = { paragraphId: string; quote: string };

function normalizeForMatch(value: string): string {
  return value.toLocaleLowerCase("el").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ς/g, "σ").replace(/\s+/g, " ").trim();
}

function collectEvidence(value: unknown, output: EvidencePassage[], seen: Set<string>, depth = 0): void {
  if (depth > 9 || output.length >= 240) return;
  if (Array.isArray(value)) {
    for (const item of value) collectEvidence(item, output, seen, depth + 1);
    return;
  }
  const row = object(value);
  if (!Object.keys(row).length) return;
  const quote = string(row.quote);
  const paragraphIds = Array.isArray(row.paragraphIds) ? row.paragraphIds.map(string).filter(Boolean) : [];
  if (quote && paragraphIds.length) {
    const key = `${paragraphIds.join(",")}|${normalizeForMatch(quote)}`;
    if (!seen.has(key)) {
      seen.add(key);
      output.push({ paragraphId: paragraphIds.join("–"), quote });
    }
  }
  for (const nested of Object.values(row)) collectEvidence(nested, output, seen, depth + 1);
}

function relevantPassages(question: string, passages: EvidencePassage[]): EvidencePassage[] {
  const tokens = [...new Set(normalizeForMatch(question).split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 3))];
  return passages
    .map((passage, index) => {
      const normalized = normalizeForMatch(passage.quote);
      const score = tokens.reduce((sum, token) => sum + (normalized.includes(token) ? 1 : 0), 0);
      return { passage, index, score };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 28)
    .sort((left, right) => left.index - right.index)
    .map(({ passage }) => passage);
}

function responseText(payload: Record<string, unknown>): string {
  const direct = string(payload.output_text);
  if (direct) return direct;
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    const content = Array.isArray(object(item).content) ? object(item).content as unknown[] : [];
    for (const part of content) {
      const row = object(part);
      if (string(row.type) === "output_text" && string(row.text)) return string(row.text);
    }
  }
  return "";
}

async function chat(payload: Record<string, unknown>): Promise<unknown> {
  if (!OPENAI_KEY) throw new ApiError(503, "OPENAI_NOT_CONFIGURED", "The case assistant is not configured.");
  const question = string(payload.question);
  if (!question) throw new ApiError(400, "QUESTION_REQUIRED", "Ask a question before sending the case assistant request.");
  if (question.length > 6000) throw new ApiError(413, "QUESTION_TOO_LONG", "The question is too long.");
  const caseIds = [...new Set((Array.isArray(payload.caseIds) ? payload.caseIds : [payload.caseId]).map(string).filter((id) => /^[0-9a-f-]{36}$/i.test(id)))].slice(0, 4);
  if (!caseIds.length) throw new ApiError(400, "CASE_REQUIRED", "Select at least one case.");

  const { data: caseRows, error: caseError } = await db.schema("nomologies").from("cases")
    .select("id,case_name,citation,case_number,decision_date,court,outcome,source_hash,source_url,publication_status,case_versions!cases_current_version_fk(canonical_record,readiness_score,strict_ready)")
    .in("id", caseIds)
    .eq("publication_status", "published");
  if (caseError) throw new ApiError(500, "CASE_CHAT_READ_FAILED", caseError.message);
  if (!caseRows?.length || caseRows.length !== caseIds.length) {
    throw new ApiError(403, "PUBLISHED_CASE_REQUIRED", "The assistant is available only for published judgments.");
  }
  for (const row of caseRows) {
    try { canonicalJudgmentUrl(string(row.source_url)); }
    catch { throw new ApiError(403, "OFFICIAL_SOURCE_REQUIRED", "The assistant is available only for published judgments from the official CyLaw source."); }
  }

  const sourceHashes = array(caseRows).map((row) => string(row.source_hash)).filter(Boolean);
  const { data: sources, error: sourceError } = sourceHashes.length
    ? await db.schema("nomologies").from("source_documents").select("source_hash,clean_text,paragraph_count").in("source_hash", sourceHashes)
    : { data: [], error: null };
  if (sourceError) throw new ApiError(500, "CASE_CHAT_SOURCE_FAILED", sourceError.message);
  const sourceByHash = new Map(array(sources).map((row) => [string(row.source_hash), string(row.clean_text)]));

  const evidenceBank: EvidencePassage[] = [];
  const seenEvidence = new Set<string>();
  const records = array(caseRows).map((row) => {
    const relationValue = row.case_versions;
    const relation = object(Array.isArray(relationValue) ? relationValue[0] : relationValue);
    const canonical = object(relation.canonical_record);
    collectEvidence(canonical, evidenceBank, seenEvidence);
    const cleanText = sourceByHash.get(string(row.source_hash)) || "";
    if (cleanText) {
      cleanText.split(/\n{2,}/).map((quote) => quote.trim()).filter((quote) => quote.length >= 40).slice(0, 500).forEach((quote, index) => {
        const key = normalizeForMatch(quote);
        if (!seenEvidence.has(key)) {
          seenEvidence.add(key);
          evidenceBank.push({ paragraphId: `SOURCE-${String(index + 1).padStart(4, "0")}`, quote });
        }
      });
    }
    return {
      id: row.id,
      caseName: row.case_name,
      citation: row.citation,
      caseNumber: row.case_number,
      decisionDate: row.decision_date,
      court: row.court,
      outcome: row.outcome,
      publicationStatus: row.publication_status,
      readinessScore: relation.readiness_score,
      strictReady: relation.strict_ready,
    };
  });
  const passages = relevantPassages(question, evidenceBank);
  const conversation = (Array.isArray(payload.messages) ? payload.messages : [])
    .map(object)
    .filter((message) => ["user", "assistant"].includes(string(message.role)) && string(message.content))
    .slice(-10)
    .map((message) => ({ role: string(message.role), content: string(message.content).slice(0, 5000) }));

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CHAT_MODEL,
      instructions: "You are My Nomos AI, a Cyprus case-law research assistant. Answer only from the supplied public CyLaw case identity and relevant verified passages. Never invent facts, holdings, statutes, authorities, quotations, or paragraph references. Distinguish the court's holding from party submissions and quoted authorities. If the passages do not establish the answer, say so plainly. Answer in the language of the user's question. Use concise legal analysis and cite every material proposition with the supplied paragraph ID in square brackets. Return only the required JSON object.",
      input: [{
        role: "user",
        content: JSON.stringify({ currentQuestion: question, conversation, cases: records, sourcePassages: passages }),
      }],
      reasoning: { effort: "low" },
      max_output_tokens: 2600,
      text: {
        format: {
          type: "json_schema",
          name: "nomologies_case_answer",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              answer: { type: "string" },
              sources: {
                type: "array",
                maxItems: 8,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: { paragraphId: { type: "string" }, quote: { type: "string" } },
                  required: ["paragraphId", "quote"],
                },
              },
              limited: { type: "boolean" },
              warning: { type: "string" },
            },
            required: ["answer", "sources", "limited", "warning"],
          },
        },
      },
    }),
  });
  const openaiPayload = object(await response.json().catch(() => ({})));
  if (!response.ok) {
    const message = string(object(openaiPayload.error).message) || `OpenAI returned HTTP ${response.status}.`;
    throw new ApiError(502, "OPENAI_CHAT_FAILED", message);
  }
  const rawText = responseText(openaiPayload);
  let result: Record<string, unknown>;
  try { result = object(JSON.parse(rawText)); }
  catch { throw new ApiError(502, "OPENAI_CHAT_INVALID_RESPONSE", "The case assistant returned an invalid response."); }

  const validSources = array(result.sources).flatMap((source) => {
    const paragraphId = string(source.paragraphId);
    const quote = string(source.quote);
    const candidate = evidenceBank.find((passage) => passage.paragraphId === paragraphId && normalizeForMatch(passage.quote).includes(normalizeForMatch(quote)));
    return candidate && quote ? [{ paragraphId, quote }] : [];
  });
  return {
    ok: true,
    answer: string(result.answer),
    sources: validSources,
    sourceStrict: true,
    limited: Boolean(result.limited) || validSources.length === 0,
    warning: string(result.warning),
    model: CHAT_MODEL,
  };
}
async function runStatus(runId: string): Promise<unknown> {
  const { data:run,error } = await db.schema("nomologies").from("pipeline_runs").select("*").eq("id",runId).maybeSingle();
  if (error) throw new ApiError(500,"RUN_READ_FAILED",error.message);
  if (!run) throw new ApiError(404,"RUN_NOT_FOUND","Pipeline run not found.");
  const { data:tasks } = await db.schema("nomologies").from("pipeline_tasks").select("id,stage,status,attempt_count,max_attempts,last_error_code,last_error_message,created_at,started_at,completed_at").eq("run_id",runId).order("created_at");
  if (["queued","running"].includes(run.status)) edgeRuntimeWaitUntil(kickWorkerIfIdle());
  return {ok:true,run,tasks:tasks||[]};
}
async function batchStatus(batchId: string): Promise<unknown> {
  const { data:gate,error:gateError } = await db.schema("nomologies").rpc("refresh_bulk_batch_gate", { p_batch_id: batchId });
  if (gateError) throw new ApiError(500,"BATCH_GATE_READ_FAILED",gateError.message);
  const { data:batch,error } = await db.schema("nomologies").from("bulk_batches").select("*").eq("id",batchId).maybeSingle();
  if (error) throw new ApiError(500,"BATCH_READ_FAILED",error.message);
  if (!batch) throw new ApiError(404,"BATCH_NOT_FOUND","Bulk batch not found.");
  const { data:items } = await db.schema("nomologies").from("bulk_items").select("id,ordinal,source_url,source_title,status,current_stage,progress,attempt_count,last_error_code,last_error_message,case_id,pipeline_run_id,result_summary,updated_at").eq("batch_id",batchId).order("ordinal");
  const caseIds = [...new Set((items||[]).map((item: Record<string, unknown>) => string(item.case_id)).filter(Boolean))];
  const publicationByCase = new Map<string,Record<string,unknown>>();
  const indexedVersionByCase = new Map<string,string>();
  if (caseIds.length) {
    const [{ data:caseRows,error:caseStatusError },{ data:indexRows,error:indexStatusError }] = await Promise.all([
      db.schema("nomologies").from("cases").select("id,publication_status,current_version_id,pending_version_id,pending_run_id").in("id",caseIds),
      db.schema("nomologies").from("case_search_documents").select("case_id,case_version_id").in("case_id",caseIds),
    ]);
    if (caseStatusError) throw new ApiError(500,"BATCH_CASE_STATUS_FAILED",caseStatusError.message);
    if (indexStatusError) throw new ApiError(500,"BATCH_INDEX_STATUS_FAILED",indexStatusError.message);
    for (const row of caseRows||[]) publicationByCase.set(string(row.id),row);
    for (const row of indexRows||[]) indexedVersionByCase.set(string(row.case_id),string(row.case_version_id));
  }
  const visibleItems = (items||[]).map((item: Record<string, unknown>) => {
    const caseState = publicationByCase.get(string(item.case_id));
    const publicationStatus = string(caseState?.publication_status);
    const currentVersionId = string(caseState?.current_version_id);
    const indexedVersionId = indexedVersionByCase.get(string(item.case_id)) || "";
    const searchable = Boolean(currentVersionId && indexedVersionId === currentVersionId);
    const reprocessRunId = string(object(object(item.result_summary).reprocess).runId);
    const pendingOrProcessing = Boolean(caseState?.pending_version_id) || Boolean(reprocessRunId && reprocessRunId === string(item.pipeline_run_id) && string(item.status) !== "published");
    if (pendingOrProcessing) {
      if (["review","strict_ready"].includes(string(item.status)) && Number(item.progress || 0) >= 100) return {...item,last_error_code:"",last_error_message:""};
      return item;
    }
    if (publicationStatus !== "published") {
      // Historical retries could leave a transient provider message on a row
      // that later reached a completed review state. Completion wins: only a
      // currently blocked/dead-letter item may expose a pipeline error.
      if (["review", "strict_ready"].includes(string(item.status)) && Number(item.progress || 0) >= 100) {
        return {...item,last_error_code:"",last_error_message:""};
      }
      return item;
    }
    if (!searchable) {
      return {...item,status:"indexing",current_stage:"embeddings",progress:Math.min(98,Math.max(92,Number(item.progress||0))),last_error_code:"",last_error_message:""};
    }
    return {...item,status:"published",current_stage:"publish",progress:100,last_error_code:"",last_error_message:""};
  });
  if (["queued","running","fetching"].includes(batch.status)) edgeRuntimeWaitUntil(kickWorkerIfIdle());
  return {ok:true,batch,items:visibleItems,gate:object(gate)};
}
async function latestBatchStatus(): Promise<unknown> {
  const { data,error } = await db.schema("nomologies").from("bulk_batches").select("id").order("created_at",{ascending:false}).limit(1).maybeSingle();
  if (error) throw new ApiError(500,"BATCH_READ_FAILED",error.message);
  if (!data?.id) return {ok:true,batch:null,items:[],gate:{}};
  return batchStatus(String(data.id));
}

async function reprocessCase(caseId: string, payload: Record<string, unknown>): Promise<unknown> {
  const { data: caseRow, error: caseError } = await db.schema("nomologies").from("cases")
    .select("id,source_hash,source_url,case_name,publication_status,current_version_id")
    .eq("id", caseId)
    .maybeSingle();
  if (caseError) throw new ApiError(500, "CASE_READ_FAILED", caseError.message);
  if (!caseRow) throw new ApiError(404, "CASE_NOT_FOUND", "Case not found.");
  canonicalJudgmentUrl(string(caseRow.source_url));

  let batchId: string | null = null;
  let bulkItemId: string | null = null;
  let sourceDocumentId: string | null = null;
  if (caseRow.current_version_id) {
    const { data: currentVersion, error: versionError } = await db.schema("nomologies").from("case_versions")
      .select("run_id,pipeline_runs!case_versions_run_id_fkey(batch_id,bulk_item_id,source_document_id)")
      .eq("id", caseRow.current_version_id)
      .maybeSingle();
    if (versionError) throw new ApiError(500, "CASE_VERSION_READ_FAILED", versionError.message);
    const priorRun = object(currentVersion?.pipeline_runs);
    batchId = string(priorRun.batch_id) || null;
    bulkItemId = string(priorRun.bulk_item_id) || null;
    sourceDocumentId = string(priorRun.source_document_id) || null;
  }
  if (!bulkItemId) {
    const { data: bulkItem, error: bulkError } = await db.schema("nomologies").from("bulk_items")
      .select("id,batch_id,source_document_id")
      .eq("case_id", caseId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (bulkError) throw new ApiError(500, "CASE_BULK_READ_FAILED", bulkError.message);
    bulkItemId = string(bulkItem?.id) || null;
    batchId = string(bulkItem?.batch_id) || batchId;
    sourceDocumentId = string(bulkItem?.source_document_id) || sourceDocumentId;
  }

  let sourceQuery = db.schema("nomologies").from("source_documents")
    .select("id,source_url,source_title,source_kind,original_storage_path");
  sourceQuery = sourceDocumentId
    ? sourceQuery.eq("id", sourceDocumentId)
    : sourceQuery.eq("source_hash", caseRow.source_hash);
  const { data: source, error: sourceError } = await sourceQuery.maybeSingle();
  if (sourceError) throw new ApiError(500, "CASE_SOURCE_READ_FAILED", sourceError.message);
  if (!source) throw new ApiError(409, "CASE_SOURCE_MISSING", "The stored source document for this case is missing.");

  const { data: activeRuns, error: activeRunError } = await db.schema("nomologies").from("pipeline_runs")
    .select("id,status,bulk_item_id,stage_state")
    .eq("source_document_id", source.id)
    .in("status", ["queued", "running"])
    .order("created_at", { ascending: false })
    .limit(10);
  if (activeRunError) throw new ApiError(500, "REPROCESS_CHECK_FAILED", activeRunError.message);
  const existing = array(activeRuns).find((run) => {
    const recordedCaseId = string(object(object(run.stage_state).reprocess).caseId);
    return recordedCaseId === caseId || Boolean(bulkItemId && string(run.bulk_item_id) === bulkItemId);
  });
  if (existing) {
    edgeRuntimeWaitUntil(kickWorkerIfIdle());
    return { ok: true, caseId, runId: existing.id, bulkItemId: existing.bulk_item_id || null, existing: true };
  }

  const requestedAt = new Date().toISOString();
  const autoPublish = payload.autoPublish === true && string(caseRow.publication_status) === "published";
  const { data: run, error: runError } = await db.schema("nomologies").from("pipeline_runs").insert({
    batch_id: batchId,
    bulk_item_id: bulkItemId,
    source_document_id: source.id,
    status: "queued",
    current_stage: "source",
    stage_state: {
      createdBy: "case-reprocess",
      reprocess: {
        caseId,
        previousCaseVersionId: caseRow.current_version_id,
        previousPublicationStatus: caseRow.publication_status,
        autoPublish,
        refetch: payload.refetch !== false,
        requestedAt,
      },
    },
  }).select("id").single();
  if (runError || !run) throw new ApiError(500, "REPROCESS_RUN_CREATE_FAILED", runError?.message || "The reprocessing run could not be created.");

  const { error: taskError } = await db.schema("nomologies").from("pipeline_tasks").insert({
    run_id: run.id,
    batch_id: batchId,
    bulk_item_id: bulkItemId,
    stage: "source",
    status: "queued",
    priority: 110,
    payload: {
      sourceDocumentId: source.id,
      sourceUrl: source.source_url,
      sourceTitle: source.source_title || caseRow.case_name,
      sourceKind: source.source_kind || "cylaw_url",
      cleanText: "",
      originalStoragePath: source.original_storage_path || "",
      forceRefetch: true,
      reprocessCaseId: caseId,
    },
  });
  if (taskError) {
    await db.schema("nomologies").from("pipeline_runs").update({
      status: "failed",
      error_code: "REPROCESS_TASK_CREATE_FAILED",
      error_message: taskError.message,
      completed_at: new Date().toISOString(),
    }).eq("id", run.id);
    throw new ApiError(500, "REPROCESS_TASK_CREATE_FAILED", taskError.message);
  }

  if (bulkItemId) {
    const { data: bulkItem } = await db.schema("nomologies").from("bulk_items")
      .select("result_summary")
      .eq("id", bulkItemId)
      .maybeSingle();
    await db.schema("nomologies").from("bulk_items").update({
      pipeline_run_id: run.id,
      status: "processing",
      current_stage: "source",
      progress: 0,
      attempt_count: 0,
      last_error_code: "",
      last_error_message: "",
      result_summary: {
        ...object(bulkItem?.result_summary),
        reprocess: { runId: run.id, requestedAt, autoPublish },
      },
    }).eq("id", bulkItemId);
  }

  await db.schema("nomologies").from("pipeline_events").insert({
    run_id: run.id,
    batch_id: batchId,
    bulk_item_id: bulkItemId,
    level: "info",
    event_type: "case_reprocess_requested",
    message: "Full case reprocessing requested from the official source.",
    data: { caseId, previousCaseVersionId: caseRow.current_version_id, autoPublish },
  });
  edgeRuntimeWaitUntil(kickWorkerIfIdle());
  return { ok: true, caseId, runId: run.id, bulkItemId, existing: false, autoPublish };
}

async function nextBatchWindow(batchId: string): Promise<unknown> {
  const { data,error } = await db.schema("nomologies").rpc("activate_bulk_window", {
    p_batch_id: batchId,
    p_limit: BULK_WINDOW_SIZE,
  });
  if (error) {
    const message = string(error.message) || "The next review window could not be activated.";
    const gateBlocked = /not completed|strict readiness review/i.test(message);
    throw new ApiError(gateBlocked ? 409 : 500,gateBlocked ? "BATCH_GATE_NOT_READY" : "BATCH_ADVANCE_FAILED",message);
  }
  edgeRuntimeWaitUntil(kickWorkerIfIdle());
  const gate = object(data);
  return {
    ok:true,
    batchId,
    activated:Number(gate.activated || 0),
    gate,
  };
}

const REVIEW_FIELD_PATHS: Record<string, string> = {
  caseName: "identity.caseName",
  shortName: "identity.shortName",
  caseNumber: "identity.caseNumber",
  citation: "identity.citation",
  ecli: "identity.ecli",
  decisionDate: "identity.decisionDate",
  court: "identity.court",
  primaryLegalArea: "classification.primaryLegalArea",
  proceedingType: "classification.proceedingType",
  outcome: "outcome.overallOutcome",
  legalPrinciple: "analysis.legalPrincipleSummary",
  legalIssue: "analysis.dominantIssue",
  holding: "analysis.holding",
};

const REVIEW_GREEK_STOPWORDS = new Set([
  "και", "ή", "η", "ο", "οι", "τα", "το", "του", "της", "των", "τον", "την", "τις", "τους",
  "σε", "στο", "στη", "στην", "στον", "στα", "με", "για", "από", "προς", "κατά", "περί",
  "ως", "ότι", "που", "να", "ένα", "μια", "ένας", "αυτή", "αυτό", "άλλων", "άλλου",
]);

function setReviewedField(record: Record<string, unknown>, path: string, nextValue: unknown): void {
  const parts = path.split(".");
  let current = record;
  for (const part of parts.slice(0, -1)) {
    const nested = object(current[part]);
    current[part] = nested;
    current = nested;
  }
  const key = parts[parts.length - 1];
  const prior = object(current[key]);
  current[key] = {
    ...prior,
    status: "available",
    value: nextValue,
    confidence: 1,
    humanReviewed: true,
  };
}

function canonicalValueAt(record: Record<string, unknown>, path: string, fallback: unknown = ""): unknown {
  const wrapped = path.split(".").reduce<unknown>((current, key) => object(current)[key], record);
  return object(wrapped).status === "available" ? object(wrapped).value : fallback;
}

function reviewedGreekTags(value: unknown): string[] {
  const output = new Map<string, string>();
  const supplied = Array.isArray(value) ? value : [];
  for (const entry of supplied) {
    const label = String(entry || "").normalize("NFC").trim();
    if (!/^[Α-Ωα-ωΆ-Ώά-ώΐΰϊϋ]{3,}$/u.test(label)) continue;
    const lower = label.toLocaleLowerCase("el");
    const key = lower.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ς/g, "σ");
    if (REVIEW_GREEK_STOPWORDS.has(lower) || output.has(key)) continue;
    output.set(key, label);
  }
  return [...output.values()].slice(0, 40);
}

function applyReviewCorrections(canonical: Record<string, unknown>, corrections: Record<string, unknown>): { record: Record<string, unknown>; correctedFields: string[] } {
  const record = structuredClone(canonical);
  const correctedFields: string[] = [];
  for (const [inputKey, path] of Object.entries(REVIEW_FIELD_PATHS)) {
    if (!(inputKey in corrections)) continue;
    const next = string(corrections[inputKey]);
    if (next.length > 20_000) throw new ApiError(400, "CORRECTION_TOO_LARGE", `${inputKey} is too large.`);
    setReviewedField(record, path, next);
    correctedFields.push(path);
  }

  if (Array.isArray(corrections.smartTags)) {
    const taxonomy = object(record.taxonomy);
    taxonomy.issueTags = reviewedGreekTags(corrections.smartTags);
    record.taxonomy = taxonomy;
    correctedFields.push("taxonomy.issueTags");
  }

  if (Array.isArray(corrections.citedCases)) {
    const existing = array(canonicalValueAt(record, "authorities.authorities", []));
    const citedCases = array(corrections.citedCases).slice(0, 250).map((authority, index) => {
      const prior = existing[index] || {};
      return {
        ...prior,
        name: string(authority.name),
        citation: string(authority.citation),
        treatment: string(authority.treatment) || string(prior.treatment) || "cited",
        legalPoint: string(authority.legalPoint),
      };
    }).filter((authority) => authority.name || authority.citation);
    setReviewedField(record, "authorities.authorities", citedCases);
    correctedFields.push("authorities.authorities");
  }

  const now = new Date().toISOString();
  record.updatedAt = now;
  record.humanReview = {
    ...object(record.humanReview),
    reviewedAt: now,
    correctedFields,
  };
  const issue = string(canonicalValueAt(record,"analysis.dominantIssue",""));
  const principle = string(canonicalValueAt(record,"analysis.legalPrincipleSummary",""));
  if (issue && principle.startsWith(issue)) {
    const remainder = principle.slice(issue.length).replace(/^[\s.;:—–-]+/u,"").trim();
    if (remainder.length >= 30) setReviewedField(record,"analysis.legalPrincipleSummary",remainder);
  }
  return { record, correctedFields };
}

const REVIEW_MONTHS: Record<string, string> = {
  ιανουαριου:"01", φεβρουαριου:"02", μαρτιου:"03", απριλιου:"04", μαιου:"05", ιουνιου:"06",
  ιουλιου:"07", αυγουστου:"08", σεπτεμβριου:"09", οκτωβριου:"10", νοεμβριου:"11", δεκεμβριου:"12",
};

function reviewDateValue(raw: string): string | null {
  const iso = raw.match(/\b(20\d{2}|19\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const folded = raw.toLocaleLowerCase("el").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const greek = folded.match(/\b(\d{1,2})\s+([α-ω]+)[,\s]+(20\d{2}|19\d{2})\b/u);
  if (greek && REVIEW_MONTHS[greek[2]]) return `${greek[3]}-${REVIEW_MONTHS[greek[2]]}-${greek[1].padStart(2,"0")}`;
  return null;
}

function reviewedCaseFields(record: Record<string, unknown>, caseRow: Record<string, unknown>): Record<string, unknown> {
  const at = (path: string, fallback: unknown) => canonicalValueAt(record,path,fallback);
  const decisionText = string(at("identity.decisionDate",caseRow.decision_date_text || ""));
  const legalAreas = at("classification.legalAreas",caseRow.legal_areas);
  const judges = at("identity.judges",caseRow.judges);
  const authoringJudges = at("identity.authoringJudges",caseRow.authoring_judges);
  return {
    case_name:string(at("identity.caseName",caseRow.case_name)),
    short_name:string(at("identity.shortName",caseRow.short_name)),
    citation:string(at("identity.citation",caseRow.citation)),
    ecli:string(at("identity.ecli",caseRow.ecli)),
    case_number:string(at("identity.caseNumber",caseRow.case_number)),
    docket:string(at("identity.docket",caseRow.docket)),
    decision_date:reviewDateValue(decisionText) || string(caseRow.decision_date) || null,
    decision_date_text:decisionText,
    decision_year:Number((decisionText.match(/(19|20)\d{2}/)||[])[0])||Number(caseRow.decision_year)||null,
    court:string(at("identity.court",caseRow.court)),
    court_level:string(at("classification.courtLevel",caseRow.court_level)),
    jurisdiction:string(at("identity.jurisdiction",caseRow.jurisdiction || "Cyprus")),
    case_family:string(at("classification.caseFamily",caseRow.case_family)),
    primary_legal_area:string(at("classification.primaryLegalArea",caseRow.primary_legal_area)),
    legal_areas:Array.isArray(legalAreas)?legalAreas:caseRow.legal_areas,
    proceeding_type:string(at("classification.proceedingType",caseRow.proceeding_type)),
    procedural_posture:string(at("classification.proceduralPosture",caseRow.procedural_posture)),
    outcome:string(at("outcome.overallOutcome",caseRow.outcome)),
    judges:Array.isArray(judges)?judges.map((judge) => string(object(judge).name || judge)).filter(Boolean):caseRow.judges,
    authoring_judges:Array.isArray(authoringJudges)?authoringJudges.map(String).filter(Boolean):caseRow.authoring_judges,
  };
}

function publicationGateState(
  record: Record<string, unknown>,
  version: Record<string, unknown>,
): { readinessScore: number; strictReady: boolean; blockers: string[] } {
  const unresolved = array(record.conflicts)
    .filter((conflict) => ["critical","material"].includes(string(conflict.severity)))
    .map((conflict) => `${string(conflict.code) || "UNRESOLVED_BLOCKER"}: ${string(conflict.message) || string(conflict.fieldPath)}`);
  const readinessScore = Number(record.readinessScore ?? version.readiness_score ?? 0);
  const strictReady = Boolean(record.strictReady ?? version.strict_ready);
  if (readinessScore < 90) unresolved.unshift(`READINESS_BELOW_THRESHOLD: ${readinessScore}/100 (required: 90/100)`);
  if (!strictReady) unresolved.unshift("STRICT_READINESS_NOT_MET: the canonical record has not passed every publication gate");
  return { readinessScore, strictReady, blockers: [...new Set(unresolved)] };
}

async function approveCase(caseId: string, payload: Record<string, unknown>, req: Request): Promise<unknown> {
  const decision = string(payload.decision) || "approve";
  if (!['approve','request_changes','reject','withdraw'].includes(decision)) throw new ApiError(400,"INVALID_DECISION","Invalid review decision.");
  const { data:caseRow,error } = await db.schema("nomologies").from("cases").select("*").eq("id",caseId).maybeSingle();
  if (error) throw new ApiError(500,"CASE_READ_FAILED",error.message);
  if (!caseRow) throw new ApiError(404,"CASE_NOT_FOUND","Case not found.");
  const reviewVersionId = string(caseRow.pending_version_id || caseRow.current_version_id);
  const hasPendingCandidate = Boolean(caseRow.pending_version_id);
  if (!reviewVersionId) throw new ApiError(409,"CASE_VERSION_MISSING","Case has no extraction version awaiting review.");

  const corrections = object(payload.corrections);
  let correctedFields: string[] = [];
  const { data:version,error:versionError } = await db.schema("nomologies").from("case_versions")
    .select("canonical_record,reviewer_record,readiness_score,strict_ready,run_id")
    .eq("id",reviewVersionId)
    .maybeSingle();
  if (versionError) throw new ApiError(500,"CASE_VERSION_READ_FAILED",versionError.message);
  if (!version) throw new ApiError(409,"CASE_VERSION_MISSING","Case extraction version not found.");
  let reviewedRecord = object(version.canonical_record);
  let reviewerRecord = object(version.reviewer_record);
  if (Object.keys(corrections).length) {
    const corrected = applyReviewCorrections(reviewedRecord,corrections);
    reviewedRecord = corrected.record;
    correctedFields = corrected.correctedFields;
    if (correctedFields.length) {
      reviewerRecord = {...reviewerRecord,humanCorrections:{at:new Date().toISOString(),fields:correctedFields}};
      const { error:versionUpdateError } = await db.schema("nomologies").from("case_versions").update({
        canonical_record:reviewedRecord,
        reviewer_record:reviewerRecord,
        human_review_required:decision!=="approve",
      }).eq("id",reviewVersionId);
      if (versionUpdateError) throw new ApiError(500,"CASE_CORRECTION_FAILED",versionUpdateError.message);
      if (!hasPendingCandidate) {
        const { error:caseCorrectionError } = await db.schema("nomologies").from("cases").update({...reviewedCaseFields(reviewedRecord,caseRow),human_review_required:decision!=="approve"}).eq("id",caseId);
        if (caseCorrectionError) throw new ApiError(500,"CASE_CORRECTION_FAILED",caseCorrectionError.message);
      }
    }
  }

  const now = new Date().toISOString();
  const gate = publicationGateState(reviewedRecord,version);
  const wantsPublication = decision === "approve" && payload.publish !== false;
  const wantsManualOverride = wantsPublication && payload.manualOverride === true;
  const reviewerName = string(payload.reviewerName) || "Nomologies reviewer";
  let manualPublicationOverride: Record<string, unknown> | null = null;
  if (wantsPublication && gate.blockers.length && !wantsManualOverride) {
    throw new ApiError(
      409,
      "PUBLICATION_GATE_BLOCKED",
      `Publication prohibited. ${gate.blockers.join(" | ")}`,
      {...gate,canManualOverride:true},
    );
  }
  if (wantsManualOverride && gate.blockers.length) {
    const overrideReason = string(payload.overrideReason);
    if (payload.overrideAcknowledged !== true) {
      throw new ApiError(400,"MANUAL_OVERRIDE_ACKNOWLEDGEMENT_REQUIRED","Manual publication requires explicit acknowledgement of the unresolved blockers.",gate);
    }
    if (overrideReason.length < 12) {
      throw new ApiError(400,"MANUAL_OVERRIDE_REASON_REQUIRED","Give a specific reason of at least 12 characters for the manual publication override.",gate);
    }
    manualPublicationOverride = {
      applied:true,
      appliedAt:now,
      actor:string(req.headers.get("x-nomologies-actor-email")) || reviewerName,
      reviewerName,
      reason:overrideReason,
      readinessScore:gate.readinessScore,
      strictReady:gate.strictReady,
      blockers:gate.blockers,
      caseVersionId:reviewVersionId,
    };
    reviewedRecord.humanReview = {
      ...object(reviewedRecord.humanReview),
      reviewedAt:now,
      publicationMode:"manual_override",
      manualPublicationOverride,
    };
    reviewerRecord = {...reviewerRecord,manualPublicationOverride};
    const { error:overrideAuditError } = await db.schema("nomologies").from("case_versions").update({
      canonical_record:reviewedRecord,
      reviewer_record:reviewerRecord,
      human_review_required:false,
    }).eq("id",reviewVersionId);
    if (overrideAuditError) throw new ApiError(500,"MANUAL_OVERRIDE_AUDIT_FAILED",overrideAuditError.message);
  }

  const decisionCorrections = manualPublicationOverride
    ? {...corrections,__manualPublicationOverride:manualPublicationOverride}
    : corrections;
  const { error:decisionError } = await db.schema("nomologies").from("review_decisions").insert({
    case_id:caseId,case_version_id:reviewVersionId,decision,
    reviewer_name:reviewerName,notes:string(payload.notes),corrections:decisionCorrections,
    signature_hash:await sha256(`${caseId}|${reviewVersionId}|${decision}|${now}|${JSON.stringify(decisionCorrections)}|${req.headers.get("authorization")||""}`),
  });
  if (decisionError) throw new ApiError(500,"REVIEW_DECISION_FAILED",decisionError.message);
  let publicationStatus = string(caseRow.publication_status);
  const update: Record<string,unknown> = {};
  if (decision === "approve") {
    publicationStatus = payload.publish === false ? "approved" : "published";
    Object.assign(update,reviewedCaseFields(reviewedRecord,caseRow),{
      current_version_id:reviewVersionId,
      publication_status:publicationStatus,
      approved_at:now,
      human_review_required:false,
      readiness_score:version.readiness_score,
      strict_ready:version.strict_ready,
      pending_version_id:null,pending_run_id:null,pending_readiness_score:null,pending_strict_ready:null,pending_created_at:null,
    });
    if (publicationStatus === "published") update.published_at = now;
  } else if (decision === "request_changes") {
    if (!hasPendingCandidate) publicationStatus = "review";
    Object.assign(update,{publication_status:publicationStatus,human_review_required:true});
  } else if (decision === "reject" && hasPendingCandidate) {
    Object.assign(update,{human_review_required:false,pending_version_id:null,pending_run_id:null,pending_readiness_score:null,pending_strict_ready:null,pending_created_at:null});
  } else if (decision === "withdraw") {
    publicationStatus = "withdrawn";
    Object.assign(update,{publication_status:publicationStatus,human_review_required:false,pending_version_id:null,pending_run_id:null,pending_readiness_score:null,pending_strict_ready:null,pending_created_at:null});
  } else {
    publicationStatus = "review";
    Object.assign(update,{publication_status:publicationStatus,human_review_required:true});
  }
  const { error:updateError } = await db.schema("nomologies").from("cases").update(update).eq("id",caseId);
  if (updateError) throw new ApiError(500,"CASE_APPROVAL_FAILED",updateError.message);
  await db.schema("nomologies").from("case_versions").update({human_review_required:decision==="request_changes"}).eq("id",reviewVersionId);
  if (decision === "approve") {
    const { data:run } = await db.schema("nomologies").from("case_versions").select("run_id,pipeline_runs!case_versions_run_id_fkey(batch_id,bulk_item_id)").eq("id",reviewVersionId).maybeSingle();
    if (run?.run_id) {
      const runMeta = object(run.pipeline_runs);
      await db.schema("nomologies").from("pipeline_tasks").upsert({run_id:run.run_id,batch_id:runMeta.batch_id||null,bulk_item_id:runMeta.bulk_item_id||null,stage:"embeddings",status:"queued",priority:90,payload:{caseId,caseVersionId:reviewVersionId,publish:publicationStatus==="published"},attempt_count:0,available_at:new Date().toISOString(),locked_at:null,locked_until:null,locked_by:"",last_error_code:"",last_error_message:""}, {onConflict:"run_id,stage"});
      if (runMeta.bulk_item_id) {
        await db.schema("nomologies").from("bulk_items").update({
          status:publicationStatus==="published"?"processing":"strict_ready",
          current_stage:publicationStatus==="published"?"embeddings":"review",
          progress:publicationStatus==="published"?92:100,
          last_error_code:"",
          last_error_message:"",
        }).eq("id",runMeta.bulk_item_id);
      }
      edgeRuntimeWaitUntil(kickWorkerIfIdle());
    }
  }
  return {
    ok:true,caseId,caseVersionId:reviewVersionId,decision,publicationStatus,
    searchStatus:publicationStatus==="published"?"indexing":publicationStatus,
    correctedFields,
    publicationMode:manualPublicationOverride?"manual_override":"strict_gate",
    manualPublicationOverride:Boolean(manualPublicationOverride),
    publicationWarnings:manualPublicationOverride?gate.blockers:[],
  };
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
    if (req.method === "POST" && path === "/chat") return json(await chat(await body(req)));
    if (req.method === "POST" && path === "/worker/kick") { edgeRuntimeWaitUntil(kickWorker()); return json({ok:true,status:"worker_invoked"},202); }
    const runMatch = path.match(/^\/runs\/([0-9a-f-]{36})$/i);
    if (req.method === "GET" && runMatch) return json(await runStatus(runMatch[1]));
    if (req.method === "GET" && path === "/batches/latest") return json(await latestBatchStatus());
    const nextBatchMatch = path.match(/^\/batches\/([0-9a-f-]{36})\/next$/i);
    if (req.method === "POST" && nextBatchMatch) return json(await nextBatchWindow(nextBatchMatch[1]),202);
    const batchMatch = path.match(/^\/batches\/([0-9a-f-]{36})$/i);
    if (req.method === "GET" && batchMatch) return json(await batchStatus(batchMatch[1]));
    const approveMatch = path.match(/^\/cases\/([0-9a-f-]{36})\/review$/i);
    if (req.method === "POST" && approveMatch) return json(await approveCase(approveMatch[1],await body(req),req));
    const reprocessMatch = path.match(/^\/cases\/([0-9a-f-]{36})\/reprocess$/i);
    if (req.method === "POST" && reprocessMatch) return json(await reprocessCase(reprocessMatch[1],await body(req)),202);
    const deferredMatch = path.match(/^\/cases\/([0-9a-f-]{36})\/deferred\/(chronology|witnessesAndEvidence)$/i);
    if (req.method === "POST" && deferredMatch) return json(await deferredCaseField(deferredMatch[1],deferredMatch[2] as DeferredKind,await body(req)));
    const caseMatch = path.match(/^\/cases\/([0-9a-f-]{36})$/i);
    if (req.method === "GET" && caseMatch) {
      const { data,error }=await db.schema("nomologies").from("cases").select("*").eq("id",caseMatch[1]).maybeSingle();
      if (error) throw new ApiError(500,"CASE_READ_FAILED",error.message);
      if (!data) throw new ApiError(404,"CASE_NOT_FOUND","Case not found.");
      const reviewVersionId = string(data.pending_version_id || data.current_version_id);
      const [versionResult, documentResult, tagLinksResult, tagsResult, provisionsResult] = await Promise.all([
        reviewVersionId ? db.schema("nomologies").from("case_versions").select("*").eq("id",reviewVersionId).maybeSingle() : Promise.resolve({data:null,error:null}),
        db.schema("nomologies").from("case_search_documents").select("*").eq("case_id",caseMatch[1]).maybeSingle(),
        db.schema("nomologies").from("case_smart_tags").select("case_id,tag_id,confidence,boost,source_field,evidence_paragraph_ids").eq("case_id",caseMatch[1]),
        db.schema("nomologies").from("smart_tags").select("id,tag_key,label,normalized,kind,aliases"),
        db.schema("nomologies").from("provision_links").select("*").eq("case_id",caseMatch[1]),
      ]);
      const indexError = versionResult.error || documentResult.error || tagLinksResult.error || tagsResult.error || provisionsResult.error;
      if (indexError) throw new ApiError(500, "CASE_INDEX_READ_FAILED", indexError.message);
      const tagDefinitions = new Map(array(tagsResult.data).map((tag) => [string(tag.id), tag]));
      const smartTags = publicSmartTags(array(tagLinksResult.data).flatMap((link) => {
        const tag = tagDefinitions.get(string(link.tag_id));
        return tag ? [{ ...tag, confidence: link.confidence, boost: link.boost, sourceField: link.source_field, evidenceParagraphIds: link.evidence_paragraph_ids }] : [];
      }));
      const versionRow = versionResult.data ? { ...versionResult.data } : null;
      if (versionRow && versionRow.canonical_record && typeof versionRow.canonical_record === "object") {
        versionRow.canonical_record = dedupeRecordPresentation({ ...(versionRow.canonical_record as Record<string, unknown>) });
      }
      return json({ok:true,case:{...data,case_versions:versionRow,review_version_id:reviewVersionId||null,is_pending_review:Boolean(data.pending_version_id)},index:{document:documentResult.data||null,smartTags,provisions:provisionsResult.data||[]}});
    }
    if (req.method === "GET" && path === "/cases") {
      const status = string(new URL(req.url).searchParams.get("status")) || "published";
      let query=db.schema("nomologies").from("cases").select("*");
      query=status==="review"?query.or("publication_status.eq.review,pending_version_id.not.is.null"):query.eq("publication_status",status);
      const { data,error }=await query.order("decision_date",{ascending:false}).limit(200);
      if (error) throw new ApiError(500,"CASES_READ_FAILED",error.message);
      const rows=data||[];
      const ids=rows.map((row:Record<string,unknown>)=>string(row.id)).filter(Boolean);
      const {data:indexRows,error:indexError}=ids.length
        ? await db.schema("nomologies").from("case_search_documents").select("case_id,case_version_id,indexed_at").in("case_id",ids)
        : {data:[],error:null};
      if(indexError)throw new ApiError(500,"CASES_INDEX_STATUS_FAILED",indexError.message);
      const indexed=new Map((indexRows||[]).map((row:Record<string,unknown>)=>[string(row.case_id),row]));
      return json({ok:true,cases:rows.map((row:Record<string,unknown>)=>{
        const document=object(indexed.get(string(row.id)));
        const searchable=string(row.publication_status)==="published"&&Boolean(string(row.current_version_id))&&string(row.current_version_id)===string(document.case_version_id);
        return {...row,searchable,indexed_version_id:string(document.case_version_id),indexed_at:document.indexed_at||null};
      })});
    }
    return json({ok:false,code:"NOT_FOUND",message:"Route not found."},404);
  } catch (error) {
    if (error instanceof ApiError) return json({ok:false,code:error.code,message:error.message,...error.details},error.status);
    console.error(error);
    return json({ok:false,code:"SERVER_ERROR",message:error instanceof Error?error.message:"Unexpected server error."},500);
  }
});
