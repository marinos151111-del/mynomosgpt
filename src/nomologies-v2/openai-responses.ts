// OpenAI Responses API transport for Nomologies Pipeline V2.
// Uses strict Structured Outputs and never exposes the API key or source text.

const RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
const MODELS_ENDPOINT = "https://api.openai.com/v1/models";
const DEFAULT_TIMEOUT_MS = 240_000;

type JsonRecord = Record<string, unknown>;

export type ReasoningEffort = "low" | "medium" | "high";

export interface StructuredResponseRequest {
  schemaName: string;
  schema: JsonRecord;
  system: string;
  user: string;
  stage: string;
  effort?: ReasoningEffort;
  model?: string;
  fallbackModel?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface StructuredResponseResult<T extends JsonRecord = JsonRecord> {
  data: T;
  responseId: string;
  model: string;
  elapsedMs: number;
  usage: JsonRecord;
}

export class NomologiesOpenAIError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: string, message: string, status = 500, retryable = false) {
    super(message);
    this.name = "NomologiesOpenAIError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function env(name: string): string {
  try {
    return String(Deno.env.get(name) || "").trim();
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

let cachedModel = "";

function modelRank(id: string): number {
  if (!/^gpt-5(?:\.\d+)?$/i.test(id)) return -1;
  const match = id.match(/^gpt-5(?:\.(\d+))?$/i);
  return match?.[1] ? 100 + Number(match[1]) : 100;
}

export async function resolveNomologiesModel(apiKey: string): Promise<string> {
  const configured = env("NOMOLOGIES_V2_MODEL");
  if (configured) return configured;
  if (cachedModel) return cachedModel;

  try {
    const response = await fetch(MODELS_ENDPOINT, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (response.ok) {
      const payload = await response.json() as JsonRecord;
      const ids = asArray(payload.data)
        .map((item) => str(isRecord(item) ? item.id : ""))
        .filter(Boolean);
      const fullGpt5 = ids
        .filter((id) => modelRank(id) >= 0)
        .sort((left, right) => modelRank(right) - modelRank(left));
      if (fullGpt5.length) {
        cachedModel = fullGpt5[0];
        return cachedModel;
      }
      for (const fallback of ["gpt-5.1", "gpt-5", "gpt-5-pro", "gpt-5-mini"]) {
        if (ids.includes(fallback)) {
          cachedModel = fallback;
          return cachedModel;
        }
      }
    }
  } catch {
    // The actual request below will return the authoritative provider error.
  }

  cachedModel = "gpt-5";
  return cachedModel;
}

function combineSignals(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("NOMOLOGIES_OPENAI_TIMEOUT")),
    timeoutMs,
  );
  const parentAbort = () => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) parentAbort();
    else parent.addEventListener("abort", parentAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", parentAbort);
    },
  };
}

function outputText(payload: JsonRecord): string {
  const direct = str(payload.output_text);
  if (direct) return direct;
  const parts: string[] = [];
  for (const item of asArray(payload.output)) {
    if (!isRecord(item)) continue;
    for (const content of asArray(item.content)) {
      if (!isRecord(content)) continue;
      const text = str(content.text);
      if (text) parts.push(text);
    }
  }
  return parts.join("").trim();
}

function parseStrictObject(text: string): JsonRecord {
  if (!text) {
    throw new NomologiesOpenAIError(
      "EMPTY_STRUCTURED_OUTPUT",
      "The extraction model returned no structured output.",
      502,
      true,
    );
  }
  try {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error("not-object");
    return parsed;
  } catch {
    throw new NomologiesOpenAIError(
      "INVALID_STRUCTURED_OUTPUT",
      "The extraction model returned invalid structured output.",
      502,
      true,
    );
  }
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function providerErrorSummary(response: Response): Promise<{
  code: string;
  type: string;
  requestId: string;
}> {
  let code = "";
  let type = "";
  try {
    const payload = await response.json() as JsonRecord;
    const detail = isRecord(payload.error) ? payload.error : {};
    code = str(detail.code).slice(0, 120);
    type = str(detail.type).slice(0, 120);
  } catch {
    // Provider response bodies stay private.
  }
  return {
    code,
    type,
    requestId: str(response.headers.get("x-request-id")).slice(0, 160),
  };
}
async function callResponses(
  apiKey: string,
  body: JsonRecord,
  signal: AbortSignal,
): Promise<Response> {
  let last: Response | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      last = await fetch(RESPONSES_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      if (attempt === 1) {
        await new Promise((resolve) => setTimeout(resolve, 450));
        continue;
      }
      throw new NomologiesOpenAIError(
        "OPENAI_NETWORK_ERROR",
        "The extraction service could not reach OpenAI.",
        502,
        true,
      );
    }
    if (last.ok || attempt === 2 || !retryableStatus(last.status)) return last;
    const retryAfter = Math.min(2_000, Math.max(400, Number(last.headers.get("retry-after") || 0) * 1_000));
    await new Promise((resolve) => setTimeout(resolve, retryAfter));
  }
  if (!last) {
    throw new NomologiesOpenAIError("OPENAI_NO_RESPONSE", "OpenAI returned no response.", 502, true);
  }
  return last;
}

