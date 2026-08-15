import { CORE_V3_MODEL } from "./types.ts";

type JsonRecord = Record<string, unknown>;

export interface CoreStructuredRequest {
  stage: string;
  schemaName: string;
  schema: JsonRecord;
  system: string;
  user: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
}

export interface CoreStructuredResult<T extends JsonRecord = JsonRecord> {
  data: T;
  model: string;
  responseId: string;
  elapsedMs: number;
  usage: JsonRecord;
}

export class CoreV3OpenAIError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status = 500,
  ) {
    super(message);
    this.name = "CoreV3OpenAIError";
  }
}

function env(name: string): string {
  try { return String(Deno.env.get(name) || "").trim(); }
  catch { return ""; }
}
function object(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

function outputText(payload: JsonRecord): string {
  const direct = text(payload.output_text);
  if (direct) return direct;
  const parts: string[] = [];
  for (const item of array(payload.output)) {
    for (const content of array(object(item).content)) {
      const row = object(content);
      if (text(row.type) === "output_text" && text(row.text)) parts.push(text(row.text));
    }
  }
  return parts.join("").trim();
}

async function call(request: CoreStructuredRequest, includeReasoning: boolean): Promise<CoreStructuredResult> {
  const apiKey = env("OPENAI_API_KEY");
  if (!apiKey) throw new CoreV3OpenAIError("OPENAI_API_KEY_MISSING", "OPENAI_API_KEY is not configured.", false, 503);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("core-v3-timeout"), Math.max(30_000, request.timeoutMs || 120_000));
  const started = Date.now();
  try {
    const body: JsonRecord = {
      model: CORE_V3_MODEL,
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
      max_output_tokens: Math.max(512, request.maxOutputTokens || 9000),
      metadata: { product: "mynomosaigpt", pipeline: "elite-core-v3", stage: request.stage.slice(0, 64) },
    };
    if (includeReasoning) body.reasoning = { effort: "low" };

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = object(await response.json().catch(() => ({})));
    if (!response.ok) {
      const provider = object(payload.error);
      const code = text(provider.code) || `HTTP_${response.status}`;
      const message = text(provider.message) || `OpenAI returned HTTP ${response.status}.`;
      throw new CoreV3OpenAIError(
        response.status === 429 ? "OPENAI_RATE_LIMIT" : response.status >= 500 ? "OPENAI_SERVER_ERROR" : code,
        `${request.stage}: ${message}`,
        response.status === 408 || response.status === 429 || response.status >= 500,
        response.status,
      );
    }
    if (text(payload.status) && text(payload.status) !== "completed") {
      throw new CoreV3OpenAIError("OPENAI_INCOMPLETE", `${request.stage}: response did not complete.`, true, 502);
    }
    const raw = outputText(payload);
    if (!raw) throw new CoreV3OpenAIError("EMPTY_STRUCTURED_OUTPUT", `${request.stage}: empty output.`, true, 502);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw new CoreV3OpenAIError("INVALID_STRUCTURED_OUTPUT", `${request.stage}: invalid JSON output.`, true, 502); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CoreV3OpenAIError("INVALID_STRUCTURED_OUTPUT", `${request.stage}: output was not an object.`, true, 502);
    }
    return {
      data: parsed as JsonRecord,
      model: text(payload.model) || CORE_V3_MODEL,
      responseId: text(payload.id),
      elapsedMs: Date.now() - started,
      usage: object(payload.usage),
    };
  } catch (error) {
    if (error instanceof CoreV3OpenAIError) throw error;
    if (controller.signal.aborted) throw new CoreV3OpenAIError("OPENAI_TIMEOUT", `${request.stage}: exceeded the safe execution time.`, true, 504);
    throw new CoreV3OpenAIError("OPENAI_NETWORK_ERROR", `${request.stage}: ${error instanceof Error ? error.message : String(error)}`, true, 502);
  } finally {
    clearTimeout(timeout);
  }
}

export async function coreStructuredResponse<T extends JsonRecord = JsonRecord>(request: CoreStructuredRequest): Promise<CoreStructuredResult<T>> {
  try {
    return await call(request, true) as CoreStructuredResult<T>;
  } catch (error) {
    if (error instanceof CoreV3OpenAIError && error.status === 400) {
      return await call(request, false) as CoreStructuredResult<T>;
    }
    throw error;
  }
}
