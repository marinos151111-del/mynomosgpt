import { fetchCyLawJudgment, isOfficialCyLawUrl } from "./src/nomologies-v2/cylaw.ts";
import { runNomologiesPipelineV2 } from "./src/nomologies-v2/pipeline.ts";
import { NomologiesOpenAIError } from "./src/nomologies-v2/openai-responses.ts";

const PORT = Number(Deno.env.get("PORT") || 8000);
const MAX_BODY_BYTES = 2_500_000;
const MAX_TEXT_CHARACTERS = 1_800_000;
const MAX_ACTIVE_JOBS = 2;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX_REQUESTS = 12;
const JOB_TTL_MS = 2 * 60 * 60 * 1000;

const WEB_ROOT = new URL("./web/", import.meta.url);
const encoder = new TextEncoder();
let activeJobs = 0;
const requestHistory = new Map<string, number[]>();

type ParseMode = "sections" | "full";
type JobStatus = "queued" | "running" | "completed" | "failed";

type ParseInput = {
  sourceUrl: string;
  pastedText: string;
  suppliedTitle: string;
  mode: ParseMode;
};

type PublicFailure = {
  status: number;
  code: string;
  message: string;
};

type ParseJob = {
  id: string;
  status: JobStatus;
  mode: ParseMode;
  stage: string;
  progress: number;
  createdAt: string;
  startedAt: string;
  completedAt: string;
  expiresAt: number;
  elapsedMs: number;
  input: ParseInput;
  result?: unknown;
  error?: PublicFailure;
};

const jobs = new Map<string, ParseJob>();

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

function env(name: string): string {
  return String(Deno.env.get(name) || "").trim();
}

function clientId(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("cf-connecting-ip") || "unknown";
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
  if (!configured) {
    return json({
      ok: false,
      code: "LAB_ACCESS_KEY_NOT_CONFIGURED",
      message: "LAB_ACCESS_KEY is not configured on the deployment.",
    }, 503);
  }
  const provided = request.headers.get("x-lab-key") || "";
  if (!provided || !timingSafeEqual(provided, configured)) {
    return json({ ok: false, code: "UNAUTHORIZED", message: "Invalid Pipeline Lab access key." }, 401);
  }
  return null;
}

function checkRateLimit(request: Request): Response | null {
  const id = clientId(request);
  const now = Date.now();
  const recent = (requestHistory.get(id) || []).filter((at) => now - at < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX_REQUESTS) {
    return json({
      ok: false,
      code: "RATE_LIMITED",
      message: "This test lab allows 12 extraction requests per hour per client.",
    }, 429, { "retry-after": "3600" });
  }
  recent.push(now);
  requestHistory.set(id, recent);
  return null;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "REQUEST_TOO_LARGE", "The intake payload is too large.");
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_BODY_BYTES) throw new HttpError(413, "REQUEST_TOO_LARGE", "The intake payload is too large.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "The request body is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "INVALID_PAYLOAD", "The request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function compactResult<T>(result: T): T {
  const clone = structuredClone(result) as unknown as Record<string, unknown>;
  const mode = stringValue(clone.mode);
  const source = mode === "sections"
    ? clone.source
    : clone.record && typeof clone.record === "object"
    ? (clone.record as Record<string, unknown>).source
    : undefined;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    const sourceRecord = source as Record<string, unknown>;
    if (typeof sourceRecord.originalHtml === "string") {
      sourceRecord.originalHtml = `[omitted: ${sourceRecord.originalHtml.length} characters]`;
    }
    if (typeof sourceRecord.cleanText === "string") {
      sourceRecord.cleanText = `[omitted: ${sourceRecord.cleanText.length} characters]`;
    }
  }
  delete clone.rawAgents;
  return clone as T;
}

function publicError(error: unknown): PublicFailure {
  if (error instanceof HttpError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof NomologiesOpenAIError) {
    const status = [400, 401, 403, 408, 409, 429, 500, 502, 503, 504].includes(error.status)
      ? error.status
      : 500;
    return { status, code: error.code, message: error.message };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return { status: 408, code: "REQUEST_CANCELLED", message: "The extraction request was cancelled." };
  }
  console.error(error);
  return { status: 500, code: "PIPELINE_ERROR", message: "The Pipeline Lab encountered an unexpected error." };
}

function pruneJobs(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.expiresAt <= now) jobs.delete(id);
  }
}

