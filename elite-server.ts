import { fetchCyLawJudgment, isOfficialCyLawUrl } from "./src/nomologies-v2/cylaw.ts";
import { runNomologiesPipelineV2 } from "./src/nomologies-v2/pipeline.ts";
import { NomologiesOpenAIError } from "./src/nomologies-v2/openai-responses.ts";
import {
  clearNomologiesCorpus,
  indexNomologiesRecord,
  searchCorpusStatus,
  searchNomologiesCorpus,
} from "./src/nomologies-search/store.ts";
import type { SearchFiltersV1 } from "./src/nomologies-search/types.ts";

const PORT = Number(Deno.env.get("PORT") || 8000);
const MAX_BODY_BYTES = 2_500_000;
const MAX_TEXT_CHARACTERS = 1_800_000;
const MAX_ACTIVE_EXTRACTIONS = 1;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const EXTRACTION_RATE_LIMIT = 12;
const SEARCH_RATE_LIMIT = 240;
const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const SECTION_JOB_TIMEOUT_MS = 4 * 60 * 1000;
const FULL_JOB_TIMEOUT_MS = 12 * 60 * 1000;
const WEB_ROOT = new URL("./web/", import.meta.url);
const encoder = new TextEncoder();

const jobs = new Map<string, JobRecord>();
const inputs = new Map<string, JobInput>();
const controllers = new Map<string, AbortController>();
const extractionHistory = new Map<string, number[]>();
const searchHistory = new Map<string, number[]>();
let activeExtractions = 0;

type JobMode = "sections" | "full";
type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

type JobInput = {
  sourceUrl: string;
  text: string;
  sourceTitle: string;
  mode: JobMode;
};

type PublicFailure = {
  status: number;
  code: string;
  message: string;
};

type JobRecord = {
  jobId: string;
  status: JobStatus;
  mode: JobMode;
  stage: string;
  progress: number;
  sourceLabel: string;
  createdAt: string;
  startedAt: string;
  completedAt: string;
  heartbeatAt: string;
  elapsedMs: number;
  generatedAt: string;
  result?: unknown;
  error?: PublicFailure;
};

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

function env(name: string): string {
  try {
    return String(Deno.env.get(name) || "").trim();
  } catch {
    return "";
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function text(value: string, status = 200, contentType = "text/plain; charset=utf-8"): Response {
  return new Response(value, {
    status,
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    },
  });
}

function clientId(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("cf-connecting-ip")
    || "unknown";
}

function timingSafeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a[index] ^ b[index];
  return mismatch === 0;
}

function checkAccess(request: Request): Response | null {
  const configured = env("LAB_ACCESS_KEY");
  if (!configured) return json({ ok: false, code: "LAB_ACCESS_KEY_NOT_CONFIGURED", message: "LAB_ACCESS_KEY is not configured." }, 503);
  const provided = request.headers.get("x-lab-key") || "";
  if (!provided || !timingSafeEqual(provided, configured)) {
    return json({ ok: false, code: "UNAUTHORIZED", message: "Invalid Pipeline Lab access key." }, 401);
  }
  return null;
}

function rateLimit(request: Request, history: Map<string, number[]>, maximum: number): Response | null {
  const id = clientId(request);
  const now = Date.now();
  const recent = (history.get(id) || []).filter((at) => now - at < RATE_WINDOW_MS);
  if (recent.length >= maximum) {
    return json({ ok: false, code: "RATE_LIMITED", message: "Request limit reached. Try again later." }, 429, { "retry-after": "3600" });
  }
  recent.push(now);
  history.set(id, recent);
  return null;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "REQUEST_TOO_LARGE", "The request is too large.");
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_BODY_BYTES) throw new HttpError(413, "REQUEST_TOO_LARGE", "The request is too large.");
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not-object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "The request body is not valid JSON.");
  }
}

function publicError(error: unknown): PublicFailure {
  if (error instanceof HttpError) return { status: error.status, code: error.code, message: error.message };
  if (error instanceof NomologiesOpenAIError) {
    const status = [400, 401, 403, 408, 409, 429, 500, 502, 503, 504].includes(error.status) ? error.status : 500;
    return { status, code: error.code, message: error.message };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return { status: 408, code: "REQUEST_CANCELLED", message: "The request was cancelled." };
  }
  console.error(error);
  return { status: 500, code: "SERVER_ERROR", message: "The Nomologies service encountered an unexpected error." };
}

