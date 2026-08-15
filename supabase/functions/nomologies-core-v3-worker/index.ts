import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { fetchCyLawJudgment } from "https://raw.githubusercontent.com/marinos151111-del/mynomosgpt/186ff106df99541e2604eab64ba43921d5c88cf2/src/nomologies-v2/cylaw.ts";
import { prepareJudgmentSource } from "https://raw.githubusercontent.com/marinos151111-del/mynomosgpt/186ff106df99541e2604eab64ba43921d5c88cf2/src/nomologies-v2/source.ts";
import { createStructuredResponse } from "https://raw.githubusercontent.com/marinos151111-del/mynomosgpt/186ff106df99541e2604eab64ba43921d5c88cf2/src/nomologies-v2/openai-responses.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const MODEL = "gpt-5.4-mini";
const CORE_KEY_SHA256 = "7879b042028414d220805a8e229010a1786cc6070a56e2510a35e8ec322106c8";
const ARTIFACT_BUCKET = "nomologies-artifacts";
const MAX_CONTEXT_CHARS = 220_000;
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const workerName = `core-v3-${crypto.randomUUID().slice(0, 8)}`;

type Row = Record<string, any>;
type Task = Row & { id: string; run_id: string; stage: "source" | "extract" | "verify"; attempt_count: number; max_attempts: number };
type Evidence = { paragraphIds: string[]; quote: string };
type ClaimMeta = { path: string; type: string; required: boolean; index?: number };

const STATUS = ["available", "not_found", "review"] as const;
const OUTCOMES = [
  "appeal_allowed", "appeal_partly_allowed", "appeal_dismissed",
  "application_allowed", "application_partly_allowed", "application_dismissed",
  "conviction_upheld", "conviction_quashed", "acquitted", "remitted",
  "withdrawn", "other", "unknown",
] as const;
const FAMILIES = ["civil", "criminal", "administrative", "constitutional", "family", "employment", "disciplinary", "mixed", "other"] as const;
const JUDGE_ROLES = ["presiding", "authoring", "panel", "concurring", "dissenting", "unknown"] as const;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
function object(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}; }
function array(value: unknown): any[] { return Array.isArray(value) ? value : []; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function meaningful(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return !!value && typeof value === "object" && Object.keys(value as Row).length > 0;
}
function normalize(value: string): string {
  return String(value || "").normalize("NFC").replace(/[\u00a0\u2007\u202f]/g, " ").replace(/\s+/gu, " ").trim();
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function safeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left); const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let mismatch = 0; for (let i = 0; i < a.length; i += 1) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}
async function authorized(req: Request): Promise<boolean> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (SERVICE_KEY && safeEqual(bearer, SERVICE_KEY)) return true;
  const supplied = req.headers.get("x-core-v3-key") || "";
  return Boolean(supplied && safeEqual(await sha256(supplied), CORE_KEY_SHA256));
}
function waitUntil(promise: Promise<unknown>): void {
  const runtime = (globalThis as any).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(promise); else void promise;
}

const S = { string: { type: "string" }, number: { type: "number", minimum: 0, maximum: 1 }, boolean: { type: "boolean" } };
function enumeration(values: readonly string[]): Row { return { type: "string", enum: [...values] }; }
function arr(items: Row): Row { return { type: "array", items }; }
function obj(properties: Row): Row { return { type: "object", properties, required: Object.keys(properties), additionalProperties: false }; }
const EVIDENCE_SCHEMA = obj({ paragraphIds: arr(S.string), quote: S.string });
function scalar(value: Row): Row { return obj({ status: enumeration(STATUS), value, confidence: S.number, evidence: arr(EVIDENCE_SCHEMA) }); }
function list(item: Row): Row { return obj({ status: enumeration(STATUS), value: arr(item), confidence: S.number }); }