function estimatedJobState(job: ParseJob): { stage: string; progress: number } {
  if (job.status === "queued") return { stage: "Queued for extraction", progress: 2 };
  if (job.status === "completed") return { stage: "Extraction complete", progress: 100 };
  if (job.status === "failed") return { stage: "Extraction stopped", progress: Math.max(5, job.progress) };

  const elapsed = job.startedAt ? Math.max(0, Date.now() - Date.parse(job.startedAt)) : 0;
  if (job.mode === "sections") {
    if (elapsed < 2_000) return { stage: "Preparing judgment source", progress: 8 };
    if (elapsed < 7_000) return { stage: "Assigning atomic passage IDs", progress: 28 };
    if (elapsed < 16_000) return { stage: "Recognising legal sections and speakers", progress: 58 };
    if (elapsed < 30_000) return { stage: "Reconciling section boundaries", progress: 84 };
    return { stage: "Finalising section map", progress: 94 };
  }

  if (elapsed < 3_000) return { stage: "Preparing judgment source", progress: 6 };
  if (elapsed < 25_000) return { stage: "Recognising legal sections and speakers", progress: 20 };
  if (elapsed < 95_000) return { stage: "Running specialist legal extractors", progress: 45 };
  if (elapsed < 165_000) return { stage: "Validating exact evidence anchors", progress: 68 };
  if (elapsed < 260_000) return { stage: "Running independent legal review", progress: 86 };
  return { stage: "Calculating readiness and conflicts", progress: 95 };
}

function jobSnapshot(job: ParseJob): Record<string, unknown> {
  const estimated = estimatedJobState(job);
  const snapshot: Record<string, unknown> = {
    ok: job.status !== "failed",
    jobId: job.id,
    status: job.status,
    mode: job.mode,
    stage: estimated.stage,
    progress: estimated.progress,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    elapsedMs: job.status === "running" && job.startedAt
      ? Math.max(0, Date.now() - Date.parse(job.startedAt))
      : job.elapsedMs,
  };
  if (job.status === "completed") {
    snapshot.generatedAt = job.completedAt;
    snapshot.result = job.result;
  }
  if (job.status === "failed") {
    snapshot.error = job.error || {
      status: 500,
      code: "PIPELINE_ERROR",
      message: "The extraction failed unexpectedly.",
    };
  }
  return snapshot;
}

function validateParseInput(payload: Record<string, unknown>): ParseInput {
  const sourceUrl = stringValue(payload.sourceUrl);
  const pastedText = stringValue(payload.text);
  const suppliedTitle = stringValue(payload.sourceTitle);
  const mode: ParseMode = stringValue(payload.mode) === "sections" ? "sections" : "full";

  if (!sourceUrl && !pastedText) {
    throw new HttpError(400, "SOURCE_REQUIRED", "Provide an official CyLaw URL or judgment text.");
  }
  if (sourceUrl && !isOfficialCyLawUrl(sourceUrl)) {
    throw new HttpError(400, "CYLAW_URL_NOT_ALLOWED", "Only official HTTPS CyLaw judgment URLs are accepted in URL mode.");
  }
  if (pastedText.length > MAX_TEXT_CHARACTERS) {
    throw new HttpError(413, "SOURCE_TOO_LARGE", `Judgment text must be below ${MAX_TEXT_CHARACTERS.toLocaleString()} characters.`);
  }

  return { sourceUrl, pastedText, suppliedTitle, mode };
}

async function executeJob(job: ParseJob): Promise<void> {
  job.status = "running";
  job.stage = "Preparing judgment source";
  job.progress = 6;
  job.startedAt = new Date().toISOString();
  const startedAt = Date.now();

  try {
    const fetched = job.input.sourceUrl ? await fetchCyLawJudgment(job.input.sourceUrl) : null;
    job.stage = job.mode === "sections"
      ? "Recognising legal sections and speakers"
      : "Running full evidence-bound extraction";
    job.progress = job.mode === "sections" ? 45 : 20;

    const result = await runNomologiesPipelineV2({
      text: fetched?.text || job.input.pastedText,
      html: fetched?.html || "",
      sourceTitle: fetched?.sourceTitle || job.input.suppliedTitle || "Uploaded judgment",
      sourceUrl: fetched?.sourceUrl || "",
      sourceDatabase: fetched?.sourceDatabase || "uploaded_text",
      charset: fetched?.charset || "utf-8",
      mode: job.input.mode,
    }, {
      model: env("NOMOLOGIES_V2_MODEL") || undefined,
    });

    job.result = compactResult(result);
    job.status = "completed";
    job.stage = "Extraction complete";
    job.progress = 100;
    job.completedAt = new Date().toISOString();
    job.elapsedMs = Date.now() - startedAt;
    job.expiresAt = Date.now() + JOB_TTL_MS;
  } catch (error) {
    job.status = "failed";
    job.error = publicError(error);
    job.stage = "Extraction stopped";
    job.completedAt = new Date().toISOString();
    job.elapsedMs = Date.now() - startedAt;
    job.expiresAt = Date.now() + JOB_TTL_MS;
  } finally {
    activeJobs = Math.max(0, activeJobs - 1);
    job.input.pastedText = "";
  }
}

