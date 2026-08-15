import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { createStructuredResponse } from "https://raw.githubusercontent.com/marinos151111-del/mynomosgpt/186ff106df99541e2604eab64ba43921d5c88cf2/src/nomologies-v2/openai-responses.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const MODEL = "gpt-5.4-mini";
const BUCKET = "nomologies-artifacts";
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

type Row = Record<string, any>;
type Evidence = { paragraphIds: string[]; quote: string };
const STATUS = ["available", "not_found", "review"] as const;

const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const array = (value: unknown): any[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const now = () => new Date().toISOString();
const meaningful = (value: unknown): boolean => typeof value === "string" ? !!value.trim() : Array.isArray(value) ? value.length > 0 : !!value && typeof value === "object" && Object.keys(value as Row).length > 0;
const normalize = (value: string): string => String(value || "").normalize("NFC").replace(/[\u00ad\u200b]/g, "").replace(/[\u00a0\u2007\u202f]/g, " ").replace(/[’‘`´]/g, "'").replace(/[“”]/g, '"').replace(/[‐‑‒–—―]/g, "-").replace(/\s+/gu, " ").trim();
const fold = (value: string): string => normalize(value).toLocaleLowerCase("el").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ς/g, "σ");
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }
function authorized(req: Request): boolean { return SERVICE_KEY !== "" && (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") === SERVICE_KEY; }

const S = { string: { type: "string" }, number: { type: "number", minimum: 0, maximum: 1 } };
const enumeration = (values: readonly string[]): Row => ({ type: "string", enum: [...values] });
const listOf = (items: Row): Row => ({ type: "array", items });
const obj = (properties: Row): Row => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const EVIDENCE_SCHEMA = obj({ paragraphIds: listOf(S.string), quote: S.string });
const scalar = (value: Row): Row => obj({ status: enumeration(STATUS), value, confidence: S.number, evidence: listOf(EVIDENCE_SCHEMA) });
const list = (item: Row): Row => obj({ status: enumeration(STATUS), value: listOf(item), confidence: S.number });
const ISSUE_SCHEMA = obj({ issue: S.string, principle: S.string, holding: S.string, evidence: listOf(EVIDENCE_SCHEMA) });
const OBITER_SCHEMA = obj({ text: S.string, evidence: listOf(EVIDENCE_SCHEMA) });
const REPAIR_SCHEMA = obj({
  facts: obj({ materialFacts: scalar(obj({ summary: S.string, points: listOf(S.string) })) }),
  analysis: obj({ legalIssues: list(ISSUE_SCHEMA), obiterDicta: list(OBITER_SCHEMA) }),
});
const VERIFY_SCHEMA = obj({
  checks: listOf(obj({ id: S.string, verdict: enumeration(["accept", "reject", "review"]), reason: S.string })),
  overallComment: S.string,
});

const REPAIR_PROMPT = `You are a senior Cyprus case-law analyst repairing only the lawyer-facing factual and analytical core.
Use only the supplied official CyLaw paragraphs.
Return:
1. materialFacts: a factual narrative of 3-6 sentences plus 3-8 material fact points. Exclude the present court's final result, legal rules, party argument labels and unnecessary chronology.
2. legalIssues: normally 1-3 simple Greek questions. Each item must contain one concise case-neutral legal principle and one concise case-specific holding of the present court.
3. obiterDicta: up to five genuine non-essential observations made by the present court. If none is clearly identifiable, return not_found with an empty list.
EVIDENCE RULES:
- Every available field or item must cite exact paragraph IDs and exact continuous verbatim quotations.
- Use one evidence object per continuous passage. Never put non-contiguous paragraph IDs in one evidence object. Never splice or paraphrase a quotation.
- A party submission is not a holding. A quotation from another judgment is not the present court's principle, holding or obiter.
- Prefer review/not_found over invention. Return only the strict JSON schema.`;

const VERIFY_PROMPT = `You are the final legal attribution verifier. Return exactly one check for every supplied id.
Accept only if the cited context proves the claim and the proposition belongs to the present court where required.
Reject or review a fact summary containing the present judgment's final outcome, a party submission presented as a holding, a quoted authority presented as the present court's principle, or an observation incorrectly labelled obiter.
Do not rewrite claims and do not invent ids.`;

async function download(path: string): Promise<any> {
  const { data, error } = await db.storage.from(BUCKET).download(path);
  if (error || !data) throw new Error(`ARTIFACT_DOWNLOAD_FAILED:${error?.message || path}`);
  return JSON.parse(await data.text());
}
async function upload(path: string, payload: unknown): Promise<string> {
  const { error } = await db.storage.from(BUCKET).upload(path, new TextEncoder().encode(JSON.stringify(payload)), { contentType: "application/json", upsert: true });
  if (error) throw new Error(`ARTIFACT_UPLOAD_FAILED:${error.message}`);
  return path;
}
function maps(source: Row): { byId: Map<string, Row>; ordinal: Map<string, number> } {
  const byId = new Map<string, Row>(); const ordinal = new Map<string, number>();
  for (const paragraph of array(source.paragraphs)) { byId.set(String(paragraph.id), paragraph); ordinal.set(String(paragraph.id), Number(paragraph.ordinal || 0)); }
  return { byId, ordinal };
}
function recoverQuote(quote: string, source: Row, preferred: string[]): Evidence | null {
  const needle = normalize(quote); if (!needle) return null;
  const paragraphs = array(source.paragraphs); const matches: Evidence[] = [];
  for (let start = 0; start < paragraphs.length; start += 1) {
    for (let width = 1; width <= 6 && start + width <= paragraphs.length; width += 1) {
      const rows = paragraphs.slice(start, start + width);
      if (normalize(rows.map((paragraph: Row) => String(paragraph.text || "")).join(" ")).includes(needle)) {
        matches.push({ paragraphIds: rows.map((paragraph: Row) => String(paragraph.id)), quote });
      }
    }
  }
  if (!matches.length) return null;
  matches.sort((left, right) => right.paragraphIds.filter((id) => preferred.includes(id)).length - left.paragraphIds.filter((id) => preferred.includes(id)).length || left.paragraphIds.length - right.paragraphIds.length);
  const best = matches[0];
  const overlap = best.paragraphIds.filter((id) => preferred.includes(id)).length;
  const tied = matches.filter((item) => item.paragraphIds.filter((id) => preferred.includes(id)).length === overlap && item.paragraphIds.length === best.paragraphIds.length);
  return tied.length === 1 || overlap > 0 ? best : null;
}
function validateEvidence(raw: unknown, source: Row): Evidence[] {
  const { byId, ordinal } = maps(source); const valid: Evidence[] = [];
  for (const item of array(raw)) {
    const row = object(item); const ids = array(row.paragraphIds).map(String).filter(Boolean); const quote = text(row.quote);
    if (!ids.length || !quote) continue;
    const rows = ids.map((id) => byId.get(id)); const ordinals = ids.map((id) => ordinal.get(id) || 0).sort((left, right) => left - right);
    const contiguous = rows.every(Boolean) && !ordinals.some((value, index) => index > 0 && value !== ordinals[index - 1] + 1);
    if (contiguous && normalize(rows.map((paragraph) => String(paragraph?.text || "")).join(" ")).includes(normalize(quote))) {
      valid.push({ paragraphIds: ids, quote }); continue;
    }
    const recovered = recoverQuote(quote, source, ids); if (recovered) valid.push(recovered);
  }
  return [...new Map(valid.map((anchor) => [`${anchor.paragraphIds.join(",")}|${normalize(anchor.quote)}`, anchor])).values()];
}
function validateScalar(field: Row, source: Row): Row {
  const status = STATUS.includes(field.status) ? field.status : "review";
  if (status !== "available") return { status, value: field.value ?? "", confidence: Number(field.confidence || 0), evidence: [] };
  const evidence = validateEvidence(field.evidence, source);
  return meaningful(field.value) && evidence.length ? { status: "available", value: field.value, confidence: Number(field.confidence || 0), evidence } : { status: "review", value: field.value ?? "", confidence: 0, evidence };
}
function validateItems(field: Row, source: Row): Row {
  const status = STATUS.includes(field.status) ? field.status : "review";
  if (status !== "available") return { status, value: [], confidence: Number(field.confidence || 0) };
  const values = array(field.value).flatMap((raw) => {
    const item = object(raw); const evidence = validateEvidence(item.evidence, source);
    return evidence.length ? [{ ...item, evidence }] : [];
  });
  return { status: values.length ? "available" : "review", value: values, confidence: values.length ? Number(field.confidence || 0) : 0 };
}
function context(source: Row): string { return array(source.paragraphs).map((paragraph: Row) => `[${paragraph.id}] ${paragraph.text}`).join("\n\n").slice(0, 220_000); }
function claimText(path: string, value: any): string {
  if (path === "facts.materialFacts") return `Πραγματικά: ${value.summary}\nΣημεία: ${array(value.points).join(" | ")}`;
  if (path === "analysis.legalIssues") return `Ζήτημα: ${value.issue}\nΑρχή: ${value.principle}\nΚρίση: ${value.holding}`;
  return `Obiter: ${value.text}`;
}
function buildClaims(facts: Row, issues: Row, obiter: Row, source: Row): { claims: Row[]; meta: Map<string, { path: string; index?: number }> } {
  const { ordinal } = maps(source); const paragraphs = array(source.paragraphs); const claims: Row[] = []; const meta = new Map<string, { path: string; index?: number }>();
  const add = (id: string, path: string, value: any, evidence: Evidence[], index?: number) => {
    const contexts = evidence.map((anchor) => {
      const indexes = anchor.paragraphIds.map((paragraphId) => (ordinal.get(paragraphId) || 1) - 1);
      const start = Math.max(0, Math.min(...indexes) - 1); const end = Math.min(paragraphs.length, Math.max(...indexes) + 2);
      return { cited: anchor, context: paragraphs.slice(start, end).map((paragraph: Row) => `[${paragraph.id}] ${paragraph.text}`).join("\n") };
    });
    claims.push({ id, path, claim: claimText(path, value), evidenceContexts: contexts }); meta.set(id, { path, index });
  };
  if (facts.status === "available") add("facts.materialFacts", "facts.materialFacts", facts.value, array(facts.evidence));
  if (issues.status === "available") array(issues.value).forEach((item, index) => add(`analysis.legalIssues[${index}]`, "analysis.legalIssues", item, array(item.evidence), index));
  if (obiter.status === "available") array(obiter.value).forEach((item, index) => add(`analysis.obiterDicta[${index}]`, "analysis.obiterDicta", item, array(item.evidence), index));
  return { claims, meta };
}
function applyChecks(facts: Row, issues: Row, obiter: Row, checks: Row[], meta: Map<string, { path: string; index?: number }>): { facts: Row; issues: Row; obiter: Row; blockers: Row[] } {
  const byId = new Map(checks.map((check) => [String(check.id), check])); const blockers: Row[] = [];
  let nextFacts = structuredClone(facts), nextIssues = structuredClone(issues), nextObiter = structuredClone(obiter);
  const rejectedIssues = new Set<number>(); const rejectedObiter = new Set<number>();
  for (const [id, item] of meta) {
    const check = object(byId.get(id)); const verdict = String(check.verdict || "review");
    if (verdict === "accept") continue;
    blockers.push({ code: verdict === "reject" ? "REFINER_VERIFIER_REJECTED" : "REFINER_VERIFIER_REVIEW", path: id, message: String(check.reason || "Verifier did not accept repaired field.") });
    if (item.path === "facts.materialFacts") nextFacts = { ...nextFacts, status: "review", confidence: 0 };
    else if (item.path === "analysis.legalIssues" && item.index !== undefined) rejectedIssues.add(item.index);
    else if (item.path === "analysis.obiterDicta" && item.index !== undefined) rejectedObiter.add(item.index);
  }
  if (nextIssues.status === "available") {
    const values = array(nextIssues.value).filter((_item, index) => !rejectedIssues.has(index));
    nextIssues = { ...nextIssues, status: values.length ? "available" : "review", value: values, confidence: values.length ? nextIssues.confidence : 0 };
  }
  if (nextObiter.status === "available") {
    const values = array(nextObiter.value).filter((_item, index) => !rejectedObiter.has(index));
    nextObiter = { ...nextObiter, status: values.length ? "available" : "not_found", value: values, confidence: values.length ? nextObiter.confidence : 1 };
  }
  return { facts: nextFacts, issues: nextIssues, obiter: nextObiter, blockers };
}
function deterministicPanel(rawAgents: Row, source: Row): Row {
  const rawIdentity = object(object(rawAgents.raw).identity); const proposed = array(object(rawIdentity.judicialComposition).value);
  const paragraphs = array(source.paragraphs); const panelParagraph = paragraphs.find((paragraph: Row) => /Δ\/στές|Δικαστές|Judges/iu.test(String(paragraph.text || "")));
  if (!panelParagraph) return { status: "review", value: [], confidence: 0 };
  const panelFolded = fold(String(panelParagraph.text || ""));
  const deliveryIndex = paragraphs.findIndex((paragraph: Row) => /θα\s+απαγγελθεί\s+από|delivered\s+by|judgment\s+of/iu.test(String(paragraph.text || "")));
  const deliveryRows = deliveryIndex >= 0 ? paragraphs.slice(deliveryIndex, Math.min(paragraphs.length, deliveryIndex + 3)) : [];
  const deliveryFolded = fold(deliveryRows.map((paragraph: Row) => String(paragraph.text || "")).join(" "));
  const values: Row[] = [];
  for (const item of proposed) {
    const name = text(item.name); if (!name) continue;
    const surname = fold(name).split(/\s+/).at(-1)?.replace(/[^a-zα-ω-]/gu, "") || "";
    if (!surname || !panelFolded.includes(surname)) continue;
    let role = "panel";
    if (deliveryFolded.includes(surname)) role = "authoring";
    else {
      const escaped = surname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`${escaped}[^a-zα-ω]{0,12}π\\.?`, "u").test(panelFolded)) role = "presiding";
    }
    const evidence: Evidence[] = [{ paragraphIds: [String(panelParagraph.id)], quote: String(panelParagraph.text) }];
    if (role === "authoring" && deliveryRows.length) evidence.push({ paragraphIds: deliveryRows.map((paragraph: Row) => String(paragraph.id)), quote: deliveryRows.map((paragraph: Row) => String(paragraph.text || "")).join(" ") });
    values.push({ name, role, evidence });
  }
  return { status: values.length ? "available" : "review", value: [...new Map(values.map((item) => [fold(item.name), item])).values()], confidence: values.length ? 0.99 : 0 };
}
function deterministicCosts(record: Row): Row {
  const orders = array(object(object(record.outcome).orders).value); const values: Row[] = [];
  for (const order of orders) {
    const orderText = text(order.text); if (!/έξοδα|costs/iu.test(orderText)) continue;
    const folded = fold(orderText); const amountMatch = orderText.match(/€\s*([\d.,]+)/u);
    let payer = "", payee = "";
    const burden = orderText.match(/(?:θα\s+επιβαρυνθεί|επιβαρύνουν)\s+(?:η\s+πλευρά\s+)?(?:των|του|της)?\s*([^,.]+)/iu);
    if (burden) payer = burden[1].trim();
    const forAgainst = orderText.match(/υπέρ\s+(.+?)\s+και\s+εναντίον\s+(.+?)(?:,|\.|$)/iu);
    if (forAgainst) { payee = forAgainst[1].trim(); payer = forAgainst[2].trim(); }
    const stage = /πρωτόδικ/iu.test(orderText) ? "first_instance" : /έφεσ/iu.test(orderText) ? "appeal" : "other";
    const assessed = /υπολογισ|Πρωτοκολλητ/iu.test(orderText);
    values.push({
      type: "costs", stage, amount: amountMatch ? amountMatch[1].replace(/\./g, "").replace(",", ".") : "", currency: amountMatch ? "EUR" : "",
      fixed: Boolean(amountMatch), status: amountMatch ? "fixed" : assessed ? "to_be_assessed" : "not_stated",
      payer, payee, interest: "", evidence: array(order.evidence),
    });
  }
  return { status: values.length ? "available" : "not_found", value: values, confidence: values.length ? 0.99 : 1 };
}
function precedentialWeight(record: Row): "Υψηλή" | "Μέση" | "Χαμηλή" {
  const court = fold(text(object(object(record.identity).court).value));
  const issues = array(object(object(record.analysis).legalIssues).value);
  const outcome = text(object(object(record.outcome).overallOutcome).value);
  const senior = /ανωτατο|εφετειο|supreme|court of appeal/u.test(court);
  const procedural = /application_/.test(outcome);
  if (senior && issues.length && !procedural) return "Υψηλή";
  if (senior || issues.length) return "Μέση";
  return "Χαμηλή";
}
function retainBlockers(blockers: Row[]): Row[] {
  const repaired = ["facts.materialFacts", "analysis.legalIssues", "analysis.obiterDicta", "identity.judicialComposition", "outcome.monetary"];
  return blockers.filter((blocker) => !repaired.some((path) => String(blocker.path || "").startsWith(path)) && !["CORE_REQUIRED_FIELD_MISSING"].includes(String(blocker.code || "")));
}

async function refine(runId: string): Promise<Row> {
  const { data: run, error } = await db.schema("nomologies").from("core_v3_runs").select("*").eq("id", runId).single();
  if (error) throw new Error(`RUN_READ_FAILED:${error.message}`);
  const source = await download(run.source_artifact_path); const agents = await download(run.agents_artifact_path); const current = structuredClone(object(run.candidate_record));
  const repaired = await createStructuredResponse({ stage: "core-v3-targeted-repair", schemaName: "core_v3_targeted_repair", schema: REPAIR_SCHEMA, system: REPAIR_PROMPT, user: JSON.stringify({ contract: "elite-core-v3-targeted-repair", sourceParagraphs: context(source), priorCandidate: { facts: current.facts, analysis: current.analysis }, failedPaths: array(run.blockers).map((item) => item.path).filter(Boolean) }), effort: "low", model: MODEL, timeoutMs: 150_000 });
  const repairData = object(repaired.data);
  const facts = validateScalar(object(object(repairData.facts).materialFacts), source);
  const issues = validateItems(object(object(repairData.analysis).legalIssues), source);
  const obiter = validateItems(object(object(repairData.analysis).obiterDicta), source);
  const claimSet = buildClaims(facts, issues, obiter, source);
  const verification = await createStructuredResponse({ stage: "core-v3-targeted-repair-verifier", schemaName: "core_v3_targeted_repair_verifier", schema: VERIFY_SCHEMA, system: VERIFY_PROMPT, user: JSON.stringify({ contract: "elite-core-v3-targeted-repair-verifier", claims: claimSet.claims }), effort: "low", model: MODEL, timeoutMs: 120_000 });
  const checked = applyChecks(facts, issues, obiter, array(object(verification.data).checks), claimSet.meta);
  current.facts = { ...object(current.facts), materialFacts: checked.facts };
  current.analysis = { ...object(current.analysis), legalIssues: checked.issues, obiterDicta: checked.obiter };
  current.identity = { ...object(current.identity), judicialComposition: deterministicPanel(agents, source) };
  current.outcome = { ...object(current.outcome), monetary: deterministicCosts(current) };
  current.header = { ...object(current.header), precedentialWeight: precedentialWeight(current) };

  const blockers = [...retainBlockers(array(run.blockers)), ...checked.blockers];
  const required = ["identity.caseName", "identity.caseNumber", "identity.court", "identity.decisionDate", "identity.caseFamily", "identity.judicialComposition", "facts.materialFacts", "analysis.legalIssues", "outcome.overallOutcome", "outcome.dispositionText"];
  const get = (path: string): any => path.split(".").reduce((value: any, key) => object(value)[key], current);
  for (const path of required) { const field = object(get(path)); if (field.status !== "available" || !meaningful(field.value)) blockers.push({ code: "CORE_REQUIRED_FIELD_MISSING", path, required: true }); }
  if (/άρθρ|κανονισμ|νόμ|κεφ\.|\brule\b|\barticle\b/iu.test(String(source.cleanText || ""))) {
    const field = object(object(current.authorities).legislation); if (field.status !== "available" || !array(field.value).length) blockers.push({ code: "CORE_LEGISLATION_COVERAGE_FAILED", path: "authorities.legislation", required: true });
  }
  const coreStatus = blockers.some((item) => item.required === true) ? "review" : "pass";
  current.schemaVersion = "elite-core-v3.2"; current.coreStatus = coreStatus; current.blockers = blockers; current.refinedAt = now(); current.model = MODEL;
  const refinement = { model: MODEL, repair: { responseId: repaired.responseId, elapsedMs: repaired.elapsedMs, usage: repaired.usage }, verifier: { responseId: verification.responseId, elapsedMs: verification.elapsedMs, usage: verification.usage, overallComment: object(verification.data).overallComment } };
  const path = await upload(`core-v3/runs/${runId}/record-refined.json`, current);
  const metrics = { ...object(run.metrics), refinement, refined: { judges: array(object(object(current.identity).judicialComposition).value).length, issues: array(object(object(current.analysis).legalIssues).value).length, obiter: array(object(object(current.analysis).obiterDicta).value).length, legislation: array(object(object(current.authorities).legislation).value).length, authorities: array(object(object(current.authorities).authorities).value).length, orders: array(object(object(current.outcome).orders).value).length, monetary: array(object(object(current.outcome).monetary).value).length, factsLength: text(object(object(current.facts).materialFacts).value?.summary).length } };
  const { error: updateError } = await db.schema("nomologies").from("core_v3_runs").update({ candidate_record: current, core_status: coreStatus, blockers, metrics, record_artifact_path: path, updated_at: now() }).eq("id", runId);
  if (updateError) throw new Error(`RUN_UPDATE_FAILED:${updateError.message}`);
  return { runId, coreStatus, blockers: blockers.length, recordPath: path, metrics };
}

Deno.serve(async (req: Request) => {
  if (!authorized(req)) return json({ ok: false, code: "UNAUTHORIZED" }, 401);
  try {
    const payload = object(await req.json().catch(() => ({}))); const runId = text(payload.runId);
    if (!/^[0-9a-f-]{36}$/i.test(runId)) return json({ ok: false, code: "RUN_ID_REQUIRED" }, 400);
    return json({ ok: true, ...await refine(runId) });
  } catch (error) {
    console.error(error); return json({ ok: false, code: "REFINER_ERROR", message: error instanceof Error ? error.message : String(error) }, 500);
  }
});
