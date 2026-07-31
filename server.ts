import { fetchCyLawJudgment, isOfficialCyLawUrl } from "./src/nomologies-v2/cylaw.ts";
import { runNomologiesPipelineV2 } from "./src/nomologies-v2/pipeline.ts";
import { NomologiesOpenAIError } from "./src/nomologies-v2/openai-responses.ts";

const PORT = Number(Deno.env.get("PORT") || 8000);
const MAX_BODY_BYTES = 2_500_000;
const MAX_TEXT_CHARACTERS = 1_800_000;
const MAX_ACTIVE_JOBS = 2;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX_REQUESTS = 12;

const WEB_ROOT = new URL("./web/", import.meta.url);
const encoder = new TextEncoder();
let activeJobs = 0;
const requestHistory = new Map<string, number[]>();

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

async function parseRequest(request: Request): Promise<Response> {
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

  const payload = await readJsonBody(request);
  const sourceUrl = stringValue(payload.sourceUrl);
  const pastedText = stringValue(payload.text);
  const suppliedTitle = stringValue(payload.sourceTitle);
  const requestedMode = stringValue(payload.mode) === "sections" ? "sections" : "full";

  if (!sourceUrl && !pastedText) {
    throw new HttpError(400, "SOURCE_REQUIRED", "Provide an official CyLaw URL or judgment text.");
  }
  if (sourceUrl && !isOfficialCyLawUrl(sourceUrl)) {
    throw new HttpError(400, "CYLAW_URL_NOT_ALLOWED", "Only official HTTPS CyLaw judgment URLs are accepted in URL mode.");
  }
  if (pastedText.length > MAX_TEXT_CHARACTERS) {
    throw new HttpError(413, "SOURCE_TOO_LARGE", `Judgment text must be below ${MAX_TEXT_CHARACTERS.toLocaleString()} characters.`);
  }

  activeJobs += 1;
  const startedAt = Date.now();
  try {
    const fetched = sourceUrl ? await fetchCyLawJudgment(sourceUrl, request.signal) : null;
    const result = await runNomologiesPipelineV2({
      text: fetched?.text || pastedText,
      html: fetched?.html || "",
      sourceTitle: fetched?.sourceTitle || suppliedTitle || "Uploaded judgment",
      sourceUrl: fetched?.sourceUrl || "",
      sourceDatabase: fetched?.sourceDatabase || "uploaded_text",
      charset: fetched?.charset || "utf-8",
      mode: requestedMode,
    }, {
      signal: request.signal,
      model: env("NOMOLOGIES_V2_MODEL") || undefined,
    });

    return json({
      ok: true,
      elapsedMs: Date.now() - startedAt,
      generatedAt: new Date().toISOString(),
      result: compactResult(result),
    });
  } finally {
    activeJobs = Math.max(0, activeJobs - 1);
  }
}

function publicError(error: unknown): { status: number; code: string; message: string } {
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

async function staticFile(pathname: string): Promise<Response> {
  const normalized = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (!/^(index\.html|app\.js|styles\.css)$/.test(normalized)) return text("Not found", 404);
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
      return json({
        ok: true,
        service: "nomologies-v2-pipeline-lab",
        openaiConfigured: Boolean(env("OPENAI_API_KEY")),
        accessKeyConfigured: Boolean(env("LAB_ACCESS_KEY")),
        modelPinned: Boolean(env("NOMOLOGIES_V2_MODEL")),
        activeJobs,
        version: "2.0.0-lab",
      });
    }
    if (request.method === "POST" && url.pathname === "/api/parse") {
      return await parseRequest(request);
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
