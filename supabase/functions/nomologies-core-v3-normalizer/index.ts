import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const BUCKET = "nomologies-artifacts";
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

type Row = Record<string, any>;
type Evidence = { paragraphIds: string[]; quote: string };
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const array = (value: unknown): any[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const now = () => new Date().toISOString();
const meaningful = (value: unknown): boolean => typeof value === "string" ? !!value.trim() : Array.isArray(value) ? value.length > 0 : !!value && typeof value === "object" && Object.keys(value as Row).length > 0;
const normalize = (value: string): string => String(value || "").normalize("NFC").replace(/[\u00ad\u200b]/g, "").replace(/[\u00a0\u2007\u202f]/g, " ").replace(/[’‘`´]/g, "'").replace(/[“”]/g, '"').replace(/[‐‑‒–—―]/g, "-").replace(/\s+/gu, " ").trim();
const fold = (value: string): string => normalize(value).toLocaleLowerCase("el").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ς/g, "σ");
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }
function authorized(req: Request): boolean { return SERVICE_KEY !== "" && (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") === SERVICE_KEY; }
async function download(path: string): Promise<any> { const { data, error } = await db.storage.from(BUCKET).download(path); if (error || !data) throw new Error(`ARTIFACT_DOWNLOAD_FAILED:${error?.message || path}`); return JSON.parse(await data.text()); }
async function upload(path: string, payload: unknown): Promise<string> { const { error } = await db.storage.from(BUCKET).upload(path, new TextEncoder().encode(JSON.stringify(payload)), { contentType: "application/json", upsert: true }); if (error) throw new Error(`ARTIFACT_UPLOAD_FAILED:${error.message}`); return path; }

function cleanFacts(field: Row): Row {
  if (field.status !== "available") return field;
  const value = object(field.value); const summary = text(value.summary);
  const sentences = summary.split(/(?<=[.!;··])\s+/u).map((sentence) => sentence.trim()).filter(Boolean);
  const outcomeSentence = (sentence: string): boolean => {
    const folded = fold(sentence);
    return /^(?:το\s+δικαστηριο|κατεληξε|εκριν(?:ε|αν)|η\s+(?:εφεση|αιτηση))\b/u.test(folded) &&
      /(εξετασ|κατεληξ|απορριφ|επιτυχ|εκριν|αποτυγχ)/u.test(folded) &&
      !/πρωτοδικ/u.test(folded);
  };
  const cleaned = sentences.filter((sentence) => !outcomeSentence(sentence)).join(" ").trim();
  return { ...field, value: { ...value, summary: cleaned || summary } };
}
function panel(rawAgents: Row, source: Row): Row {
  const proposed = array(object(object(object(rawAgents.raw).identity).judicialComposition).value);
  const paragraphs = array(source.paragraphs);
  const panelParagraph = paragraphs.find((paragraph: Row) => /Δ\/στές|Δικαστές|Judges/iu.test(String(paragraph.text || "")));
  if (!panelParagraph) return { status: "review", value: [], confidence: 0 };
  const panelFolded = fold(String(panelParagraph.text || ""));
  const deliveryIndex = paragraphs.findIndex((paragraph: Row) => /θα\s+απαγγελθεί\s+από|delivered\s+by|judgment\s+of/iu.test(String(paragraph.text || "")));
  const deliveryRows = deliveryIndex >= 0 ? paragraphs.slice(deliveryIndex, Math.min(paragraphs.length, deliveryIndex + 3)) : [];
  const deliveryText = deliveryRows.map((paragraph: Row) => String(paragraph.text || "")).join(" ");
  const deliveryFolded = fold(deliveryText);
  const marker = deliveryFolded.search(/θα\s+απαγγελθει\s+απο|delivered\s+by|judgment\s+of/u);
  const deliveryTail = marker >= 0 ? deliveryFolded.slice(marker) : "";
  const values: Row[] = [];
  for (const item of proposed) {
    const name = text(item.name); if (!name) continue;
    const surname = fold(name).split(/\s+/).at(-1)?.replace(/[^a-zα-ω-]/gu, "") || "";
    if (!surname || !panelFolded.includes(surname)) continue;
    let role = "panel";
    const escaped = surname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (deliveryTail.includes(surname)) role = "authoring";
    else if (new RegExp(`${escaped}[^a-zα-ω]{0,12}π\\.?`, "u").test(panelFolded)) role = "presiding";
    const evidence: Evidence[] = [{ paragraphIds: [String(panelParagraph.id)], quote: String(panelParagraph.text) }];
    if (role === "authoring" && deliveryRows.length) evidence.push({ paragraphIds: deliveryRows.map((paragraph: Row) => String(paragraph.id)), quote: deliveryText });
    values.push({ name, role, evidence });
  }
  return { status: values.length ? "available" : "review", value: [...new Map(values.map((item) => [fold(item.name), item])).values()], confidence: values.length ? 0.99 : 0 };
}
function costs(record: Row): Row {
  const orders = array(object(object(record.outcome).orders).value); const values: Row[] = [];
  for (const order of orders) {
    const orderText = text(order.text); if (!/έξοδα|costs/iu.test(orderText)) continue;
    const amountMatch = orderText.match(/€\s*([\d.,]+)/u);
    let payer = "", payee = "";
    const side = orderText.match(/πλευρά\s+των\s+([^,.]+)/iu);
    if (side) payer = side[1].trim();
    const forAgainst = orderText.match(/υπέρ\s+(.+?)\s+και\s+εναντίον\s+(.+?)(?:,|\.|$)/iu);
    if (forAgainst) { payee = forAgainst[1].trim(); payer = forAgainst[2].trim(); }
    const stage = /πρωτόδικ/iu.test(orderText) ? "first_instance" : /έφεσ/iu.test(orderText) ? "appeal" : "other";
    const assessed = /υπολογισ|Πρωτοκολλητ/iu.test(orderText);
    values.push({ type: "costs", stage, amount: amountMatch ? amountMatch[1].replace(/\./g, "").replace(",", ".") : "", currency: amountMatch ? "EUR" : "", fixed: Boolean(amountMatch), status: amountMatch ? "fixed" : assessed ? "to_be_assessed" : "not_stated", payer, payee, interest: "", evidence: array(order.evidence) });
  }
  const current = array(object(object(record.outcome).monetary).value).filter((item) => item.type !== "costs");
  const merged = [...current, ...values];
  return { status: merged.length ? "available" : "not_found", value: merged, confidence: merged.length ? 0.99 : 1 };
}

const INSTRUMENT_STOP = new Set(["του","της","των","περι","νομος","νομου","κανονισμος","κανονισμων","κανονισμοι","law","rules","rule","part","civil","procedure","the","of","and","του2023","1960","1964"]);
function tokens(value: string): string[] { return fold(value).replace(/[^a-zα-ω0-9]+/gu, " ").split(/\s+/u).filter(Boolean); }
function distinctiveInstrumentHints(item: Row): string[] {
  const name = `${text(item.name)} ${text(item.lawId)}`;
  const raw = tokens(name);
  const numeric = raw.filter((token) => /^\d{2,4}$/u.test(token));
  const words = raw.filter((token) => token.length >= 5 && !INSTRUMENT_STOP.has(token)).sort((left, right) => right.length - left.length).slice(0, 3);
  if (/συνταγμα/iu.test(fold(name))) words.unshift("συνταγμα");
  return [...new Set([...numeric, ...words])];
}
function provisionHints(provision: Row): string[] {
  const value = `${text(provision.display)} ${text(provision.article)}`;
  const raw = tokens(value);
  const numbers = [...new Set(raw.filter((token) => /^\d+$/u.test(token)))].slice(0, 3);
  const markers = raw.filter((token) => ["αρθρο","article","κανονισμος","rule","μερος","part"].includes(token));
  return [...new Set([...markers.slice(0, 1), ...numbers])];
}
function ownershipWindow(source: Row, instrument: Row, provision: Row): Evidence | null {
  const paragraphs = array(source.paragraphs); const instrumentHints = distinctiveInstrumentHints(instrument); const provisionTokens = provisionHints(provision);
  if (!provisionTokens.length) return null;
  const candidates: Array<{ evidence: Evidence; score: number; width: number }> = [];
  for (let start = 0; start < paragraphs.length; start += 1) {
    for (let width = 1; width <= 4 && start + width <= paragraphs.length; width += 1) {
      const rows = paragraphs.slice(start, start + width); const folded = fold(rows.map((paragraph: Row) => String(paragraph.text || "")).join(" "));
      const provisionMatch = provisionTokens.every((token) => folded.includes(token));
      const instrumentScore = instrumentHints.filter((token) => folded.includes(token)).length;
      const instrumentMatch = instrumentHints.length ? instrumentScore >= Math.min(2, instrumentHints.length) : true;
      if (!provisionMatch || !instrumentMatch) continue;
      candidates.push({ evidence: { paragraphIds: rows.map((paragraph: Row) => String(paragraph.id)), quote: rows.map((paragraph: Row) => String(paragraph.text || "")).join(" ") }, score: instrumentScore, width });
    }
  }
  candidates.sort((left, right) => right.score - left.score || left.width - right.width || left.evidence.paragraphIds[0].localeCompare(right.evidence.paragraphIds[0]));
  return candidates[0]?.evidence || null;
}
function legislation(rawAgents: Row, source: Row): Row {
  const rawField = object(object(object(rawAgents.raw).authorities).legislation);
  if (rawField.status !== "available") return { status: "not_found", value: [], confidence: 1 };
  const values: Row[] = [];
  for (const raw of array(rawField.value)) {
    const item = object(raw); const provisions: Row[] = [];
    for (const rawProvision of array(item.provisions)) {
      const provision = object(rawProvision); const evidence = ownershipWindow(source, item, provision);
      if (evidence) provisions.push({ ...provision, evidence: [evidence] });
    }
    if (!provisions.length) continue;
    const evidence = [...new Map(provisions.flatMap((provision) => array(provision.evidence)).map((anchor: Evidence) => [`${anchor.paragraphIds.join(",")}|${normalize(anchor.quote)}`, anchor])).values()];
    values.push({ ...item, provisions, evidence });
  }
  const deduped = new Map<string, Row>();
  for (const item of values) {
    const key = fold(`${text(item.lawId)} ${text(item.name)}`);
    const prior = deduped.get(key);
    if (!prior) { deduped.set(key, item); continue; }
    const provisionMap = new Map([...array(prior.provisions), ...array(item.provisions)].map((provision) => [fold(`${provision.display} ${provision.article}`), provision]));
    deduped.set(key, { ...prior, provisions: [...provisionMap.values()], evidence: [...array(prior.evidence), ...array(item.evidence)] });
  }
  const output = [...deduped.values()];
  return { status: output.length ? "available" : "review", value: output, confidence: output.length ? 0.99 : 0 };
}
function authorities(field: Row): Row {
  if (field.status !== "available") return field;
  const deduped = new Map<string, Row>();
  for (const item of array(field.value)) {
    const key = fold(text(item.name)).replace(/\b(?:αρ|αρριθμος)\b.*$/u, "").replace(/[^a-zα-ω0-9]+/gu, " ").trim();
    const prior = deduped.get(key);
    if (!prior) { deduped.set(key, item); continue; }
    deduped.set(key, {
      ...prior,
      citation: [...new Set([text(prior.citation), text(item.citation)].filter(Boolean))].join("; "),
      legalPoint: [...new Set([text(prior.legalPoint), text(item.legalPoint)].filter(Boolean))].join(" "),
      evidence: [...new Map([...array(prior.evidence), ...array(item.evidence)].map((anchor: Evidence) => [`${anchor.paragraphIds.join(",")}|${normalize(anchor.quote)}`, anchor])).values()],
    });
  }
  return { ...field, value: [...deduped.values()] };
}
function weight(record: Row): "Υψηλή" | "Μέση" | "Χαμηλή" {
  const court = fold(text(object(object(record.identity).court).value)); const issues = array(object(object(record.analysis).legalIssues).value); const outcome = text(object(object(record.outcome).overallOutcome).value);
  const senior = /ανωτατο|εφετειο|supreme|court of appeal/u.test(court); const procedural = /application_/.test(outcome);
  if (senior && issues.length && !procedural) return "Υψηλή";
  if (senior || issues.length) return "Μέση";
  return "Χαμηλή";
}
function stripFixedBlockers(blockers: Row[]): Row[] {
  const paths = ["facts.materialFacts","identity.judicialComposition","outcome.monetary","authorities.legislation"];
  return blockers.filter((blocker) => !paths.some((path) => String(blocker.path || "").startsWith(path)) && !["PROVISION_NOT_GROUNDED","INSTRUMENT_NOT_GROUNDED","INSTRUMENT_PROVISIONS_REJECTED","CORE_REQUIRED_FIELD_MISSING","CORE_LEGISLATION_COVERAGE_FAILED"].includes(String(blocker.code || "")));
}
function fieldAvailable(record: Row, path: string): boolean { const field = path.split(".").reduce((value: any, key) => object(value)[key], record); return object(field).status === "available" && meaningful(object(field).value); }

async function normalizeRun(runId: string): Promise<Row> {
  const { data: run, error } = await db.schema("nomologies").from("core_v3_runs").select("*").eq("id", runId).single(); if (error) throw new Error(`RUN_READ_FAILED:${error.message}`);
  const source = await download(run.source_artifact_path); const agents = await download(run.agents_artifact_path); const record = structuredClone(object(run.candidate_record));
  record.facts = { ...object(record.facts), materialFacts: cleanFacts(object(object(record.facts).materialFacts) };
  record.identity = { ...object(record.identity), judicialComposition: panel(agents, source) };
  record.outcome = { ...object(record.outcome), monetary: costs(record) };
  record.authorities = { ...object(record.authorities), legislation: legislation(agents, source), authorities: authorities(object(object(record.authorities).authorities)) };
  record.header = { ...object(record.header), precedentialWeight: weight(record), primaryLegislation: array(object(object(record.authorities).legislation).value).filter((item) => item.role !== "background" && array(item.provisions).some((provision) => ["applied","interpreted","considered"].includes(provision.application))).slice(0,4).map((item) => `${item.name}${item.lawId ? ` (${item.lawId})` : ""} — ${array(item.provisions).map((provision) => provision.display).join(", ")}`) };
  const blockers = stripFixedBlockers(array(run.blockers));
  const required = ["identity.caseName","identity.caseNumber","identity.court","identity.decisionDate","identity.caseFamily","identity.judicialComposition","facts.materialFacts","analysis.legalIssues","outcome.overallOutcome","outcome.dispositionText"];
  for (const path of required) if (!fieldAvailable(record, path)) blockers.push({ code: "CORE_REQUIRED_FIELD_MISSING", path, required: true });
  if (/άρθρ|κανονισμ|νόμ|κεφ\.|\brule\b|\barticle\b/iu.test(String(source.cleanText || "")) && !fieldAvailable(record, "authorities.legislation")) blockers.push({ code: "CORE_LEGISLATION_COVERAGE_FAILED", path: "authorities.legislation", required: true });
  const coreStatus = blockers.some((blocker) => blocker.required === true) ? "review" : "pass";
  record.schemaVersion = "elite-core-v3.3"; record.coreStatus = coreStatus; record.blockers = blockers; record.normalizedAt = now();
  const path = await upload(`core-v3/runs/${runId}/record-normalized.json`, record);
  const metrics = { ...object(run.metrics), normalization: { at: now(), schemaVersion: "elite-core-v3.3" }, normalized: { judges: array(object(object(record.identity).judicialComposition).value).length, issues: array(object(object(record.analysis).legalIssues).value).length, obiter: array(object(object(record.analysis).obiterDicta).value).length, legislation: array(object(object(record.authorities).legislation).value).length, authorities: array(object(object(record.authorities).authorities).value).length, orders: array(object(object(record.outcome).orders).value).length, monetary: array(object(object(record.outcome).monetary).value).length, factsLength: text(object(object(record.facts).materialFacts).value?.summary).length } };
  const { error: updateError } = await db.schema("nomologies").from("core_v3_runs").update({ candidate_record: record, core_status: coreStatus, blockers, metrics, record_artifact_path: path, updated_at: now() }).eq("id", runId); if (updateError) throw new Error(`RUN_UPDATE_FAILED:${updateError.message}`);
  return { runId, coreStatus, blockers: blockers.length, recordPath: path, metrics };
}

Deno.serve(async (req: Request) => {
  if (!authorized(req)) return json({ ok: false, code: "UNAUTHORIZED" }, 401);
  try { const payload = object(await req.json().catch(() => ({}))); const runId = text(payload.runId); if (!/^[0-9a-f-]{36}$/i.test(runId)) return json({ ok: false, code: "RUN_ID_REQUIRED" }, 400); return json({ ok: true, ...await normalizeRun(runId) }); }
  catch (error) { console.error(error); return json({ ok: false, code: "NORMALIZER_ERROR", message: error instanceof Error ? error.message : String(error) }, 500); }
});
