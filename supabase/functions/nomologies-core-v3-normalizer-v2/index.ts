import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const BUCKET = "nomologies-artifacts";
const db = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

type R = Record<string, any>;
type Ev = { paragraphIds: string[]; quote: string };
const o = (v: unknown): R => v && typeof v === "object" && !Array.isArray(v) ? v as R : {};
const a = (v: unknown): any[] => Array.isArray(v) ? v : [];
const t = (v: unknown): string => typeof v === "string" ? v.trim() : "";
const nfc = (v: string): string => String(v || "").normalize("NFC").replace(/[\u00ad\u200b]/g, "").replace(/[\u00a0\u2007\u202f]/g, " ").replace(/[’‘`´]/g, "'").replace(/[“”]/g, '"').replace(/[‐‑‒–—―]/g, "-").replace(/\s+/gu, " ").trim();
const fold = (v: string): string => nfc(v).toLocaleLowerCase("el").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ς/g, "σ");
const meaningful = (v: unknown): boolean => typeof v === "string" ? !!v.trim() : Array.isArray(v) ? v.length > 0 : !!v && typeof v === "object" && Object.keys(v as R).length > 0;
const now = () => new Date().toISOString();
function res(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }
function auth(req: Request): boolean { return SERVICE !== "" && (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") === SERVICE; }
async function getJson(path: string): Promise<any> { const { data, error } = await db.storage.from(BUCKET).download(path); if (error || !data) throw new Error(`ARTIFACT_DOWNLOAD_FAILED:${error?.message || path}`); return JSON.parse(await data.text()); }
async function putJson(path: string, value: unknown): Promise<string> { const { error } = await db.storage.from(BUCKET).upload(path, new TextEncoder().encode(JSON.stringify(value)), { contentType: "application/json", upsert: true }); if (error) throw new Error(`ARTIFACT_UPLOAD_FAILED:${error.message}`); return path; }

function cleanFacts(field: R): R {
  if (field.status !== "available") return field;
  const value = o(field.value); const original = t(value.summary);
  const sentences = original.split(/(?<=[.!;··])\s+/u).map((sentence) => sentence.trim()).filter(Boolean);
  const kept = sentences.filter((sentence) => {
    const f = fold(sentence);
    const presentCourt = /^(?:το\s+δικαστηριο|κατεληξε|εκριν(?:ε|αν)|η\s+(?:εφεση|αιτηση))\b/u.test(f);
    const result = /(εξετασ|κατεληξ|απορριφ|επιτυχ|εκριν|αποτυγχ)/u.test(f);
    return !(presentCourt && result && !/πρωτοδικ/u.test(f));
  });
  return { ...field, value: { ...value, summary: kept.join(" ").trim() || original } };
}

function panel(rawAgents: R, source: R): R {
  const proposed = a(o(o(o(rawAgents.raw).identity).judicialComposition).value);
  const paragraphs = a(source.paragraphs);
  const panelParagraph = paragraphs.find((p: R) => /Δ\/στές|Δικαστές|Judges/iu.test(String(p.text || "")));
  if (!panelParagraph) return { status: "review", value: [], confidence: 0 };
  const panelText = fold(String(panelParagraph.text || ""));
  const deliveryAt = paragraphs.findIndex((p: R) => /θα\s+απαγγελθεί\s+από|delivered\s+by|judgment\s+of/iu.test(String(p.text || "")));
  const deliveryRows = deliveryAt >= 0 ? paragraphs.slice(deliveryAt, Math.min(paragraphs.length, deliveryAt + 3)) : [];
  const deliveryRaw = deliveryRows.map((p: R) => String(p.text || "")).join(" ");
  const deliveryFold = fold(deliveryRaw);
  const marker = deliveryFold.search(/θα\s+απαγγελθει\s+απο|delivered\s+by|judgment\s+of/u);
  const tail = marker >= 0 ? deliveryFold.slice(marker) : "";
  const values: R[] = [];
  for (const raw of proposed) {
    const name = t(raw.name); const surname = fold(name).split(/\s+/).at(-1)?.replace(/[^a-zα-ω-]/gu, "") || "";
    if (!surname || !panelText.includes(surname)) continue;
    let role = "panel";
    if (tail.includes(surname)) role = "authoring";
    else {
      const escaped = surname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`${escaped}[^a-zα-ω]{0,12}π\\.?`, "u").test(panelText)) role = "presiding";
    }
    const evidence: Ev[] = [{ paragraphIds: [String(panelParagraph.id)], quote: String(panelParagraph.text) }];
    if (role === "authoring") evidence.push({ paragraphIds: deliveryRows.map((p: R) => String(p.id)), quote: deliveryRaw });
    values.push({ name, role, evidence });
  }
  return { status: values.length ? "available" : "review", value: [...new Map(values.map((item) => [fold(item.name), item])).values()], confidence: values.length ? 0.99 : 0 };
}

function rebuildMoney(record: R): R {
  const orders = a(o(o(record.outcome).orders).value); const costs: R[] = [];
  for (const order of orders) {
    const orderText = t(order.text); if (!/έξοδα|costs/iu.test(orderText)) continue;
    const amount = orderText.match(/€\s*([\d.,]+)/u)?.[1] || "";
    const side = orderText.match(/πλευρά\s+των\s+([^,.]+)/iu);
    const forAgainst = orderText.match(/υπέρ\s+(.+?)\s+και\s+εναντίον\s+(.+?)(?:,|\.|$)/iu);
    let payer = side?.[1]?.trim() || ""; let payee = "";
    if (forAgainst) { payee = forAgainst[1].trim(); payer = forAgainst[2].trim(); }
    const stage = /πρωτόδικ/iu.test(orderText) ? "first_instance" : /έφεσ/iu.test(orderText) ? "appeal" : "other";
    const assessed = /υπολογισ|Πρωτοκολλητ/iu.test(orderText);
    costs.push({ type: "costs", stage, amount: amount ? amount.replace(/\./g, "").replace(",", ".") : "", currency: amount ? "EUR" : "", fixed: !!amount, status: amount ? "fixed" : assessed ? "to_be_assessed" : "not_stated", payer, payee, interest: "", evidence: a(order.evidence) });
  }
  const nonCosts = a(o(o(record.outcome).monetary).value).filter((item) => item.type !== "costs");
  const values = [...nonCosts, ...costs];
  return { status: values.length ? "available" : "not_found", value: values, confidence: values.length ? 0.99 : 1 };
}

const STOP = new Set(["του","της","των","περι","νομος","νομου","κανονισμος","κανονισμων","κανονισμοι","law","rules","rule","part","civil","procedure","the","of","and"]);
const toks = (value: string): string[] => fold(value).replace(/[^a-zα-ω0-9]+/gu, " ").split(/\s+/u).filter(Boolean);
function instrumentHints(item: R): string[] {
  const raw = toks(`${t(item.name)} ${t(item.lawId)}`);
  const numeric = raw.filter((token) => /^\d{2,4}$/u.test(token));
  const words = raw.filter((token) => token.length >= 5 && !STOP.has(token)).sort((left, right) => right.length - left.length).slice(0, 3);
  if (/συνταγμα/u.test(fold(`${t(item.name)} ${t(item.lawId)}`))) words.unshift("συνταγμα");
  return [...new Set([...numeric, ...words])];
}
function provisionHints(item: R): string[] {
  const raw = toks(`${t(item.display)} ${t(item.article)}`);
  const numbers = [...new Set(raw.filter((token) => /^\d+$/u.test(token)))].slice(0, 3);
  const marker = raw.find((token) => ["αρθρο","article","κανονισμος","rule","μερος","part"].includes(token));
  return [...new Set([...(marker ? [marker] : []), ...numbers])];
}
function ownership(source: R, instrument: R, provision: R): Ev | null {
  const paragraphs = a(source.paragraphs); const ih = instrumentHints(instrument); const ph = provisionHints(provision);
  if (!ph.length) return null;
  const candidates: Array<{ ev: Ev; score: number; width: number }> = [];
  for (let start = 0; start < paragraphs.length; start += 1) {
    for (let width = 1; width <= 4 && start + width <= paragraphs.length; width += 1) {
      const rows = paragraphs.slice(start, start + width); const joined = rows.map((p: R) => String(p.text || "")).join(" "); const f = fold(joined);
      const provisionMatch = ph.every((hint) => f.includes(hint));
      const score = ih.filter((hint) => f.includes(hint)).length;
      const instrumentMatch = ih.length ? score >= Math.min(2, ih.length) : true;
      if (provisionMatch && instrumentMatch) candidates.push({ ev: { paragraphIds: rows.map((p: R) => String(p.id)), quote: joined }, score, width });
    }
  }
  candidates.sort((left, right) => right.score - left.score || left.width - right.width);
  return candidates[0]?.ev || null;
}
function rebuildLegislation(rawAgents: R, source: R): R {
  const rawField = o(o(o(rawAgents.raw).authorities).legislation);
  if (rawField.status !== "available") return { status: "not_found", value: [], confidence: 1 };
  const values: R[] = [];
  for (const raw of a(rawField.value)) {
    const item = o(raw); const provisions: R[] = [];
    for (const rawProvision of a(item.provisions)) {
      const provision = o(rawProvision); const ev = ownership(source, item, provision);
      if (ev) provisions.push({ ...provision, evidence: [ev] });
    }
    if (!provisions.length) continue;
    const evidence = [...new Map(provisions.flatMap((p) => a(p.evidence)).map((ev: Ev) => [`${ev.paragraphIds.join(",")}|${nfc(ev.quote)}`, ev])).values()];
    values.push({ ...item, provisions, evidence });
  }
  const dedupe = new Map<string, R>();
  for (const item of values) {
    const key = fold(`${t(item.lawId)} ${t(item.name)}`);
    const prior = dedupe.get(key);
    if (!prior) { dedupe.set(key, item); continue; }
    const provisions = new Map([...a(prior.provisions), ...a(item.provisions)].map((p) => [fold(`${p.display} ${p.article}`), p]));
    dedupe.set(key, { ...prior, provisions: [...provisions.values()], evidence: [...a(prior.evidence), ...a(item.evidence)] });
  }
  const output = [...dedupe.values()];
  return { status: output.length ? "available" : "review", value: output, confidence: output.length ? 0.99 : 0 };
}
function dedupeAuthorities(field: R): R {
  if (field.status !== "available") return field;
  const dedupe = new Map<string, R>();
  for (const item of a(field.value)) {
    const key = fold(t(item.name)).replace(/[^a-zα-ω0-9]+/gu, " ").trim(); const prior = dedupe.get(key);
    if (!prior) { dedupe.set(key, item); continue; }
    dedupe.set(key, { ...prior, citation: [...new Set([t(prior.citation), t(item.citation)].filter(Boolean))].join("; "), legalPoint: [...new Set([t(prior.legalPoint), t(item.legalPoint)].filter(Boolean))].join(" "), evidence: [...new Map([...a(prior.evidence), ...a(item.evidence)].map((ev: Ev) => [`${ev.paragraphIds.join(",")}|${nfc(ev.quote)}`, ev])).values()] });
  }
  return { ...field, value: [...dedupe.values()] };
}
function weight(record: R): "Υψηλή" | "Μέση" | "Χαμηλή" {
  const court = fold(t(o(o(record.identity).court).value)); const issues = a(o(o(record.analysis).legalIssues).value); const outcome = t(o(o(record.outcome).overallOutcome).value);
  const senior = /ανωτατο|εφετειο|supreme|court of appeal/u.test(court); const procedural = /application_/.test(outcome);
  return senior && issues.length && !procedural ? "Υψηλή" : senior || issues.length ? "Μέση" : "Χαμηλή";
}
function available(record: R, path: string): boolean { const field = path.split(".").reduce((value: any, key) => o(value)[key], record); return o(field).status === "available" && meaningful(o(field).value); }
function keepBlockers(blockers: R[]): R[] {
  const repairedPaths = ["facts.materialFacts","identity.judicialComposition","outcome.monetary","authorities.legislation"];
  const repairedCodes = new Set(["PROVISION_NOT_GROUNDED","INSTRUMENT_NOT_GROUNDED","INSTRUMENT_PROVISIONS_REJECTED","CORE_REQUIRED_FIELD_MISSING","CORE_LEGISLATION_COVERAGE_FAILED"]);
  return blockers.filter((blocker) => !repairedPaths.some((path) => String(blocker.path || "").startsWith(path)) && !repairedCodes.has(String(blocker.code || "")));
}

async function normalizeRun(runId: string): Promise<R> {
  const { data: run, error } = await db.schema("nomologies").from("core_v3_runs").select("*").eq("id", runId).single();
  if (error) throw new Error(`RUN_READ_FAILED:${error.message}`);
  const source = await getJson(run.source_artifact_path); const agents = await getJson(run.agents_artifact_path); const record = structuredClone(o(run.candidate_record));
  record.facts = { ...o(record.facts), materialFacts: cleanFacts(o(o(record.facts).materialFacts)) };
  record.identity = { ...o(record.identity), judicialComposition: panel(agents, source) };
  record.outcome = { ...o(record.outcome), monetary: rebuildMoney(record) };
  record.authorities = { ...o(record.authorities), legislation: rebuildLegislation(agents, source), authorities: dedupeAuthorities(o(o(record.authorities).authorities)) };
  const legislation = a(o(o(record.authorities).legislation).value);
  record.header = { ...o(record.header), precedentialWeight: weight(record), primaryLegislation: legislation.filter((item) => item.role !== "background" && a(item.provisions).some((p) => ["applied","interpreted","considered"].includes(p.application))).slice(0, 4).map((item) => `${item.name}${item.lawId ? ` (${item.lawId})` : ""} — ${a(item.provisions).map((p) => p.display).join(", ")}`) };
  const blockers = keepBlockers(a(run.blockers));
  const required = ["identity.caseName","identity.caseNumber","identity.court","identity.decisionDate","identity.caseFamily","identity.judicialComposition","facts.materialFacts","analysis.legalIssues","outcome.overallOutcome","outcome.dispositionText"];
  for (const path of required) if (!available(record, path)) blockers.push({ code: "CORE_REQUIRED_FIELD_MISSING", path, required: true });
  if (/άρθρ|κανονισμ|νόμ|κεφ\.|\brule\b|\barticle\b/iu.test(String(source.cleanText || "")) && !available(record, "authorities.legislation")) blockers.push({ code: "CORE_LEGISLATION_COVERAGE_FAILED", path: "authorities.legislation", required: true });
  const coreStatus = blockers.some((blocker) => blocker.required === true) ? "review" : "pass";
  record.schemaVersion = "elite-core-v3.3"; record.coreStatus = coreStatus; record.blockers = blockers; record.normalizedAt = now();
  const path = await putJson(`core-v3/runs/${runId}/record-normalized.json`, record);
  const metrics = { ...o(run.metrics), normalization: { at: now(), schemaVersion: "elite-core-v3.3" }, normalized: { judges: a(o(o(record.identity).judicialComposition).value).length, issues: a(o(o(record.analysis).legalIssues).value).length, obiter: a(o(o(record.analysis).obiterDicta).value).length, legislation: legislation.length, authorities: a(o(o(record.authorities).authorities).value).length, orders: a(o(o(record.outcome).orders).value).length, monetary: a(o(o(record.outcome).monetary).value).length, factsLength: t(o(o(record.facts).materialFacts).value?.summary).length } };
  const { error: updateError } = await db.schema("nomologies").from("core_v3_runs").update({ candidate_record: record, core_status: coreStatus, blockers, metrics, record_artifact_path: path, updated_at: now() }).eq("id", runId);
  if (updateError) throw new Error(`RUN_UPDATE_FAILED:${updateError.message}`);
  return { runId, coreStatus, blockers: blockers.length, recordPath: path, metrics };
}

Deno.serve(async (req: Request) => {
  if (!auth(req)) return res({ ok: false, code: "UNAUTHORIZED" }, 401);
  try { const payload = o(await req.json().catch(() => ({}))); const runId = t(payload.runId); if (!/^[0-9a-f-]{36}$/i.test(runId)) return res({ ok: false, code: "RUN_ID_REQUIRED" }, 400); return res({ ok: true, ...await normalizeRun(runId) }); }
  catch (error) { console.error(error); return res({ ok: false, code: "NORMALIZER_ERROR", message: error instanceof Error ? error.message : String(error) }, 500); }
});
