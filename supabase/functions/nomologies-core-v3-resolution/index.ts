import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const BUCKET = "nomologies-artifacts";
const db = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

type Row = Record<string, any>;
type Evidence = { paragraphIds: string[]; quote: string };
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const array = (value: unknown): any[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const meaningful = (value: unknown): boolean => typeof value === "string" ? !!value.trim() : Array.isArray(value) ? value.length > 0 : !!value && typeof value === "object" && Object.keys(value as Row).length > 0;
const normalize = (value: string): string => String(value || "").normalize("NFC").replace(/[\u00ad\u200b]/g, "").replace(/[\u00a0\u2007\u202f]/g, " ").replace(/[’‘`´]/g, "'").replace(/[“”]/g, '"').replace(/[‐‑‒–—―]/g, "-").replace(/\s+/gu, " ").trim();
const fold = (value: string): string => normalize(value).toLocaleLowerCase("el").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ς/g, "σ");
const now = () => new Date().toISOString();
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }
function authorized(req: Request): boolean { return SERVICE !== "" && (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") === SERVICE; }
async function download(path: string): Promise<any> { const { data, error } = await db.storage.from(BUCKET).download(path); if (error || !data) throw new Error(`ARTIFACT_DOWNLOAD_FAILED:${error?.message || path}`); return JSON.parse(await data.text()); }
async function upload(path: string, value: unknown): Promise<string> { const { error } = await db.storage.from(BUCKET).upload(path, new TextEncoder().encode(JSON.stringify(value)), { contentType: "application/json", upsert: true }); if (error) throw new Error(`ARTIFACT_UPLOAD_FAILED:${error.message}`); return path; }

function evidenceValid(raw: unknown, source: Row): Evidence[] {
  const paragraphs = array(source.paragraphs);
  const byId = new Map(paragraphs.map((paragraph: Row) => [String(paragraph.id), paragraph]));
  const ordinal = new Map(paragraphs.map((paragraph: Row) => [String(paragraph.id), Number(paragraph.ordinal || 0)]));
  const valid: Evidence[] = [];
  for (const rawItem of array(raw)) {
    const item = object(rawItem); const ids = array(item.paragraphIds).map(String).filter(Boolean); const quote = text(item.quote);
    if (!ids.length || !quote) continue;
    const rows = ids.map((id) => byId.get(id)); const ordinals = ids.map((id) => ordinal.get(id) || 0).sort((left, right) => left - right);
    if (rows.every(Boolean) && !ordinals.some((value, index) => index > 0 && value !== ordinals[index - 1] + 1) && normalize(rows.map((paragraph) => String(paragraph?.text || "")).join(" ")).includes(normalize(quote))) {
      valid.push({ paragraphIds: ids, quote });
    }
  }
  return [...new Map(valid.map((anchor) => [`${anchor.paragraphIds.join(",")}|${normalize(anchor.quote)}`, anchor])).values()];
}

function parsePanel(source: Row): Row {
  const paragraphs = array(source.paragraphs);
  const panelParagraph = paragraphs.find((paragraph: Row) => /Δ\/στές|Δικαστές|ΔΔ|Judges/iu.test(String(paragraph.text || "")));
  if (!panelParagraph) return { status: "review", value: [], confidence: 0 };
  let inside = String(panelParagraph.text || "").replace(/^\s*\[/u, "").replace(/\]\s*$/u, "");
  inside = inside.replace(/,?\s*(?:Δ\/στές|Δικαστές|ΔΔ|Judges)\s*$/iu, "");
  const parts = inside.split(/\s*,\s*/u).map((part) => part.trim()).filter(Boolean);
  const judges: Row[] = [];
  for (const part of parts) {
    if (/^(?:Π|ΠΡΟΕΔΡΕΥΩΝ)\.?$/iu.test(part)) { if (judges.length) judges[judges.length - 1].role = "presiding"; continue; }
    if (/^(?:Δ|ΔΙΚΑΣΤΗΣ)\.?$/iu.test(part)) continue;
    const cleaned = part.replace(/\s+(?:Π|Δ)\.?$/iu, "").trim();
    if (cleaned.length < 2 || !/[Α-ΩA-Z]/u.test(cleaned)) continue;
    judges.push({ name: cleaned, role: /\sΠ\.?$/iu.test(part) ? "presiding" : "panel", evidence: [{ paragraphIds: [String(panelParagraph.id)], quote: String(panelParagraph.text || "") }] });
  }

  let authoringSurname = "";
  const deliveryAt = paragraphs.findIndex((paragraph: Row) => /θα\s+(?:απαγγελθεί|δοθεί)\s+από|delivered\s+by|judgment\s+of/iu.test(String(paragraph.text || "")));
  let deliveryRows: Row[] = [];
  if (deliveryAt >= 0) {
    deliveryRows = paragraphs.slice(deliveryAt, Math.min(paragraphs.length, deliveryAt + 3));
    const deliveryFolded = fold(deliveryRows.map((paragraph: Row) => String(paragraph.text || "")).join(" "));
    const marker = deliveryFolded.search(/θα\s+(?:απαγγελθει|δοθει)\s+απο|delivered\s+by|judgment\s+of/u);
    const tail = marker >= 0 ? deliveryFolded.slice(marker) : deliveryFolded;
    authoringSurname = judges.map((judge) => fold(judge.name).split(/\s+/u).at(-1)?.replace(/[^a-zα-ω-]/gu, "") || "").find((surname) => surname && tail.includes(surname)) || "";
  }
  if (!authoringSurname) {
    const judgmentIndex = paragraphs.findIndex((paragraph: Row) => /Α\s*Π\s*Ο\s*Φ\s*Α\s*Σ\s*Η|JUDGMENT/iu.test(String(paragraph.text || "")));
    const body = paragraphs.slice(Math.max(0, judgmentIndex + 1), Math.min(paragraphs.length, Math.max(0, judgmentIndex + 8)));
    const bodyFolded = fold(body.map((paragraph: Row) => String(paragraph.text || "")).join(" "));
    authoringSurname = judges.map((judge) => fold(judge.name).split(/\s+/u).at(-1)?.replace(/[^a-zα-ω-]/gu, "") || "").find((surname) => surname && new RegExp(`(?:^|\\s)${surname}\\s*,?\\s*δ\\.?\\s*:`, "u").test(bodyFolded)) || "";
    if (authoringSurname) deliveryRows = body;
  }
  if (authoringSurname) {
    const raw = deliveryRows.map((paragraph) => String(paragraph.text || "")).join(" ");
    for (const judge of judges) {
      const surname = fold(judge.name).split(/\s+/u).at(-1)?.replace(/[^a-zα-ω-]/gu, "") || "";
      if (surname === authoringSurname) {
        judge.role = "authoring";
        if (raw) judge.evidence.push({ paragraphIds: deliveryRows.map((paragraph) => String(paragraph.id)), quote: raw });
      }
    }
  }
  return { status: judges.length ? "available" : "review", value: judges, confidence: judges.length ? 0.99 : 0 };
}

function repairDisposition(record: Row, source: Row): void {
  const field = object(object(record.outcome).dispositionText);
  const valid = evidenceValid(field.evidence, source);
  if (meaningful(field.value) && valid.length) record.outcome.dispositionText = { ...field, status: "available", confidence: Math.max(0.98, Number(field.confidence || 0)), evidence: valid };
}
function repairMixedOutcome(record: Row, source: Row): void {
  const orders = array(object(object(record.outcome).orders).value);
  const combined = fold(orders.map((item) => `${text(item.text)} ${array(item.evidence).map((anchor: Evidence) => anchor.quote).join(" ")}`).join(" "));
  const evidence = evidenceValid(orders.flatMap((item) => array(item.evidence)), source);
  if (!evidence.length) return;
  const appealDismissed = /εφεση[^.]{0,80}απορριπ/u.test(combined);
  const crossAppealPartly = /αντεφεση[^.]{0,200}(?:πεντε\s+πρωτ|πρωτους\s+λογους)[^.]{0,220}(?:εκτο\s+λογο)[^.]{0,120}(?:επιτυγχαν|βασιμ)/u.test(combined) ||
    (/αντεφεση[^.]{0,120}απορριπ/u.test(combined) && /εκτο[^.]{0,100}(?:επιτυγχαν|βασιμ)/u.test(combined));
  const crossAppealAllowed = /αντεφεση[^.]{0,100}(?:επιτυγχαν|γινεται\s+δεκτ)/u.test(combined);
  let code = text(object(object(record.outcome).overallOutcome).value);
  if (appealDismissed && crossAppealPartly) code = "appeal_dismissed_cross_appeal_partly_allowed";
  else if (appealDismissed && crossAppealAllowed) code = "appeal_dismissed_cross_appeal_allowed";
  else if (appealDismissed) code = "appeal_dismissed";
  if (code) record.outcome.overallOutcome = { status: "available", value: code, confidence: 0.99, evidence };
}

function fieldAvailable(record: Row, path: string): boolean {
  const field = path.split(".").reduce((value: any, key) => object(value)[key], record);
  return object(field).status === "available" && meaningful(object(field).value);
}
function listParentAvailable(record: Row, path: string): boolean {
  const parent = path.replace(/\[\d+\].*$/u, "");
  return fieldAvailable(record, parent);
}
function resolveBlockers(record: Row, blockers: Row[]): Row[] {
  const repairedPaths = ["identity.judicialComposition", "outcome.overallOutcome", "outcome.dispositionText"];
  return blockers.filter((blocker) => {
    const path = String(blocker.path || ""); const code = String(blocker.code || "");
    if (repairedPaths.some((repaired) => path.startsWith(repaired)) && fieldAvailable(record, repairedPaths.find((repaired) => path.startsWith(repaired))!)) return false;
    if (/\[\d+\]/u.test(path) && listParentAvailable(record, path)) return false;
    if (code === "CORE_REQUIRED_FIELD_MISSING" && fieldAvailable(record, path)) return false;
    return true;
  });
}

async function resolve(runId: string): Promise<Row> {
  const { data: run, error } = await db.schema("nomologies").from("core_v3_runs").select("*").eq("id", runId).single();
  if (error) throw new Error(`RUN_READ_FAILED:${error.message}`);
  const source = await download(run.source_artifact_path); const record = structuredClone(object(run.candidate_record));
  record.identity = { ...object(record.identity), judicialComposition: parsePanel(source) };
  repairDisposition(record, source);
  repairMixedOutcome(record, source);
  let blockers = resolveBlockers(record, array(run.blockers));
  const required = ["identity.caseName","identity.caseNumber","identity.court","identity.decisionDate","identity.caseFamily","identity.judicialComposition","facts.materialFacts","analysis.legalIssues","outcome.overallOutcome","outcome.dispositionText"];
  for (const path of required) if (!fieldAvailable(record, path) && !blockers.some((blocker) => blocker.code === "CORE_REQUIRED_FIELD_MISSING" && blocker.path === path)) blockers.push({ code: "CORE_REQUIRED_FIELD_MISSING", path, required: true });
  blockers = blockers.map((blocker) => {
    if (/^analysis\.legalIssues\[\d+\]/u.test(String(blocker.path || "")) && fieldAvailable(record, "analysis.legalIssues")) return { ...blocker, required: false };
    return blocker;
  });
  const coreStatus = blockers.some((blocker) => blocker.required === true) ? "review" : "pass";
  record.schemaVersion = "elite-core-v3.6"; record.coreStatus = coreStatus; record.blockers = blockers; record.resolvedAt = now();
  const path = await upload(`core-v3/runs/${runId}/record-resolved.json`, record);
  const metrics = { ...object(run.metrics), resolution: { at: now(), schemaVersion: "elite-core-v3.6" }, resolved: { judges: array(object(object(record.identity).judicialComposition).value).length, issues: array(object(object(record.analysis).legalIssues).value).length, obiter: array(object(object(record.analysis).obiterDicta).value).length, legislation: array(object(object(record.authorities).legislation).value).length, authorities: array(object(object(record.authorities).authorities).value).length, orders: array(object(object(record.outcome).orders).value).length, monetary: array(object(object(record.outcome).monetary).value).length, factsLength: text(object(object(record.facts).materialFacts).value?.summary).length } };
  const { error: updateError } = await db.schema("nomologies").from("core_v3_runs").update({ candidate_record: record, core_status: coreStatus, blockers, metrics, record_artifact_path: path, updated_at: now() }).eq("id", runId);
  if (updateError) throw new Error(`RUN_UPDATE_FAILED:${updateError.message}`);
  return { runId, coreStatus, blockers: blockers.length, recordPath: path, metrics };
}

Deno.serve(async (req: Request) => {
  if (!authorized(req)) return json({ ok: false, code: "UNAUTHORIZED" }, 401);
  try { const payload = object(await req.json().catch(() => ({}))); const runId = text(payload.runId); if (!/^[0-9a-f-]{36}$/i.test(runId)) return json({ ok: false, code: "RUN_ID_REQUIRED" }, 400); return json({ ok: true, ...await resolve(runId) }); }
  catch (error) { console.error(error); return json({ ok: false, code: "RESOLUTION_ERROR", message: error instanceof Error ? error.message : String(error) }, 500); }
});