function parseJobInput(payload: Record<string, unknown>): JobInput {
  const sourceUrl = stringValue(payload.sourceUrl);
  const textValue = stringValue(payload.text);
  const sourceTitle = stringValue(payload.sourceTitle);
  const mode: JobMode = stringValue(payload.mode) === "sections" ? "sections" : "full";
  if (!sourceUrl && !textValue) throw new HttpError(400, "SOURCE_REQUIRED", "Provide an official CyLaw URL or judgment text.");
  if (sourceUrl && !isOfficialCyLawUrl(sourceUrl)) throw new HttpError(400, "CYLAW_URL_NOT_ALLOWED", "Only official HTTPS CyLaw judgment URLs are accepted.");
  if (textValue.length > MAX_TEXT_CHARACTERS) throw new HttpError(413, "SOURCE_TOO_LARGE", "The judgment text is too large.");
  return {
    sourceUrl,
    text: textValue,
    sourceTitle: sourceTitle || (sourceUrl ? "CyLaw judgment" : "Uploaded judgment"),
    mode,
  };
}

function compactResult<T>(result: T): T {
  const clone = structuredClone(result) as unknown as Record<string, unknown>;
  const source = clone.mode === "sections"
    ? clone.source
    : clone.record && typeof clone.record === "object"
    ? (clone.record as Record<string, unknown>).source
    : undefined;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    const row = source as Record<string, unknown>;
    if (typeof row.originalHtml === "string") row.originalHtml = `[omitted: ${row.originalHtml.length} characters]`;
    if (typeof row.cleanText === "string") row.cleanText = `[omitted: ${row.cleanText.length} characters]`;
  }
  delete clone.rawAgents;
  return clone as T;
}

function cleanupJobs(): void {
  const now = Date.now();
  for (const [jobId, job] of jobs) {
    const reference = Date.parse(job.completedAt || job.createdAt);
    if (Number.isFinite(reference) && now - reference > JOB_TTL_MS) {
      jobs.delete(jobId);
      inputs.delete(jobId);
      controllers.delete(jobId);
    }
  }
}

function activeJobCount(): number {
  return [...jobs.values()].filter((job) => job.status === "queued" || job.status === "running").length;
}

function updateStage(job: JobRecord): void {
  if (job.status !== "running" || !job.startedAt) return;
  const elapsed = Date.now() - Date.parse(job.startedAt);
  job.elapsedMs = Math.max(0, elapsed);
  job.heartbeatAt = new Date().toISOString();
  if (job.mode === "sections") {
    if (elapsed < 5_000) [job.stage, job.progress] = ["Preparing judgment source", Math.max(job.progress, 8)];
    else if (elapsed < 18_000) [job.stage, job.progress] = ["Recognising legal sections and speakers", Math.max(job.progress, 48)];
    else [job.stage, job.progress] = ["Reconciling section boundaries", Math.max(job.progress, 82)];
    return;
  }
  if (elapsed < 8_000) [job.stage, job.progress] = ["Preparing judgment source", Math.max(job.progress, 8)];
  else if (elapsed < 45_000) [job.stage, job.progress] = ["Recognising legal sections and speakers", Math.max(job.progress, 24)];
  else if (elapsed < 165_000) [job.stage, job.progress] = ["Running specialist legal extractors", Math.max(job.progress, 48)];
  else if (elapsed < 285_000) [job.stage, job.progress] = ["Validating exact evidence anchors", Math.max(job.progress, 70)];
  else [job.stage, job.progress] = ["Independent review and search indexing", Math.max(job.progress, 88)];
}

function jobView(job: JobRecord): Record<string, unknown> {
  return {
    ok: true,
    jobId: job.jobId,
    status: job.status,
    mode: job.mode,
    stage: job.stage,
    progress: job.progress,
    sourceLabel: job.sourceLabel,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    heartbeatAt: job.heartbeatAt,
    elapsedMs: job.elapsedMs,
    generatedAt: job.generatedAt,
    ...(job.status === "completed" ? { result: job.result } : {}),
    ...(job.status === "failed" || job.status === "cancelled" ? { error: job.error } : {}),
  };
}

