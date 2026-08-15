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
const now = () => new Date().toISOString();
function res(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }
function auth(req: Request): boolean { return SERVICE !== "" && (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") === SERVICE; }
async function getJson(path: string): Promise<any> { const { data, error } = await db.storage.from(BUCKET).download(path); if (error || !data) throw new Error(`ARTIFACT_DOWNLOAD_FAILED:${error?.message || path}`); return JSON.parse(await data.text()); }
async function putJson(path: string, value: unknown): Promise<string> { const { error } = await db.storage.from(BUCKET).upload(path, new TextEncoder().encode(JSON.stringify(value)), { contentType: "application/json", upsert: true }); if (error) throw new Error(`ARTIFACT_UPLOAD_FAILED:${error.message}`); return path; }

function cleanFacts(record: R): void {
  const field = o(o(record.facts).materialFacts); if (field.status !== "available") return;
  const value = o(field.value); let summary = t(value.summary);
  const cut = summary.search(/\s+(?:Το\s+Δικαστήριο\s+εξέτασε|Το\s+Δικαστήριο\s+έκρινε|Κατέληξε\s+ότι|Το\s+Εφετείο\s+έκρινε)/u);
  if (cut > 0) summary = summary.slice(0, cut).trim();
  value.summary = summary; field.value = value; record.facts.materialFacts = field;
}
function parseCosts(record: R): R {
  const values: R[] = [];
  for (const order of a(o(o(record.outcome).orders).value)) {
    const evidenceText = a(order.evidence).map((ev: Ev) => ev.quote).join(" ");
    const sourceText = `${t(order.text)} ${evidenceText}`.trim();
    if (!/έξοδα|costs/iu.test(sourceText)) continue;
    const amountRaw = sourceText.match(/€\s*([\d.,]+)/u)?.[1]?.replace(/[.,]+$/u, "") || "";
    const side = sourceText.match(/πλευρά\s+των\s+([^,.;]+)/iu);
    const forAgainst = sourceText.match(/υπέρ\s+(.+?)\s+και\s+εναντίον\s+(.+?)(?:,|\.|$)/iu);
    let payer = side?.[1]?.trim() || ""; let payee = "";
    if (forAgainst) { payee = forAgainst[1].trim(); payer = forAgainst[2].trim(); }
    const stage = /πρωτόδικ/iu.test(sourceText) ? "first_instance" : /έφεσ/iu.test(sourceText) ? "appeal" : "other";
    const assessed = /υπολογισ|Πρωτοκολλητ/iu.test(sourceText);
    values.push({ type: "costs", stage, amount: amountRaw ? amountRaw.replace(/\./g, "").replace(",", ".") : "", currency: amountRaw ? "EUR" : "", fixed: !!amountRaw, status: amountRaw ? "fixed" : assessed ? "to_be_assessed" : "not_stated", payer, payee, interest: "", evidence: a(order.evidence) });
  }
  const dedupe = new Map<string, R>();
  for (const item of values) {
    const key = `${item.stage}|${item.amount}|${fold(item.payer)}|${fold(item.payee)}`;
    const prior = dedupe.get(key);
    if (!prior || (prior.status === "not_stated" && item.status === "to_be_assessed")) dedupe.set(key, item);
  }
  const nonCosts = a(o(o(record.outcome).monetary).value).filter((item) => item.type !== "costs").map((item) => ({ ...item, amount: t(item.amount).replace(/[.,]+$/u, "") }));
  const merged = [...nonCosts, ...dedupe.values()];
  return { status: merged.length ? "available" : "not_found", value: merged, confidence: merged.length ? 0.99 : 1 };
}
function cpr2023Window(source: R): Ev | null {
  const paragraphs = a(source.paragraphs);
  for (let start = 0; start < paragraphs.length; start += 1) {
    for (let width = 1; width <= 3 && start + width <= paragraphs.length; width += 1) {
      const rows = paragraphs.slice(start, start + width); const joined = rows.map((p: R) => String(p.text || "")).join(" "); const f = fold(joined);
      if (/κανονισμ/u.test(f) && /πολιτικ/u.test(f) && /δικονομ/u.test(f) && /μεροσ\s*41/u.test(f) && /κανονισμ[^0-9]{0,20}15/u.test(f)) return { paragraphIds: rows.map((p: R) => String(p.id)), quote: joined };
    }
  }
  return null;
}
function fixLegislation(record: R, source: R): void {
  const field = o(o(record.authorities).legislation); const values: R[] = [];
  for (const raw of a(field.value)) {
    const item = structuredClone(o(raw)); const name = fold(`${t(item.name)} ${t(item.lawId)}`);
    item.provisions = a(item.provisions).filter((provision) => {
      const display = fold(`${t(provision.display)} ${t(provision.article)}`);
      return !(name.includes("ανωτατου δικαστηριου") && (display.includes("μεροσ 41") || /(?:^|\s)15(?:\s|$)/u.test(display)));
    });
    if (item.provisions.length) values.push(item);
  }
  const window = cpr2023Window(source);
  if (window) values.push({
    name: "Κανονισμοί Πολιτικής Δικονομίας του 2023",
    lawId: "",
    role: "procedural",
    provisions: [{ display: "Μέρος 41, Κανονισμός 15", article: "15", application: "considered", evidence: [window] }],
    proposition: "Προβλέπει ειδική διαδικασία για επανάνοιγμα έφεσης μετά την έκδοση τελικής απόφασης.",
    evidence: [window],
  });
  const dedupe = new Map<string, R>();
  for (const item of values) {
    const key = fold(`${t(item.lawId)} ${t(item.name)}`); const prior = dedupe.get(key);
    if (!prior) { dedupe.set(key, item); continue; }
    const provisions = new Map([...a(prior.provisions), ...a(item.provisions)].map((p) => [fold(`${p.display} ${p.article}`), p]));
    dedupe.set(key, { ...prior, provisions: [...provisions.values()], evidence: [...a(prior.evidence), ...a(item.evidence)] });
  }
  const output = [...dedupe.values()];
  record.authorities.legislation = { status: output.length ? "available" : "review", value: output, confidence: output.length ? 0.99 : 0 };
}
function recalcHeader(record: R): void {
  const legislation = a(o(o(record.authorities).legislation).value);
  record.header = {
    ...o(record.header),
    primaryLegislation: legislation.filter((item) => item.role !== "background" && a(item.provisions).some((p) => ["applied","interpreted","considered"].includes(p.application))).slice(0, 5).map((item) => `${item.name}${item.lawId ? ` (${item.lawId})` : ""} — ${a(item.provisions).map((p) => p.display).join(", ")}`),
  };
}
async function postnormalize(runId: string): Promise<R> {
  const { data: run, error } = await db.schema("nomologies").from("core_v3_runs").select("*").eq("id", runId).single(); if (error) throw new Error(`RUN_READ_FAILED:${error.message}`);
  const source = await getJson(run.source_artifact_path); const record = structuredClone(o(run.candidate_record));
  cleanFacts(record); record.outcome.monetary = parseCosts(record); fixLegislation(record, source); recalcHeader(record);
  record.schemaVersion = "elite-core-v3.4"; record.postNormalizedAt = now();
  const path = await putJson(`core-v3/runs/${runId}/record-post-normalized.json`, record);
  const metrics = { ...o(run.metrics), postNormalization: { at: now(), schemaVersion: "elite-core-v3.4" }, final: { judges: a(o(o(record.identity).judicialComposition).value).length, issues: a(o(o(record.analysis).legalIssues).value).length, obiter: a(o(o(record.analysis).obiterDicta).value).length, legislation: a(o(o(record.authorities).legislation).value).length, authorities: a(o(o(record.authorities).authorities).value).length, orders: a(o(o(record.outcome).orders).value).length, monetary: a(o(o(record.outcome).monetary).value).length, factsLength: t(o(o(record.facts).materialFacts).value?.summary).length } };
  const { error: updateError } = await db.schema("nomologies").from("core_v3_runs").update({ candidate_record: record, metrics, record_artifact_path: path, updated_at: now() }).eq("id", runId); if (updateError) throw new Error(`RUN_UPDATE_FAILED:${updateError.message}`);
  return { runId, coreStatus: run.core_status, recordPath: path, metrics };
}

Deno.serve(async (req: Request) => {
  if (!auth(req)) return res({ ok: false, code: "UNAUTHORIZED" }, 401);
  try { const payload = o(await req.json().catch(() => ({}))); const runId = t(payload.runId); if (!/^[0-9a-f-]{36}$/i.test(runId)) return res({ ok: false, code: "RUN_ID_REQUIRED" }, 400); return res({ ok: true, ...await postnormalize(runId) }); }
  catch (error) { console.error(error); return res({ ok: false, code: "POST_NORMALIZER_ERROR", message: error instanceof Error ? error.message : String(error) }, 500); }
});