const JUDGE_SCHEMA = obj({ name: S.string, role: enumeration(JUDGE_ROLES), evidence: arr(EVIDENCE_SCHEMA) });
const IDENTITY_SCHEMA = obj({
  identity: obj({
    caseName: scalar(S.string),
    caseNumber: scalar(S.string),
    court: scalar(S.string),
    decisionDate: scalar(S.string),
    caseFamily: scalar(enumeration(FAMILIES)),
    judicialComposition: list(JUDGE_SCHEMA),
  }),
});
const LEGAL_ISSUE_SCHEMA = obj({ issue: S.string, principle: S.string, holding: S.string, evidence: arr(EVIDENCE_SCHEMA) });
const OBITER_SCHEMA = obj({ text: S.string, evidence: arr(EVIDENCE_SCHEMA) });
const LEGAL_SCHEMA = obj({
  facts: obj({ materialFacts: scalar(obj({ summary: S.string, points: arr(S.string) })) }),
  analysis: obj({ legalIssues: list(LEGAL_ISSUE_SCHEMA), obiterDicta: list(OBITER_SCHEMA) }),
});
const ORDER_SCHEMA = obj({ category: enumeration(["disposition", "order", "remittal", "retrial", "other"]), text: S.string, evidence: arr(EVIDENCE_SCHEMA) });
const MONEY_SCHEMA = obj({
  type: enumeration(["damages", "compensation", "costs", "fine", "interest", "other"]),
  stage: enumeration(["first_instance", "appeal", "retrial", "not_applicable", "other"]),
  amount: S.string,
  currency: S.string,
  fixed: S.boolean,
  status: enumeration(["fixed", "to_be_assessed", "not_stated", "open"]),
  payer: S.string,
  payee: S.string,
  interest: S.string,
  evidence: arr(EVIDENCE_SCHEMA),
});
const PROVISION_SCHEMA = obj({ display: S.string, article: S.string, application: enumeration(["applied", "interpreted", "considered", "mentioned", "not_applied"]), evidence: arr(EVIDENCE_SCHEMA) });
const INSTRUMENT_SCHEMA = obj({
  name: S.string,
  lawId: S.string,
  role: enumeration(["substantive", "procedural", "jurisdictional", "evidential", "remedial", "constitutional", "background"]),
  provisions: arr(PROVISION_SCHEMA),
  proposition: S.string,
  evidence: arr(EVIDENCE_SCHEMA),
});
const AUTHORITY_SCHEMA = obj({
  name: S.string,
  citation: S.string,
  treatment: enumeration(["applied", "followed", "adopted", "approved", "distinguished", "considered", "cited", "mentioned"]),
  legalPoint: S.string,
  evidence: arr(EVIDENCE_SCHEMA),
});
const OUTCOME_SCHEMA = obj({
  outcome: obj({
    overallOutcome: scalar(enumeration(OUTCOMES)),
    dispositionText: scalar(S.string),
    orders: list(ORDER_SCHEMA),
    monetary: list(MONEY_SCHEMA),
  }),
  authorities: obj({
    legislation: list(INSTRUMENT_SCHEMA),
    authorities: list(AUTHORITY_SCHEMA),
  }),
});
const VERIFIER_SCHEMA = obj({
  checks: arr(obj({ id: S.string, verdict: enumeration(["accept", "reject", "review"]), reason: S.string })),
  overallComment: S.string,
});

const COMMON = `You are a senior Cyprus case-law analyst. Work only from the supplied official CyLaw judgment paragraphs.
ABSOLUTE RULES:
1. Every available field or list item must cite exact paragraph IDs and an exact verbatim quote.
2. A party submission is not a judicial finding. A quotation from another case is not the present court's holding, ratio, order or obiter.
3. Preserve names, case numbers, dates, statutory references and amounts exactly as printed.
4. Use Greek for summaries. Keep them concise and lawyer-facing.
5. Use not_found when the judgment does not state the matter. Use review when the source is genuinely ambiguous.
6. Do not invent. Return only the strict JSON schema.`;

const IDENTITY_PROMPT = `${COMMON}
TASK: Extract only the case header and court composition.
- caseName, caseNumber, court, decisionDate.
- caseFamily: civil, criminal, administrative, constitutional, family, employment, disciplinary, mixed or other.
- judicialComposition: every deciding judge. Distinguish presiding from authoring/delivering judge. Do not treat advocates as judges.
Do not extract facts, issues, authorities or outcome.`;

const LEGAL_PROMPT = `${COMMON}
TASK: Extract the concise lawyer-facing legal core only.
- materialFacts: one coherent summary of 3-6 sentences plus 3-8 short material fact points. No submissions, law or final outcome.
- legalIssues: normally 1-3 issues. State each issue in simple Greek, then one concise general legal principle and one concise case-specific holding.
- obiterDicta: only a genuine non-essential observation made by the present court. If none is clearly identifiable, return not_found with an empty list.
Do not generate chronology, witnesses, evidence inventories, detailed submissions or exhaustive grounds.`;

const OUTCOME_PROMPT = `${COMMON}
TASK: Extract the operative outcome and the legal sources.
- overallOutcome and complete dispositionText from the present court's final order only.
- orders and every monetary item separately. Never copy damages into costs. If costs are to be assessed by the Registrar, amount must be empty, fixed=false and status=to_be_assessed.
- legislation: correct instrument, exact article/rule, role, application and proposition. Ownership must be explicit in the same or contiguous cited paragraphs.
- authorities: only decisions used by the present court, with printed citation, treatment and legal point. A case nested inside a quotation is not automatically a direct authority.
Do not use earlier orders, party requests or quoted judgments as the present disposition.`;