async function executeJob(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  const input = inputs.get(jobId);
  if (!job || !input || job.status !== "queued") return;
  activeExtractions += 1;
  const controller = new AbortController();
  controllers.set(jobId, controller);
  const startedAtMs = Date.now();
  const timeoutMs = job.mode === "sections" ? SECTION_JOB_TIMEOUT_MS : FULL_JOB_TIMEOUT_MS;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Job deadline exceeded", "AbortError"));
  }, timeoutMs);
  const heartbeat = setInterval(() => updateStage(job), 2_000);
  job.status = "running";
  job.startedAt = new Date().toISOString();
  job.heartbeatAt = job.startedAt;
  job.stage = "Preparing judgment source";
  job.progress = 5;

  try {
    const fetched = input.sourceUrl ? await fetchCyLawJudgment(input.sourceUrl, controller.signal) : null;
    job.sourceLabel = fetched?.sourceTitle || input.sourceTitle;
    const result = await runNomologiesPipelineV2({
      text: fetched?.text || input.text,
      html: fetched?.html || "",
      sourceTitle: fetched?.sourceTitle || input.sourceTitle,
      sourceUrl: fetched?.sourceUrl || "",
      sourceDatabase: fetched?.sourceDatabase || "uploaded_text",
      charset: fetched?.charset || "utf-8",
      mode: input.mode,
    }, {
      signal: controller.signal,
      model: env("NOMOLOGIES_V2_MODEL") || undefined,
    });

    if (jobs.get(jobId)?.status === "cancelled") return;
    if (result.mode !== job.mode) throw new HttpError(500, "JOB_MODE_MISMATCH", "The pipeline returned the wrong result mode.");

    let searchIndex: Record<string, unknown> | undefined;
    if (result.mode === "full") {
      job.stage = "Building elite search index";
      job.progress = Math.max(job.progress, 94);
      const indexed = await indexNomologiesRecord(result.record, { semantic: true, signal: controller.signal });
      searchIndex = {
        indexed: true,
        semanticIndexed: indexed.semanticIndexed,
        documentId: indexed.document.id,
        smartTags: indexed.document.smartTags.slice(0, 20),
        indexSize: searchCorpusStatus().indexSize,
      };
    }

    job.result = compactResult(searchIndex ? { ...result, searchIndex } : result);
    job.status = "completed";
    job.stage = "Extraction and indexing complete";
    job.progress = 100;
    job.completedAt = new Date().toISOString();
    job.generatedAt = job.completedAt;
    job.elapsedMs = Date.now() - startedAtMs;
    job.heartbeatAt = job.completedAt;
  } catch (error) {
    const cancelled = jobs.get(jobId)?.status === "cancelled";
    job.status = cancelled ? "cancelled" : "failed";
    job.error = cancelled
      ? { status: 408, code: "JOB_CANCELLED", message: "The extraction job was cancelled." }
      : timedOut
      ? { status: 504, code: "JOB_TIMEOUT", message: `The ${job.mode} job exceeded its server deadline.` }
      : publicError(error);
    job.stage = cancelled ? "Extraction cancelled" : "Extraction failed";
    job.completedAt = new Date().toISOString();
    job.generatedAt = job.completedAt;
    job.elapsedMs = Date.now() - startedAtMs;
    job.heartbeatAt = job.completedAt;
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
    activeExtractions = Math.max(0, activeExtractions - 1);
    inputs.delete(jobId);
    controllers.delete(jobId);
  }
}

async function createJob(request: Request): Promise<Response> {
  const denied = checkAccess(request);
  if (denied) return denied;
  const limited = rateLimit(request, extractionHistory, EXTRACTION_RATE_LIMIT);
  if (limited) return limited;
  if (!env("OPENAI_API_KEY")) return json({ ok: false, code: "OPENAI_API_KEY_NOT_CONFIGURED", message: "OPENAI_API_KEY is not configured." }, 503);
  cleanupJobs();
  if (activeJobCount() >= MAX_ACTIVE_EXTRACTIONS || activeExtractions >= MAX_ACTIVE_EXTRACTIONS) {
    return json({ ok: false, code: "LAB_BUSY", message: "Another judgment is currently being extracted." }, 429, { "retry-after": "20" });
  }
  const input = parseJobInput(await readJsonBody(request));
  const jobId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const job: JobRecord = {
    jobId,
    status: "queued",
    mode: input.mode,
    stage: "Queued for extraction",
    progress: 2,
    sourceLabel: input.sourceTitle,
    createdAt,
    startedAt: "",
    completedAt: "",
    heartbeatAt: createdAt,
    elapsedMs: 0,
    generatedAt: "",
  };
  jobs.set(jobId, job);
  inputs.set(jobId, input);
  setTimeout(() => void executeJob(jobId), 0);
  return json({ ok: true, jobId, status: job.status, mode: job.mode, pollUrl: `/api/jobs/${jobId}`, createdAt }, 202);
}

function getJob(request: Request, jobId: string): Response {
  const denied = checkAccess(request);
  if (denied) return denied;
  cleanupJobs();
  const job = jobs.get(jobId);
  if (!job) return json({ ok: false, code: "JOB_NOT_FOUND", message: "The extraction job does not exist or has expired." }, 404);
  updateStage(job);
  return json(jobView(job));
}

