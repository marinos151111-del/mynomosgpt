import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const EMBEDDING_MODEL = Deno.env.get("NOMOLOGIES_EMBEDDING_MODEL") || "text-embedding-3-large";
const EMBEDDING_DIMENSIONS = Math.max(256, Math.min(1536, Number(Deno.env.get("NOMOLOGIES_EMBEDDING_DIMENSIONS")) || 1024));
const GATEWAY_KEY_SHA256 = "01292086011cb6217c28fdb63df2a1e83872b6a0a2e26440560f46e6ce4de168";
const SEARCH_VERSION = "nomologies-v10.0.0";
const LEXICAL_TIMEOUT_MS = 1_800;
const SEMANTIC_TIMEOUT_MS = 1_400;
const EMBEDDING_TIMEOUT_MS = 900;
const RATE_LIMIT_PER_MINUTE = Math.max(30, Math.min(600, Number(Deno.env.get("NOMOLOGIES_SEARCH_RATE_LIMIT")) || 120));
const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-nomologies-key",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

function json(value: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...CORS,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function object(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function array(value: unknown): Array<Record<string, any>> {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") as Array<Record<string, any>> : [];
}

function available(field: any, fallback: any = ""): any {
  return field?.status === "available" ? field.value : fallback;
}

function folded(value: unknown): string {
  return String(value || "").toLocaleLowerCase("el").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ς/g, "σ").replace(/[^a-zα-ω0-9/]+/gu, " ").replace(/\s+/g, " ").trim();
}

const MATCH_GREEK_TO_LATIN: Record<string, string> = {
  α:"a",β:"v",γ:"g",δ:"d",ε:"e",ζ:"z",η:"i",θ:"th",ι:"i",κ:"k",λ:"l",μ:"m",ν:"n",
  ξ:"x",ο:"o",π:"p",ρ:"r",σ:"s",ς:"s",τ:"t",υ:"y",φ:"f",χ:"ch",ψ:"ps",ω:"o",
};
function latinFolded(value: unknown): string {
  return folded(value).split("").map((char) => MATCH_GREEK_TO_LATIN[char] ?? char).join("");
}

function matchReasons(row: Record<string, any>, hit: Record<string, any>, query: string): string[] {
  const queryKey = folded(query);
  const fields = new Set(Array.isArray(hit.matched_fields) ? hit.matched_fields.map(String) : []);
  const reasons: string[] = [];
  if (fields.has("identity")) {
    const citationText = folded(`${row.citation || ""} ${row.case_number || ""} ${row.ecli || ""}`);
    const partyText = folded(`${row.title || ""} ${row.short_title || ""}`);
    if (queryKey && citationText.includes(queryKey)) reasons.push("Ταίριασμα παραπομπής");
    else if (queryKey && (partyText.includes(queryKey) || latinFolded(partyText).includes(latinFolded(queryKey)))) reasons.push("Ταίριασμα διαδίκου");
  }
  if (fields.has("provisions")) reasons.push("Ταίριασμα νομοθετικής διάταξης");
  if (fields.has("authorities")) reasons.push("Ταίριασμα παραπεμπόμενης αρχής");
  if (fields.has("concepts")) reasons.push("Ταίριασμα νομικού θέματος");
  if ([...fields].some((field) => ["principle","ratio","holding","issues"].includes(field))) reasons.push("Ταίριασμα νομικής ανάλυσης");
  if ([...fields].some((field) => ["facts","procedure","submissions","full_text"].includes(field))) reasons.push("Ταίριασμα πλήρους κειμένου");
  if (fields.has("filters")) reasons.push("Ταίριασμα φίλτρων");
  return [...new Set(reasons.length ? reasons : ["Σημασιολογικό ταίριασμα"] )];
}

function safeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a[index] ^ b[index];
  return mismatch === 0;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function edgeRuntimeWaitUntil(promise: Promise<unknown>): void {
  const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (value: Promise<unknown>) => void } }).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(promise);
  else void promise;
}

async function requireGateway(request: Request): Promise<Response | null> {
  const supplied = request.headers.get("x-nomologies-key") || "";
  if (!supplied || !safeEqual(await sha256(supplied), GATEWAY_KEY_SHA256)) {
    return json({ ok: false, code: "UNAUTHORIZED", message: "Invalid production gateway credential." }, 401);
  }
  return null;
}