// Cost profile. "economy" keeps mechanical stages on the mini model while
// facts and judicial analysis run on the flagship; "quality" runs everything
// on the resolved flagship. An explicit NOMOLOGIES_V2_MODEL pin overrides all.
export type NomologiesProfile = "economy" | "quality";

export function nomologiesProfile(): NomologiesProfile {
  return env("NOMOLOGIES_V2_PROFILE").toLowerCase() === "quality" ? "quality" : "economy";
}

export function nomologiesMiniModel(): string {
  return env("NOMOLOGIES_V2_MINI_MODEL") || "gpt-5.4-mini";
}

// One transparent retry for retryable provider failures (timeouts, rate
// limits, 5xx). A single slow response must not kill a whole multi-stage
// extraction. A timeout retries on the faster fallback model when one is
// configured, because repeating the same slow call usually times out again.
// User cancellation is never retried.
export async function createStructuredResponseWithRetry<T extends JsonRecord = JsonRecord>(
  request: StructuredResponseRequest,
): Promise<StructuredResponseResult<T>> {
  try {
    return await createStructuredResponse<T>(request);
  } catch (error) {
    if (!(error instanceof NomologiesOpenAIError) || !error.retryable || request.signal?.aborted) {
      throw error;
    }
    if (error.code === "OPENAI_TIMEOUT" && request.fallbackModel && request.fallbackModel !== request.model) {
      return await createStructuredResponse<T>({ ...request, model: request.fallbackModel });
    }
    return await createStructuredResponse<T>(request);
  }
}

export async function createStructuredResponse<T extends JsonRecord = JsonRecord>(
  request: StructuredResponseRequest,
): Promise<StructuredResponseResult<T>> {
  const apiKey = env("OPENAI_API_KEY");
  if (!apiKey) {
    throw new NomologiesOpenAIError(
      "OPENAI_API_KEY_NOT_CONFIGURED",
      "OPENAI_API_KEY is not configured for Nomologies V2.",
      503,
      false,
    );
  }

  const model = request.model || await resolveNomologiesModel(apiKey);
  const timeoutMs = Math.max(20_000, request.timeoutMs || DEFAULT_TIMEOUT_MS);
  const { signal, dispose } = combineSignals(request.signal, timeoutMs);
  const startedAt = Date.now();

  const baseBody: JsonRecord = {
    model,
    store: false,
    input: [
      { role: "system", content: [{ type: "input_text", text: request.system }] },
      { role: "user", content: [{ type: "input_text", text: request.user }] },
    ],
    text: {
      format: {
        type: "json_schema",
        name: request.schemaName.slice(0, 64),
        strict: true,
        schema: request.schema,
      },
    },
    metadata: {
      product: "my-nomos",
      pipeline: "nomologies-v2",
      stage: request.stage.slice(0, 64),
    },
  };
  if (request.effort) baseBody.reasoning = { effort: request.effort };

  try {
    let response = await callResponses(apiKey, baseBody, signal);

    // A compatible non-reasoning model may reject the reasoning object. Retry
    // once without it while keeping the same strict schema and source payload.
    if (response.status === 400 && request.effort) {
      const fallbackBody = { ...baseBody };
      delete fallbackBody.reasoning;
      response = await callResponses(apiKey, fallbackBody, signal);
    }

    if (!response.ok) {
      const status = response.status;
      const provider = await providerErrorSummary(response);
      const providerRef = [provider.type, provider.code].filter(Boolean).join("/");
      const requestRef = provider.requestId ? " · request " + provider.requestId : "";
      const code = status === 429
        ? "OPENAI_RATE_LIMIT"
        : status === 403
        ? "OPENAI_PERMISSION_DENIED"
        : "OPENAI_HTTP_ERROR";
      throw new NomologiesOpenAIError(
        code,
        "OpenAI returned HTTP " + status + " during " + request.stage +
          (providerRef ? " (" + providerRef + ")" : "") + requestRef + ".",
        status === 429 ? 429 : 502,
        retryableStatus(status),
      );
    }

    const payload = await response.json() as JsonRecord;
    const status = str(payload.status);
    if (status && status !== "completed") {
      throw new NomologiesOpenAIError(
        "OPENAI_RESPONSE_INCOMPLETE",
        `OpenAI response did not complete during ${request.stage}.`,
        502,
        true,
      );
    }
    const parsed = parseStrictObject(outputText(payload)) as T;
    return {
      data: parsed,
      responseId: str(payload.id),
      model: str(payload.model) || model,
      elapsedMs: Date.now() - startedAt,
      usage: isRecord(payload.usage) ? payload.usage : {},
    };
  } catch (error) {
    if (error instanceof NomologiesOpenAIError) throw error;
    if (signal.aborted) {
      const userCancelled = !!request.signal?.aborted;
      throw new NomologiesOpenAIError(
        userCancelled ? "REQUEST_CANCELLED" : "OPENAI_TIMEOUT",
        userCancelled
          ? "The Nomologies extraction was cancelled."
          : `The ${request.stage} stage exceeded its safe execution time.`,
        userCancelled ? 408 : 504,
        !userCancelled,
      );
    }
    throw new NomologiesOpenAIError(
      "OPENAI_UNKNOWN_ERROR",
      `The ${request.stage} stage failed unexpectedly.`,
      500,
      false,
    );
  } finally {
    dispose();
  }
}