function cancelJob(request: Request, jobId: string): Response {
  const denied = checkAccess(request);
  if (denied) return denied;
  const job = jobs.get(jobId);
  if (!job) return json({ ok: false, code: "JOB_NOT_FOUND", message: "The extraction job does not exist or has expired." }, 404);
  if (job.status === "queued" || job.status === "running") {
    job.status = "cancelled";
    job.stage = "Extraction cancelled";
    job.completedAt = new Date().toISOString();
    job.generatedAt = job.completedAt;
    job.heartbeatAt = job.completedAt;
    job.error = { status: 408, code: "JOB_CANCELLED", message: "The extraction job was cancelled." };
    controllers.get(jobId)?.abort(new DOMException("Cancelled by user", "AbortError"));
  }
  return json(jobView(job));
}

async function searchRequest(request: Request): Promise<Response> {
  const denied = checkAccess(request);
  if (denied) return denied;
  const limited = rateLimit(request, searchHistory, SEARCH_RATE_LIMIT);
  if (limited) return limited;
  const payload = await readJsonBody(request);
  const query = stringValue(payload.query || payload.text);
  if (!query) throw new HttpError(400, "SEARCH_QUERY_REQUIRED", "Enter a legal search query.");
  const filters = payload.filters && typeof payload.filters === "object" && !Array.isArray(payload.filters)
    ? payload.filters as SearchFiltersV1
    : {};
  const result = await searchNomologiesCorpus(query, {
    filters,
    limit: Math.max(1, Math.min(100, Number(payload.limit) || 20)),
    semantic: payload.semantic !== false,
    signal: request.signal,
  });
  return json({ ok: true, result });
}

function searchStatus(request: Request): Response {
  const denied = checkAccess(request);
  if (denied) return denied;
  return json({ ok: true, ...searchCorpusStatus() });
}

function clearSearch(request: Request): Response {
  const denied = checkAccess(request);
  if (denied) return denied;
  clearNomologiesCorpus();
  return json({ ok: true, indexSize: 0 });
}

async function staticFile(pathname: string): Promise<Response> {
  const normalized = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (!/^(index\.html|app\.js|styles\.css|search\.html|search\.js)$/.test(normalized)) return text("Not found", 404);
  try {
    const content = await Deno.readTextFile(new URL(normalized, WEB_ROOT));
    const contentType = normalized.endsWith(".html")
      ? "text/html; charset=utf-8"
      : normalized.endsWith(".js")
      ? "text/javascript; charset=utf-8"
      : "text/css; charset=utf-8";
    return text(content, 200, contentType);
  } catch {
    return text("Nomologies assets are unavailable.", 500);
  }
}

Deno.serve({ port: PORT }, async (request) => {
  const url = new URL(request.url);
  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      cleanupJobs();
      return json({
        ok: true,
        service: "nomologies-v2-elite-search-lab",
        openaiConfigured: Boolean(env("OPENAI_API_KEY")),
        accessKeyConfigured: Boolean(env("LAB_ACCESS_KEY")),
        modelPinned: Boolean(env("NOMOLOGIES_V2_MODEL")),
        embeddingModel: env("NOMOLOGIES_EMBEDDING_MODEL") || "text-embedding-3-large",
        activeJobs: activeJobCount(),
        retainedJobs: jobs.size,
        searchIndexSize: searchCorpusStatus().indexSize,
        version: "2.3.0-elite-search",
      });
    }
    if (request.method === "POST" && (url.pathname === "/api/jobs" || url.pathname === "/api/parse")) return await createJob(request);
    if (request.method === "POST" && url.pathname === "/api/search") return await searchRequest(request);
    if (request.method === "GET" && url.pathname === "/api/search/status") return searchStatus(request);
    if (request.method === "DELETE" && url.pathname === "/api/search") return clearSearch(request);

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})$/i);
    if (jobMatch && request.method === "GET") return getJob(request, jobMatch[1]);
    if (jobMatch && request.method === "DELETE") return cancelJob(request, jobMatch[1]);

    if (request.method === "GET" || request.method === "HEAD") {
      const response = await staticFile(url.pathname);
      return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
    }
    return json({ ok: false, code: "METHOD_NOT_ALLOWED", message: "Method not allowed." }, 405, { allow: "GET, HEAD, POST, DELETE" });
  } catch (error) {
    const failure = publicError(error);
    return json({ ok: false, code: failure.code, message: failure.message }, failure.status);
  }
});

console.log(`Nomologies V2 Elite Search Lab listening on :${PORT}`);