function clientFingerprint(request: Request): string {
  const forwarded = request.headers.get("cf-connecting-ip")
    || request.headers.get("x-real-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
  const agent = request.headers.get("user-agent") || "unknown";
  return `${forwarded}|${agent.slice(0, 180)}`;
}

async function enforceRateLimit(request: Request): Promise<Response | null> {
  try {
    const bucketKey = `search:${await sha256(clientFingerprint(request))}`;
    const result = await db.schema("nomologies").rpc("consume_search_rate_limit", {
      p_bucket_key: bucketKey,
      p_limit: RATE_LIMIT_PER_MINUTE,
      p_window_seconds: 60,
    });
    if (result.error) {
      console.warn("Nomologies search rate limiter degraded", result.error);
      return null;
    }
    if (result.data === false) {
      return json({
        ok: false,
        code: "RATE_LIMITED",
        message: "Too many search requests. Please retry shortly.",
        retryable: true,
      }, 429, { "retry-after": "60" });
    }
  } catch (error) {
    console.warn("Nomologies search rate limiter unavailable", error);
  }
  return null;
}

function classifyIntent(query: string): string {
  const trimmed = query.trim();
  if (trimmed === "*") return "browse";
  if (/(?:^|\s)(?:αρ\.?\s*)?\d{1,5}\s*\/\s*(?:19|20)?\d{2,4}(?:\s|$)/iu.test(trimmed)) return "identity";
  if (/\b(?:ecli:|\[(?:19|20)\d{2}\]|a\.?a\.?d\.?|α\.?α\.?δ\.?|c\.?l\.?r\.?)\b/iu.test(trimmed)) return "citation";
  if (/(?:κεφ\.?|κεφάλαιο|cap\.?|chapter|άρθρο|αρθρο|article|section|s\.)\s*[0-9]/iu.test(trimmed)) return "provision";
  if (/\b(?:v\.?|vs\.?|ν\.?|κατά)\s+/iu.test(trimmed)) return "authority";
  const words = trimmed.split(/\s+/u).filter(Boolean).length;
  if (words >= 6 || /^(?:κατά πόσον|πότε|πώς|ποια|ποιο|τι|can|does|how|when|what|whether|which)\b/iu.test(trimmed)) return "natural_language";
  return "concept";
}

async function recordTelemetry(input: {
  query: string;
  intent: string;
  retrievalMode: string;
  resultCount: number;
  durationMs: number;
  semanticUsed: boolean;
  semanticDegraded: boolean;
  topScore: number | null;
}): Promise<void> {
  try {
    const { error } = await db.schema("nomologies").from("search_query_events").insert({
      query_hash: await sha256(input.query),
      intent: input.intent,
      retrieval_mode: input.retrievalMode,
      result_count: input.resultCount,
      duration_ms: input.durationMs,
      semantic_used: input.semanticUsed,
      semantic_degraded: input.semanticDegraded,
      top_score: input.topScore,
    });
    if (error) console.warn("Nomologies search telemetry insert failed", error);
  } catch (error) {
    console.warn("Nomologies search telemetry unavailable", error);
  }
}

function profile(row: Record<string, any>, hit: Record<string, any>, query: string): Record<string, unknown> {
  const record = object(row.canonical_record);
  const identity = object(record.identity);
  const classification = object(record.classification);
  const analysis = object(record.analysis);
  const facts = object(record.facts);
  const outcome = object(record.outcome);
  const authorities = object(record.authorities);
  const laws = available(authorities.legislation, []);
  const provisions = Array.isArray(laws) ? laws : [];
  const title = available(identity.caseName, row.title || hit.title || "");
  const holding = available(analysis.holding, "");
  const principle = available(analysis.legalPrincipleSummary, holding);

  return {
    ...hit,
    id: hit.case_id,
    caseId: hit.case_id,
    name: title,
    title,
    shortName: available(identity.shortName, row.short_title || hit.short_title || title),
    short_title: row.short_title || hit.short_title || "",
    citation: available(identity.citation, row.citation || hit.citation || ""),
    caseNumber: available(identity.caseNumber, row.case_number || hit.case_number || ""),
    case_number: row.case_number || hit.case_number || "",
    ecli: available(identity.ecli, row.ecli || ""),
    decisionDate: available(identity.decisionDate, row.decision_date || hit.decision_date || ""),
    decision_date: row.decision_date || hit.decision_date || "",
    decisionYear: row.decision_year || null,
    court: available(identity.court, row.court || hit.court || ""),
    judges: available(identity.judges, row.judges || []),
    authorJudge: available(identity.authoringJudges, row.authoring_judges || [])[0] || "",
    caseFamily: available(classification.caseFamily, row.case_family || ""),
    legalArea: available(classification.primaryLegalArea, row.primary_legal_area || ""),
    legalAreas: available(classification.legalAreas, row.legal_areas || []),
    proceedingType: available(classification.proceedingType, row.proceeding_type || ""),
    courtLevel: available(classification.courtLevel, row.court_level || ""),
    outcome: available(outcome.overallOutcome, row.outcome || hit.outcome || ""),
    factsSummary: available(facts.summary, ""),
    legalIssue: available(analysis.dominantIssue, ""),
    holding,
    legalPrinciple: principle,
    ratioDecidendi: available(analysis.ratioDecidendi, []),
    issueTags: record.taxonomy?.issueTags || [],
    keywords: record.taxonomy?.keywords || [],
    articleIds: provisions
      .flatMap((instrument: any) => (instrument.provisions || []).map((item: any) => item.display || item.normalized))
      .filter(Boolean),
    provisions,
    sourceUrl: record.source?.sourceUrl || row.source_url || "",
    readinessScore: record.readinessScore || row.readiness_score || hit.readiness_score || 0,
    strictReady: Boolean(row.strict_ready),
    matchScore: Math.round(Number(hit.score || 0)),
    whyMatched: matchReasons(row, hit, query),
    authorityTier: row.precedential_tier || record.precedentialWeight?.tier || "",
    precedentialWeight: {
      score: Number(row.precedential_score ?? record.precedentialWeight?.score ?? 0),
      tier: row.precedential_tier || record.precedentialWeight?.tier || "Low",
      factors: row.precedential_factors || record.precedentialWeight?.factors || {},
    },
    snippet: principle || holding || available(facts.summary, ""),
  };
}

async function embedQuery(query: string): Promise<number[] | null> {
  if (!OPENAI_KEY || !query.trim()) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("embedding-timeout"), EMBEDDING_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        authorization: `Bearer ${OPENAI_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: query.slice(0, 12_000),
        dimensions: EMBEDDING_DIMENSIONS,
        encoding_format: "float",
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`EMBEDDING_HTTP_${response.status}`);
    const payload = object(await response.json());
    const first = array(payload.data)[0] || {};
    const vector = Array.isArray(first.embedding) ? first.embedding.map(Number).filter(Number.isFinite) : [];
    if (vector.length !== EMBEDDING_DIMENSIONS) throw new Error("EMBEDDING_DIMENSION_MISMATCH");
    return vector;
  } finally {
    clearTimeout(timeout);
  }
}

async function retrieve(
  query: string,
  embedding: number[] | null,
  filters: Record<string, any>,
  matchCount: number,
  timeoutMs: number,
): Promise<Array<Record<string, any>>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("search-timeout"), timeoutMs);
  try {
    const result = await db.schema("nomologies").rpc("hybrid_case_search", {
      query_text: query,
      query_embedding: embedding,
      filters,
      match_count: matchCount,
    }).abortSignal(controller.signal);
    if (result.error) throw new Error(result.error.message);
    return array(result.data);
  } finally {
    clearTimeout(timeout);
  }
}

function semanticFallbackRequired(hits: Array<Record<string, any>>): boolean {
  if (!hits.length) return true;
  const top = hits[0] || {};
  if (Number(top.exact_identity_score || 0) >= 150) return false;
  return hits.length <= 2 || Number(top.score || 0) < 34;
}

async function search(payload: Record<string, unknown>): Promise<Response> {
  const query = string(payload.query || payload.text);
  if (!query) return json({ ok: false, code: "QUERY_REQUIRED", message: "Search query is required." }, 400);
  if (query.length > 1_000) return json({ ok: false, code: "QUERY_TOO_LONG", message: "Search query is too long." }, 400);

  const intent = classifyIntent(query);
  const limit = Math.max(1, Math.min(100, Number(payload.limit) || 20));
  const started = performance.now();
  const filters = object(payload.filters);
  const matchCount = Math.min(200, Math.max(30, limit * 4));
  let ranked: Array<Record<string, any>>;
  try {
    ranked = await retrieve(query, null, filters, matchCount, LEXICAL_TIMEOUT_MS);
  } catch (error) {
    console.error("Nomologies lexical retrieval failed", error);
    return json({
      ok: false,
      code: "SEARCH_UNAVAILABLE",
      message: "The indexed case-law search is temporarily unavailable. Please retry.",
      retryable: true,
    }, 503);
  }

  let semanticAttempted = false;
  let semanticUsed = false;
  let semanticDegraded = false;
  if (payload.semantic !== false && query !== "*" && semanticFallbackRequired(ranked)) {
    semanticAttempted = true;
    try {
      const vector = await embedQuery(query);
      if (!vector) {
        semanticDegraded = true;
      } else {
        const hybrid = await retrieve(query, vector, filters, matchCount, SEMANTIC_TIMEOUT_MS);
        if (hybrid.length || !ranked.length) ranked = hybrid;
        semanticUsed = true;
      }
    } catch (error) {
      semanticDegraded = true;
      console.warn("Nomologies semantic lane degraded to lexical retrieval", error);
    }
  }

  const retrievalMode = semanticUsed ? "hybrid" : semanticDegraded ? "lexical-fallback" : "lexical";
  const ids = ranked.map((hit: any) => string(hit.case_id)).filter(Boolean);
  if (!ids.length) {
    const durationMs = Math.round(performance.now() - started);
    edgeRuntimeWaitUntil(recordTelemetry({
      query,
      intent,
      retrievalMode,
      resultCount: 0,
      durationMs,
      semanticUsed,
      semanticDegraded,
      topScore: null,
    }));
    return json({
      ok: true,
      query,
      searchVersion: SEARCH_VERSION,
      cases: [],
      semanticAttempted,
      semanticUsed,
      semanticDegraded,
      retrievalMode,
      durationMs,
    });
  }

  const [documentsResult, casesResult] = await Promise.all([
    db.schema("nomologies").from("case_search_documents")
      .select("case_id,case_version_id,source_url,title,short_title,citation,case_number,ecli,decision_date,decision_year,court,court_level,case_family,primary_legal_area,legal_areas,proceeding_type,procedural_posture,outcome,judges,authoring_judges,principle_ids,precedential_score,precedential_tier,precedential_factors,readiness_score,strict_ready,canonical_record")
      .in("case_id", ids),
    db.schema("nomologies").from("cases")
      .select("id,current_version_id,publication_status")
      .in("id", ids)
      .eq("publication_status", "published"),
  ]);
  const lookupError = documentsResult.error || casesResult.error;
  if (lookupError) return json({ ok: false, code: "SEARCH_ENRICHMENT_FAILED", message: lookupError.message }, 500);

  const publishedVersions = new Map<string, string>(
    (casesResult.data || []).map((row: any): [string, string] => [string(row.id), string(row.current_version_id)]),
  );
  const documents = new Map<string, Record<string, any>>(
    (documentsResult.data || [])
      .filter((row: any) => publishedVersions.get(string(row.case_id)) === string(row.case_version_id))
      .map((row: any): [string, Record<string, any>] => [string(row.case_id), row]),
  );
  const cases = ranked
    .filter((hit: any) => documents.has(string(hit.case_id)))
    .map((hit: any) => profile(documents.get(string(hit.case_id)) || {}, hit, query))
    .slice(0, limit);
  const durationMs = Math.round(performance.now() - started);

  edgeRuntimeWaitUntil(recordTelemetry({
    query,
    intent,
    retrievalMode,
    resultCount: cases.length,
    durationMs,
    semanticUsed,
    semanticDegraded,
    topScore: ranked.length ? Number(ranked[0].score || 0) : null,
  }));

  return json({
    ok: true,
    query,
    searchVersion: SEARCH_VERSION,
    cases,
    semanticAttempted,
    semanticUsed,
    semanticDegraded,
    retrievalMode,
    durationMs,
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const unauthorized = await requireGateway(request);
  if (unauthorized) return unauthorized;
  const rateLimited = await enforceRateLimit(request);
  if (rateLimited) return rateLimited;

  try {
    const path = new URL(request.url).pathname.replace(/^\/nomologies-search\/?/, "/");
    if (request.method === "GET" && path === "/health") {
      return json({
        ok: true,
        service: "nomologies-search",
        version: SEARCH_VERSION,
        mode: "index-first-hybrid",
        lexicalAuthoritative: true,
        controlledSynonymExpansion: true,
        phraseProximityReranking: true,
        rateLimitPerMinute: RATE_LIMIT_PER_MINUTE,
        telemetry: "query-hash-only",
        semanticConfigured: Boolean(OPENAI_KEY),
        embeddingModel: EMBEDDING_MODEL,
        embeddingDimensions: EMBEDDING_DIMENSIONS,
      });
    }
    if (request.method === "POST" && (path === "/" || path === "/search")) {
      return search(object(await request.json()));
    }
    return json({ ok: false, code: "NOT_FOUND" }, 404);
  } catch (error) {
    console.error(error);
    return json({ ok: false, code: "SERVER_ERROR", message: error instanceof Error ? error.message : String(error) }, 500);
  }
});