async function createParseJob(request: Request): Promise<Response> {
  const denied = checkAccess(request);
  if (denied) return denied;
  const rateLimited = checkRateLimit(request);
  if (rateLimited) return rateLimited;
  if (!env("OPENAI_API_KEY")) {
    return json({
      ok: false,
      code: "OPENAI_API_KEY_NOT_CONFIGURED",
      message: "OPENAI_API_KEY is not configured on the deployment.",
    }, 503);
  }
  if (activeJobs >= MAX_ACTIVE_JOBS) {
    return json({
      ok: false,
      code: "LAB_BUSY",
      message: "The Pipeline Lab is already processing the maximum number of judgments. Try again shortly.",
    }, 429, { "retry-after": "30" });
  }

  pruneJobs();
  const input = validateParseInput(await readJsonBody(request));
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const job: ParseJob = {
    id,
    status: "queued",
    mode: input.mode,
    stage: "Queued for extraction",
    progress: 2,
    createdAt,
    startedAt: "",
    completedAt: "",
    expiresAt: Date.now() + JOB_TTL_MS,
    elapsedMs: 0,
    input,
  };
  jobs.set(id, job);
  activeJobs += 1;

  queueMicrotask(() => {
    void executeJob(job);
  });

  const pollUrl = `/api/jobs/${id}`;
  return json({
    ok: true,
    jobId: id,
    status: "queued",
    mode: input.mode,
    pollUrl,
    createdAt,
    message: "Extraction started. Poll the job endpoint for completion.",
  }, 202, { location: pollUrl });
}

function getParseJob(request: Request, id: string): Response {
  const denied = checkAccess(request);
  if (denied) return denied;
  pruneJobs();
  const job = jobs.get(id);
  if (!job) {
    return json({
      ok: false,
      code: "JOB_NOT_FOUND",
      message: "This extraction job was not found or has expired.",
    }, 404);
  }
  return json(jobSnapshot(job));
}

async function staticFile(pathname: string): Promise<Response> {
  const normalized = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (!/^(index\.html|app\.js|async-patch\.js|styles\.css)$/.test(normalized)) return text("Not found", 404);
  try {
    const content = await Deno.readTextFile(new URL(normalized, WEB_ROOT));
    const contentType = normalized.endsWith(".html")
      ? "text/html; charset=utf-8"
      : normalized.endsWith(".js")
      ? "text/javascript; charset=utf-8"
      : "text/css; charset=utf-8";
    return text(content, 200, contentType);
  } catch {
    return text("Pipeline Lab assets are unavailable.", 500);
  }
}

Deno.serve({ port: PORT }, async (request) => {
  const url = new URL(request.url);
  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      pruneJobs();
      return json({
        ok: true,
        service: "nomologies-v2-pipeline-lab",
        openaiConfigured: Boolean(env("OPENAI_API_KEY")),
        accessKeyConfigured: Boolean(env("LAB_ACCESS_KEY")),
        modelPinned: Boolean(env("NOMOLOGIES_V2_MODEL")),
        activeJobs,
        retainedJobs: jobs.size,
        asynchronousJobs: true,
        version: "2.1.0-lab",
      });
    }
    if (request.method === "POST" && url.pathname === "/api/parse") {
      return await createParseJob(request);
    }
    const jobMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})$/i);
    if (request.method === "GET" && jobMatch) {
      return getParseJob(request, jobMatch[1]);
    }
    if (request.method === "GET" || request.method === "HEAD") {
      const response = await staticFile(url.pathname);
      return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
    }
    return json({ ok: false, code: "METHOD_NOT_ALLOWED", message: "Method not allowed." }, 405, { allow: "GET, HEAD, POST" });
  } catch (error) {
    const failure = publicError(error);
    return json({ ok: false, code: failure.code, message: failure.message }, failure.status);
  }
});

console.log(`Nomologies V2 Pipeline Lab listening on :${PORT}`);