const VERIFIER_PROMPT = `You are the final legal attribution verifier for a Cyprus case-law database.
For each numbered claim, decide:
- accept: the cited source proves the claim and attribution;
- reject: the claim is wrong, unsupported, misattributed or uses the wrong law/amount/judge role;
- review: the source is ambiguous and needs a human.
MANDATORY CHECKS:
- present court versus party submissions and quoted authorities;
- final disposition versus earlier/quoted orders;
- damages, costs, interest and stages kept separate;
- provision belongs to the stated instrument;
- authoring judge differs from presiding judge where applicable;
- obiter must be a non-essential observation of the present court.
Do not rewrite claims. Return one check for every supplied id.`;

async function uploadJson(path: string, payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const { error } = await db.storage.from(ARTIFACT_BUCKET).upload(path, bytes, { contentType: "application/json", upsert: true });
  if (error) throw new Error(`ARTIFACT_UPLOAD_FAILED:${error.message}`);
  return path;
}
async function downloadJson(path: string): Promise<any> {
  const { data, error } = await db.storage.from(ARTIFACT_BUCKET).download(path);
  if (error || !data) throw new Error(`ARTIFACT_DOWNLOAD_FAILED:${error?.message || path}`);
  return JSON.parse(await data.text());
}
async function runRow(runId: string): Promise<Row> {
  const { data, error } = await db.schema("nomologies").from("core_v3_runs").select("*").eq("id", runId).single();
  if (error) throw new Error(`RUN_READ_FAILED:${error.message}`);
  return data;
}
async function claim(): Promise<Task | null> {
  const { data, error } = await db.schema("nomologies").rpc("claim_core_v3_task", { worker_name: workerName, lease_seconds: 240 });
  if (error) throw new Error(`TASK_CLAIM_FAILED:${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return row?.id ? row as Task : null;
}
async function finish(task: Task, result: Row = {}): Promise<void> {
  const { error } = await db.schema("nomologies").from("core_v3_tasks").update({
    status: "succeeded", result, completed_at: new Date().toISOString(), locked_at: null, locked_until: null, locked_by: "", last_error_code: "", last_error_message: "", updated_at: new Date().toISOString(),
  }).eq("id", task.id);
  if (error) throw new Error(`TASK_FINISH_FAILED:${error.message}`);
}
async function fail(task: Task, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.split(":")[0].slice(0, 120) || "CORE_V3_ERROR";
  const terminal = task.attempt_count >= task.max_attempts;
  await db.schema("nomologies").from("core_v3_tasks").update({
    status: terminal ? "failed" : "retry",
    available_at: new Date(Date.now() + Math.min(180_000, 15_000 * Math.max(1, task.attempt_count))).toISOString(),
    completed_at: terminal ? new Date().toISOString() : null,
    locked_at: null, locked_until: null, locked_by: "",
    last_error_code: code, last_error_message: message.slice(0, 1000), updated_at: new Date().toISOString(),
  }).eq("id", task.id);
  await db.schema("nomologies").from("core_v3_runs").update({
    status: terminal ? "failed" : "running", current_stage: task.stage,
    error_code: terminal ? code : "", error_message: terminal ? message.slice(0, 1000) : "",
    completed_at: terminal ? new Date().toISOString() : null, updated_at: new Date().toISOString(),
  }).eq("id", task.run_id);
}
async function enqueue(runId: string, stage: Task["stage"], priority: number): Promise<void> {
  const { error } = await db.schema("nomologies").from("core_v3_tasks").upsert({
    run_id: runId, stage, status: "queued", priority, available_at: new Date().toISOString(),
    attempt_count: 0, locked_at: null, locked_until: null, locked_by: "", last_error_code: "", last_error_message: "", updated_at: new Date().toISOString(),
  }, { onConflict: "run_id,stage" });
  if (error) throw new Error(`TASK_ENQUEUE_FAILED:${error.message}`);
}
async function invokeNext(): Promise<void> {
  await fetch(`${SUPABASE_URL}/functions/v1/nomologies-core-v3-worker`, {
    method: "POST", headers: { authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json" }, body: "{}",
  }).catch(() => undefined);
}

function sourceContext(source: Row): string {
  const paragraphs = array(source.paragraphs);
  const all = paragraphs.map((p: Row) => `[${p.id}] ${p.text}`);
  const joined = all.join("\n\n");
  if (joined.length <= MAX_CONTEXT_CHARS) return joined;

  const selected = new Map<number, string>();
  const keep = (index: number) => { if (index >= 0 && index < all.length) selected.set(index, all[index]); };
  for (let i = 0; i < Math.min(70, all.length); i += 1) keep(i);
  for (let i = Math.max(0, all.length - 100); i < all.length; i += 1) keep(i);
  const signal = /(λόγ(?:ος|οι) έφεσης|νομικό ζήτημα|κρίνουμε|καταλήγουμε|ratio|obiter|άρθρο|κανονισμ|νόμ|κεφ\.|έξοδα|€|αποζημί|διατάσσεται|απορρίπτεται|επιτρέπεται|judgment|costs|order)/iu;
  paragraphs.forEach((p: Row, index: number) => { if (signal.test(String(p.text || ""))) { keep(index - 1); keep(index); keep(index + 1); } });
  const step = Math.max(1, Math.floor(all.length / 80));
  for (let i = 0; i < all.length; i += step) keep(i);
  return [...selected.entries()].sort((a, b) => a[0] - b[0]).map(([, line]) => line).join("\n\n").slice(0, MAX_CONTEXT_CHARS);
}

async function callAgent(schemaName: string, schema: Row, system: string, source: string, repair?: { paths: string[]; previous: Row }): Promise<Row> {
  const user = JSON.stringify({
    contract: "elite-core-v3",
    sourceParagraphs: source,
    ...(repair ? { repair: { instruction: "Correct only the listed failed fields. Preserve all supported fields and return the complete schema.", paths: repair.paths, previous: repair.previous } } : {}),
  });
  const response = await createStructuredResponse({
    stage: repair ? `core-v3-repair-${schemaName}` : `core-v3-${schemaName}`,
    schemaName: `core_v3_${schemaName}`,
    schema,
    system: repair ? `${system}\n\nTARGETED REPAIR: Re-check only the listed paths against the source. Never guess.` : system,
    user,
    effort: "low",
    model: MODEL,
    timeoutMs: 150_000,
  });
  return { data: response.data, audit: { model: response.model, responseId: response.responseId, elapsedMs: response.elapsedMs, usage: response.usage } };
}

function paragraphMap(source: Row): { byId: Map<string, Row>; ordinal: Map<string, number> } {
  const byId = new Map<string, Row>(); const ordinal = new Map<string, number>();
  for (const p of array(source.paragraphs)) { byId.set(String(p.id), p); ordinal.set(String(p.id), Number(p.ordinal || 0)); }
  return { byId, ordinal };
}
function validateEvidence(raw: unknown, source: Row): { valid: Evidence[]; errors: string[] } {
  const { byId, ordinal } = paragraphMap(source);
  const valid: Evidence[] = []; const errors: string[] = [];
  for (const [index, item] of array(raw).entries()) {
    const row = object(item); const ids = array(row.paragraphIds).map(String).filter(Boolean); const quote = text(row.quote);
    if (!ids.length || !quote) { errors.push(`evidence_${index + 1}_missing`); continue; }
    const rows = ids.map((id) => byId.get(id));
    if (rows.some((p) => !p)) { errors.push(`evidence_${index + 1}_paragraph_missing`); continue; }
    const ords = ids.map((id) => ordinal.get(id) || 0).sort((a, b) => a - b);
    if (ords.some((value, i) => i > 0 && value !== ords[i - 1] + 1)) { errors.push(`evidence_${index + 1}_noncontiguous`); continue; }
    const hay = normalize(rows.map((p) => String(p?.text || "")).join(" "));
    if (!hay.includes(normalize(quote))) { errors.push(`evidence_${index + 1}_quote_not_found`); continue; }
    valid.push({ paragraphIds: ids, quote });
  }
  return { valid, errors };
}
function validateScalar(field: Row, path: string, source: Row, blockers: Row[]): Row {
  const status = STATUS.includes(field.status) ? field.status : "review";
  if (status !== "available") return { status, value: field.value ?? "", confidence: Number(field.confidence || 0), evidence: [] };
  const checked = validateEvidence(field.evidence, source);
  if (!meaningful(field.value) || !checked.valid.length) {
    blockers.push({ code: "FIELD_NOT_GROUNDED", path, message: `${path} is available but lacks exact evidence.`, errors: checked.errors });
    return { status: "review", value: field.value ?? "", confidence: 0, evidence: checked.valid };
  }
  return { status: "available", value: field.value, confidence: Number(field.confidence || 0), evidence: checked.valid };
}
function validateList(field: Row, path: string, source: Row, blockers: Row[]): Row {
  const status = STATUS.includes(field.status) ? field.status : "review";
  if (status !== "available") return { status, value: [], confidence: Number(field.confidence || 0) };
  const output: Row[] = [];
  for (const [index, raw] of array(field.value).entries()) {
    const item = object(raw); const checked = validateEvidence(item.evidence, source);
    if (!checked.valid.length) {
      blockers.push({ code: "ITEM_NOT_GROUNDED", path: `${path}[${index}]`, message: `${path}[${index}] lacks exact evidence.`, errors: checked.errors });
      continue;
    }
    if (path === "authorities.legislation") {
      const provisions: Row[] = [];
      for (const [provisionIndex, rawProvision] of array(item.provisions).entries()) {
        const provision = object(rawProvision);
        const provisionEvidence = validateEvidence(provision.evidence, source);
        if (!provisionEvidence.valid.length) {
          blockers.push({ code: "PROVISION_NOT_GROUNDED", path: `${path}[${index}].provisions[${provisionIndex}]`, message: "The provision is not tied to exact source evidence.", errors: provisionEvidence.errors });
          continue;
        }
        provisions.push({ ...provision, evidence: provisionEvidence.valid });
      }
      if (!provisions.length && array(item.provisions).length) {
        blockers.push({ code: "INSTRUMENT_PROVISIONS_REJECTED", path: `${path}[${index}]`, message: "All provisions for the instrument failed exact ownership validation." });
        continue;
      }
      output.push({ ...item, provisions, evidence: checked.valid });
      continue;
    }
    output.push({ ...item, evidence: checked.valid });
  }
  if (!output.length && array(field.value).length) {
    blockers.push({ code: "FIELD_ITEMS_REJECTED", path, message: `All proposed ${path} items failed deterministic evidence validation.` });
    return { status: "review", value: [], confidence: 0 };
  }
  return { status: output.length ? "available" : "not_found", value: output, confidence: Number(field.confidence || 0) };
}
function deterministicCandidate(raw: Row, source: Row): { candidate: Row; blockers: Row[] } {
  const blockers: Row[] = [];
  const identity = object(raw.identity); const facts = object(raw.facts); const analysis = object(raw.analysis); const outcome = object(raw.outcome); const authorities = object(raw.authorities);
  return {
    candidate: {
      identity: {
        caseName: validateScalar(object(identity.caseName), "identity.caseName", source, blockers),
        caseNumber: validateScalar(object(identity.caseNumber), "identity.caseNumber", source, blockers),
        court: validateScalar(object(identity.court), "identity.court", source, blockers),
        decisionDate: validateScalar(object(identity.decisionDate), "identity.decisionDate", source, blockers),
        caseFamily: validateScalar(object(identity.caseFamily), "identity.caseFamily", source, blockers),
        judicialComposition: validateList(object(identity.judicialComposition), "identity.judicialComposition", source, blockers),
      },
      facts: { materialFacts: validateScalar(object(facts.materialFacts), "facts.materialFacts", source, blockers) },
      analysis: {
        legalIssues: validateList(object(analysis.legalIssues), "analysis.legalIssues", source, blockers),
        obiterDicta: validateList(object(analysis.obiterDicta), "analysis.obiterDicta", source, blockers),
      },
      outcome: {
        overallOutcome: validateScalar(object(outcome.overallOutcome), "outcome.overallOutcome", source, blockers),
        dispositionText: validateScalar(object(outcome.dispositionText), "outcome.dispositionText", source, blockers),
        orders: validateList(object(outcome.orders), "outcome.orders", source, blockers),
        monetary: validateList(object(outcome.monetary), "outcome.monetary", source, blockers),
      },
      authorities: {
        legislation: validateList(object(authorities.legislation), "authorities.legislation", source, blockers),
        authorities: validateList(object(authorities.authorities), "authorities.authorities", source, blockers),
      },
    },
    blockers,
  };
}

function getPath(root: Row, path: string): any { return path.split(".").reduce((current: any, key) => object(current)[key], root); }
function setPath(root: Row, path: string, value: any): void {
  const parts = path.split("."); let current = root;
  for (const key of parts.slice(0, -1)) { current[key] = object(current[key]); current = current[key]; }
  current[parts.at(-1)!] = value;
}
function rootPath(path: string): string { return path.replace(/\[\d+\].*$/, ""); }
function requiredPath(path: string): boolean {
  return ["identity.caseName", "identity.caseNumber", "identity.court", "identity.decisionDate", "identity.caseFamily", "identity.judicialComposition", "facts.materialFacts", "analysis.legalIssues", "outcome.overallOutcome", "outcome.dispositionText"].some((required) => path.startsWith(required));
}
function repairGroup(path: string): "identity" | "legal" | "outcome" {
  if (path.startsWith("identity.")) return "identity";
  if (path.startsWith("facts.") || path.startsWith("analysis.")) return "legal";
  return "outcome";
}
function mergeRepair(original: Row, repaired: Row, paths: string[]): Row {
  const next = structuredClone(original);
  for (const path of [...new Set(paths.map(rootPath))]) {
    const replacement = getPath(repaired, path);
    if (replacement !== undefined) setPath(next, path, replacement);
  }
  return next;
}

function claimText(path: string, value: any): string {
  if (path.includes("judicialComposition")) return `${value.name} — ${value.role}`;
  if (path.includes("legalIssues")) return `Ζήτημα: ${value.issue}\nΑρχή: ${value.principle}\nΚρίση: ${value.holding}`;
  if (path.includes("obiterDicta")) return value.text;
  if (path.includes("orders")) return `${value.category}: ${value.text}`;
  if (path.includes("monetary")) return `${value.type}; stage=${value.stage}; amount=${value.amount}; status=${value.status}; payer=${value.payer}; payee=${value.payee}; interest=${value.interest}`;
  if (path.includes("legislation")) return `${value.name} ${value.lawId}; role=${value.role}; provisions=${array(value.provisions).map((p) => `${p.display} (${p.application})`).join(", ")}; proposition=${value.proposition}`;
  if (path.includes("authorities.authorities")) return `${value.name}; ${value.citation}; ${value.treatment}; ${value.legalPoint}`;
  return typeof value === "string" ? value : JSON.stringify(value);
}
function evidenceForValue(value: any): Evidence[] { return array(object(value).evidence) as Evidence[]; }
function buildClaims(candidate: Row, source: Row): { claims: Row[]; meta: Map<string, ClaimMeta> } {
  const { ordinal } = paragraphMap(source); const paragraphs = array(source.paragraphs); const claims: Row[] = []; const meta = new Map<string, ClaimMeta>();
  const add = (id: string, path: string, type: string, value: any, evidence: Evidence[], required = false, index?: number) => {
    const contexts = evidence.map((anchor) => {
      const ids = anchor.paragraphIds; const indexes = ids.map((pid) => (ordinal.get(pid) || 1) - 1);
      const start = Math.max(0, Math.min(...indexes) - 1); const end = Math.min(paragraphs.length, Math.max(...indexes) + 2);
      return { cited: anchor, context: paragraphs.slice(start, end).map((p: Row) => `[${p.id}] ${p.text}`).join("\n") };
    });
    claims.push({ id, path, type, claim: claimText(path, value), evidenceContexts: contexts });
    meta.set(id, { path, type, required, index });
  };
  const scalarPaths = ["identity.caseName", "identity.caseNumber", "identity.court", "identity.decisionDate", "identity.caseFamily", "facts.materialFacts", "outcome.overallOutcome", "outcome.dispositionText"];
  for (const path of scalarPaths) {
    const field = object(getPath(candidate, path)); if (field.status === "available") add(path, path, path, field.value, array(field.evidence), requiredPath(path));
  }
  const listPaths = ["identity.judicialComposition", "analysis.legalIssues", "analysis.obiterDicta", "outcome.orders", "outcome.monetary", "authorities.legislation", "authorities.authorities"];
  for (const path of listPaths) {
    const field = object(getPath(candidate, path)); if (field.status !== "available") continue;
    array(field.value).forEach((item, index) => add(`${path}[${index}]`, path, path, item, evidenceForValue(item), requiredPath(path), index));
  }
  return { claims, meta };
}
function applyVerifier(candidate: Row, verification: Row, meta: Map<string, ClaimMeta>, blockers: Row[]): Row {
  const next = structuredClone(candidate); const verdicts = new Map(array(verification.checks).map((check: Row) => [String(check.id), check]));
  const rejectedByPath = new Map<string, Set<number>>();
  for (const [id, item] of meta.entries()) {
    const check = object(verdicts.get(id)); const verdict = String(check.verdict || "review");
    if (verdict === "accept") continue;
    blockers.push({ code: verdict === "reject" ? "VERIFIER_REJECTED" : "VERIFIER_REVIEW", path: id, message: String(check.reason || "Final verifier did not accept the claim."), required: item.required });
    if (item.index === undefined) {
      const field = object(getPath(next, item.path)); setPath(next, item.path, { ...field, status: "review", confidence: 0 });
    } else {
      const set = rejectedByPath.get(item.path) || new Set<number>(); set.add(item.index); rejectedByPath.set(item.path, set);
    }
  }
  for (const [path, indexes] of rejectedByPath) {
    const field = object(getPath(next, path)); const kept = array(field.value).filter((_item, index) => !indexes.has(index));
    setPath(next, path, { ...field, status: kept.length ? "available" : "review", value: kept, confidence: kept.length ? field.confidence : 0 });
  }
  return next;
}
function fieldAvailable(root: Row, path: string): boolean {
  const field = object(getPath(root, path)); return field.status === "available" && meaningful(field.value);
}
function weightFor(record: Row): "Υψηλή" | "Μέση" | "Χαμηλή" {
  const court = text(object(getPath(record, "identity.court")).value).toLocaleLowerCase("el");
  const issues = array(object(getPath(record, "analysis.legalIssues")).value);
  const outcome = text(object(getPath(record, "outcome.overallOutcome")).value);
  const senior = /ανώτατο|εφετείο|supreme|court of appeal/u.test(court);
  const proceduralOnly = /application_/.test(outcome) && issues.every((item) => /διαδικασ|αίτησ|δικαιοδοσ/u.test(`${item.issue} ${item.principle}`));
  if (senior && issues.length && !proceduralOnly) return "Υψηλή";
  if (senior || issues.length) return "Μέση";
  return "Χαμηλή";
}
function primaryLegislation(record: Row): string[] {
  const list = array(object(getPath(record, "authorities.legislation")).value);
  return list.filter((item) => item.role !== "background" && array(item.provisions).some((p) => ["applied", "interpreted", "considered"].includes(p.application)))
    .slice(0, 4).map((item) => `${item.name}${item.lawId ? ` (${item.lawId})` : ""} — ${array(item.provisions).map((p) => p.display).join(", ")}`);
}
function countMetric(record: Row, path: string): number { const field = object(getPath(record, path)); return Array.isArray(field.value) ? field.value.length : meaningful(field.value) ? 1 : 0; }
async function baselineMetrics(run: Row, record: Row): Promise<Row> {
  let baseline: Row = {};
  if (run.baseline_version_id) {
    const { data } = await db.schema("nomologies").from("case_versions").select("canonical_record,readiness_score").eq("id", run.baseline_version_id).maybeSingle();
    baseline = object(data?.canonical_record);
  }
  return {
    model: MODEL,
    candidate: {
      judges: countMetric(record, "identity.judicialComposition"), issues: countMetric(record, "analysis.legalIssues"), obiter: countMetric(record, "analysis.obiterDicta"),
      legislation: countMetric(record, "authorities.legislation"), authorities: countMetric(record, "authorities.authorities"), orders: countMetric(record, "outcome.orders"), monetary: countMetric(record, "outcome.monetary"),
      factsLength: text(object(getPath(record, "facts.materialFacts")).value?.summary).length,
    },
    baseline: {
      score: run.baseline_score,
      judges: array(object(getPath(baseline, "identity.judges")).value).length,
      issues: array(object(getPath(baseline, "analysis.legalIssues")).value).length,
      obiter: array(object(getPath(baseline, "analysis.obiterDicta")).value).length,
      legislation: array(object(getPath(baseline, "authorities.legislation")).value).length,
      authorities: array(object(getPath(baseline, "authorities.authorities")).value).length,
      orders: array(object(getPath(baseline, "outcome.orders")).value).length,
      monetary: array(object(getPath(baseline, "outcome.monetaryAwards")).value).length + array(object(getPath(baseline, "outcome.costs")).value).length,
      factsLength: text(object(getPath(baseline, "facts.summary")).value).length,
    },
  };
}

async function processSource(task: Task): Promise<void> {
  const run = await runRow(task.run_id);
  await db.schema("nomologies").from("core_v3_runs").update({ status: "running", current_stage: "source", started_at: run.started_at || new Date().toISOString(), error_code: "", error_message: "", updated_at: new Date().toISOString() }).eq("id", task.run_id);
  const fetched = await fetchCyLawJudgment(run.source_url);
  const source = await prepareJudgmentSource({ text: fetched.text, html: fetched.html, sourceTitle: fetched.sourceTitle || run.label, sourceUrl: fetched.sourceUrl, sourceDatabase: fetched.sourceDatabase, charset: fetched.charset, mode: "full" });
  const path = await uploadJson(`core-v3/runs/${task.run_id}/source.json`, source);
  await db.schema("nomologies").from("core_v3_runs").update({ source_artifact_path: path, current_stage: "extract", updated_at: new Date().toISOString() }).eq("id", task.run_id);
  await enqueue(task.run_id, "extract", 110); await finish(task, { path, paragraphCount: source.paragraphs.length, characterCount: source.characterCount });
}
async function processExtract(task: Task): Promise<void> {
  const run = await runRow(task.run_id); const source = await downloadJson(run.source_artifact_path); const context = sourceContext(source);
  await db.schema("nomologies").from("core_v3_runs").update({ current_stage: "extract", updated_at: new Date().toISOString() }).eq("id", task.run_id);
  const [identityRun, legalRun, outcomeRun] = await Promise.all([
    callAgent("identity", IDENTITY_SCHEMA, IDENTITY_PROMPT, context),
    callAgent("legal", LEGAL_SCHEMA, LEGAL_PROMPT, context),
    callAgent("outcome", OUTCOME_SCHEMA, OUTCOME_PROMPT, context),
  ]);
  const raw = { ...object(identityRun.data), ...object(legalRun.data), ...object(outcomeRun.data) };
  const payload = { raw, audits: { identity: identityRun.audit, legal: legalRun.audit, outcome: outcomeRun.audit }, contextCharacters: context.length };
  const path = await uploadJson(`core-v3/runs/${task.run_id}/agents.json`, payload);
  await db.schema("nomologies").from("core_v3_runs").update({ agents_artifact_path: path, current_stage: "verify", updated_at: new Date().toISOString() }).eq("id", task.run_id);
  await enqueue(task.run_id, "verify", 120); await finish(task, { path, contextCharacters: context.length });
}
async function processVerify(task: Task): Promise<void> {
  const run = await runRow(task.run_id); const source = await downloadJson(run.source_artifact_path); const agents = await downloadJson(run.agents_artifact_path);
  let raw = object(agents.raw); let deterministic = deterministicCandidate(raw, source);
  const requiredFailures = deterministic.blockers.filter((item) => requiredPath(String(item.path || "")));
  let repairAudit: Row | null = null;
  if (requiredFailures.length) {
    const group = repairGroup(String(requiredFailures[0].path));
    const paths = requiredFailures.filter((item) => repairGroup(String(item.path)) === group).map((item) => rootPath(String(item.path)));
    const context = sourceContext(source);
    const config = group === "identity"
      ? { name: "identity", schema: IDENTITY_SCHEMA, prompt: IDENTITY_PROMPT }
      : group === "legal"
      ? { name: "legal", schema: LEGAL_SCHEMA, prompt: LEGAL_PROMPT }
      : { name: "outcome", schema: OUTCOME_SCHEMA, prompt: OUTCOME_PROMPT };
    const repaired = await callAgent(config.name, config.schema, config.prompt, context, { paths, previous: raw });
    raw = mergeRepair(raw, object(repaired.data), paths);
    repairAudit = { group, paths, ...object(repaired.audit) };
    deterministic = deterministicCandidate(raw, source);
  }

  const claimSet = buildClaims(deterministic.candidate, source);
  const verificationRun = await createStructuredResponse({
    stage: "core-v3-final-verifier", schemaName: "core_v3_verifier", schema: VERIFIER_SCHEMA, system: VERIFIER_PROMPT,
    user: JSON.stringify({ contract: "elite-core-v3-verifier", claims: claimSet.claims }), effort: "low", model: MODEL, timeoutMs: 120_000,
  });
  const blockers = [...deterministic.blockers];
  const verified = applyVerifier(deterministic.candidate, object(verificationRun.data), claimSet.meta, blockers);
  const required = ["identity.caseName", "identity.caseNumber", "identity.court", "identity.decisionDate", "identity.caseFamily", "identity.judicialComposition", "facts.materialFacts", "analysis.legalIssues", "outcome.overallOutcome", "outcome.dispositionText"];
  for (const path of required) if (!fieldAvailable(verified, path)) blockers.push({ code: "CORE_REQUIRED_FIELD_MISSING", path, message: `${path} did not pass the core publication contract.`, required: true });
  const criticalBlockers = blockers.filter((item) => item.required === true || requiredPath(String(item.path || "")));
  const coreStatus = criticalBlockers.length ? "review" : "pass";
  const record = {
    schemaVersion: "elite-core-v3.0",
    model: MODEL,
    source: { sourceUrl: source.sourceUrl, sourceTitle: source.sourceTitle, sourceHash: source.sourceHash, paragraphCount: source.paragraphs.length },
    header: { primaryLegislation: primaryLegislation(verified), precedentialWeight: weightFor(verified) },
    ...verified,
    coreStatus,
    blockers,
    createdAt: new Date().toISOString(),
  };
  const verification = { checks: verificationRun.data.checks, overallComment: verificationRun.data.overallComment, audit: { model: verificationRun.model, responseId: verificationRun.responseId, elapsedMs: verificationRun.elapsedMs, usage: verificationRun.usage }, repairAudit };
  const [verificationPath, recordPath] = await Promise.all([
    uploadJson(`core-v3/runs/${task.run_id}/verification.json`, verification),
    uploadJson(`core-v3/runs/${task.run_id}/record.json`, record),
  ]);
  const metrics = await baselineMetrics(run, record);
  await db.schema("nomologies").from("core_v3_runs").update({
    status: "completed", current_stage: "completed", core_status: coreStatus,
    verification_artifact_path: verificationPath, record_artifact_path: recordPath,
    candidate_record: record, verification_record: verification, blockers, metrics,
    completed_at: new Date().toISOString(), error_code: "", error_message: "", updated_at: new Date().toISOString(),
  }).eq("id", task.run_id);
  await finish(task, { coreStatus, blockers: blockers.length, recordPath, verificationPath });
}
async function processTask(task: Task): Promise<void> {
  if (task.stage === "source") return processSource(task);
  if (task.stage === "extract") return processExtract(task);
  if (task.stage === "verify") return processVerify(task);
  throw new Error(`UNSUPPORTED_STAGE:${task.stage}`);
}

Deno.serve(async (req: Request) => {
  if (!(await authorized(req))) return json({ ok: false, code: "UNAUTHORIZED" }, 401);
  try {
    const task = await claim();
    if (!task) return json({ ok: true, status: "idle", worker: workerName });
    const work = (async () => {
      try { await processTask(task); }
      catch (error) { console.error(error); await fail(task, error); }
      finally { await invokeNext(); }
    })();
    waitUntil(work);
    return json({ ok: true, status: "accepted", taskId: task.id, runId: task.run_id, stage: task.stage, model: MODEL }, 202);
  } catch (error) {
    console.error(error);
    return json({ ok: false, code: "WORKER_ERROR", message: error instanceof Error ? error.message : String(error) }, 500);
  }
});
