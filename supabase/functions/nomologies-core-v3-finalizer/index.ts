import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { createStructuredResponse } from "https://raw.githubusercontent.com/marinos151111-del/mynomosgpt/186ff106df99541e2604eab64ba43921d5c88cf2/src/nomologies-v2/openai-responses.ts";

const URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const MODEL = "gpt-5.4-mini";
const BUCKET = "nomologies-artifacts";
const db = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

type R = Record<string, any>;
type Ev = { paragraphIds: string[]; quote: string };
const o = (value: unknown): R => value && typeof value === "object" && !Array.isArray(value) ? value as R : {};
const a = (value: unknown): any[] => Array.isArray(value) ? value : [];
const t = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const meaningful = (value: unknown): boolean => typeof value === "string" ? !!value.trim() : Array.isArray(value) ? value.length > 0 : !!value && typeof value === "object" && Object.keys(value as R).length > 0;
const nfc = (value: string): string => String(value || "").normalize("NFC").replace(/[\u00ad\u200b]/g, "").replace(/[\u00a0\u2007\u202f]/g, " ").replace(/[’‘`´]/g, "'").replace(/[“”]/g, '"').replace(/[‐‑‒–—―]/g, "-").replace(/\s+/gu, " ").trim();
const fold = (value: string): string => nfc(value).toLocaleLowerCase("el").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ς/g, "σ");
const now = () => new Date().toISOString();
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }
function authorized(req: Request): boolean { return SERVICE !== "" && (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") === SERVICE; }
async function download(path: string): Promise<any> { const { data, error } = await db.storage.from(BUCKET).download(path); if (error || !data) throw new Error(`ARTIFACT_DOWNLOAD_FAILED:${error?.message || path}`); return JSON.parse(await data.text()); }
async function upload(path: string, value: unknown): Promise<string> { const { error } = await db.storage.from(BUCKET).upload(path, new TextEncoder().encode(JSON.stringify(value)), { contentType: "application/json", upsert: true }); if (error) throw new Error(`ARTIFACT_UPLOAD_FAILED:${error.message}`); return path; }

const STOP = new Set([
  "και","του","της","των","στο","στη","στην","στον","που","για","απο","προς","κατα","περι","ως","με","να","οτι","αυτο","αυτη","ειναι","ηταν","εχει","ειχε","δεν","μια","ενα","ενας","των","τους","την","τον","οι","τα","το","η","ο",
  "the","and","of","to","in","on","for","by","with","from","was","were","is","are","not","that","this","an","a",
]);
function tokens(value: string): string[] {
  return fold(value).replace(/[^a-zα-ω0-9]+/gu, " ").split(/\s+/u).filter((token) => token.length >= 3 && !STOP.has(token));
}
function evidenceValid(raw: unknown, source: R): Ev[] {
  const paragraphs = a(source.paragraphs); const byId = new Map(paragraphs.map((paragraph: R) => [String(paragraph.id), paragraph])); const ordinal = new Map(paragraphs.map((paragraph: R) => [String(paragraph.id), Number(paragraph.ordinal || 0)]));
  const valid: Ev[] = [];
  for (const item of a(raw)) {
    const row = o(item); const ids = a(row.paragraphIds).map(String).filter(Boolean); const quote = t(row.quote); if (!ids.length || !quote) continue;
    const rows = ids.map((id) => byId.get(id)); const ords = ids.map((id) => ordinal.get(id) || 0).sort((left, right) => left - right);
    if (rows.every(Boolean) && !ords.some((value, index) => index > 0 && value !== ords[index - 1] + 1) && nfc(rows.map((paragraph) => String(paragraph?.text || "")).join(" ")).includes(nfc(quote))) valid.push({ paragraphIds: ids, quote });
  }
  return [...new Map(valid.map((anchor) => [`${anchor.paragraphIds.join(",")}|${nfc(anchor.quote)}`, anchor])).values()];
}
function exactParagraph(source: R, id: string): Ev | null {
  const paragraph = a(source.paragraphs).find((item: R) => String(item.id) === id);
  return paragraph ? { paragraphIds: [id], quote: String(paragraph.text || "") } : null;
}

function parsePanel(source: R): R {
  const paragraphs = a(source.paragraphs);
  const panelParagraph = paragraphs.find((paragraph: R) => /Δ\/στές|Δικαστές|\bΔΔ\b|Judges/iu.test(String(paragraph.text || "")));
  if (!panelParagraph) return { status: "review", value: [], confidence: 0 };
  let inside = String(panelParagraph.text || "").replace(/^\s*\[/u, "").replace(/\]\s*$/u, "");
  inside = inside.replace(/,?\s*(?:Δ\/στές|Δικαστές|ΔΔ|Judges)\s*$/iu, "");
  const parts = inside.split(/\s*,\s*/u).map((part) => part.trim()).filter(Boolean);
  const judges: R[] = [];
  for (const part of parts) {
    if (/^(?:Π|ΠΡΟΕΔΡΕΥΩΝ)\.?$/iu.test(part)) { if (judges.length) judges[judges.length - 1].role = "presiding"; continue; }
    if (/^(?:Δ|ΔΙΚΑΣΤΗΣ)\.?$/iu.test(part)) continue;
    const cleaned = part.replace(/\s+(?:Π|Δ)\.?$/iu, "").trim();
    if (cleaned.length < 2 || !/[Α-ΩA-Z]/u.test(cleaned)) continue;
    judges.push({ name: cleaned, role: /\sΠ\.?$/iu.test(part) ? "presiding" : "panel", evidence: [{ paragraphIds: [String(panelParagraph.id)], quote: String(panelParagraph.text || "") }] });
  }
  const deliveryAt = paragraphs.findIndex((paragraph: R) => /θα\s+(?:απαγγελθεί|δοθεί)\s+από|delivered\s+by|judgment\s+of/iu.test(String(paragraph.text || "")));
  if (deliveryAt >= 0) {
    const rows = paragraphs.slice(deliveryAt, Math.min(paragraphs.length, deliveryAt + 3)); const raw = rows.map((paragraph: R) => String(paragraph.text || "")).join(" "); const tail = fold(raw).replace(/^.*?(?:θα\s+(?:απαγγελθει|δοθει)\s+απο|delivered\s+by|judgment\s+of)/u, "");
    for (const judge of judges) {
      const surname = fold(judge.name).split(/\s+/u).at(-1)?.replace(/[^a-zα-ω-]/gu, "") || "";
      if (surname && tail.includes(surname)) {
        judge.role = "authoring";
        judge.evidence.push({ paragraphIds: rows.map((paragraph: R) => String(paragraph.id)), quote: raw });
      }
    }
  }
  return { status: judges.length ? "available" : "review", value: judges, confidence: judges.length ? 0.99 : 0 };
}

function bestWindow(source: R, claim: string, kind: "fact" | "principle" | "holding"): Ev | null {
  const paragraphs = a(source.paragraphs); const claimTokens = [...new Set(tokens(claim))]; if (!claimTokens.length) return null;
  const candidates: Array<{ ev: Ev; score: number; coverage: number }> = [];
  for (let start = 0; start < paragraphs.length; start += 1) {
    for (let width = 1; width <= 4 && start + width <= paragraphs.length; width += 1) {
      const rows = paragraphs.slice(start, start + width); const raw = rows.map((paragraph: R) => String(paragraph.text || "")).join(" "); const f = fold(raw);
      if (/^(?:με\s+τον|με\s+τη|ο\s+εφεσειων|η\s+εφεσειουσα|ο\s+εφεσιβλητος|κατα\s+τον)\b/u.test(f) && /(ισχυριζ|διατειν|αποδιδ|προβαλλ)/u.test(f)) continue;
      const windowTokens = new Set(tokens(raw)); let hits = 0; for (const token of claimTokens) if (windowTokens.has(token)) hits += 1;
      const coverage = hits / claimTokens.length;
      let boost = 0;
      if (kind === "holding" && /(κρινο|θεωρουμε|βρισκουμε|ορθα|εσφαλμεν|απορριπτεται|επιτυγχανει|δεν\s+ευσταθει|φερει\s+την\s+αποκλειστικη)/u.test(f)) boost += 0.22;
      if (kind === "principle" && /(παγια|νομικ[ηο]\s+αρχ|το\s+εφετειο\s+επεμβαινει|συμβαση\s+υπο\s+αιρεση|δικαιουται|απαιτειται)/u.test(f)) boost += 0.18;
      if (kind === "fact" && /(εργοδοτ|τραυματ|συμφων|αγορασ|μεταβιβ|τεμαχ|βιβλι|πληροφορι)/u.test(f)) boost += 0.08;
      const score = coverage + boost - Math.max(0, width - 2) * 0.025;
      if (score >= (kind === "fact" ? 0.25 : 0.18)) candidates.push({ ev: { paragraphIds: rows.map((paragraph: R) => String(paragraph.id)), quote: raw }, score, coverage });
    }
  }
  candidates.sort((left, right) => right.score - left.score || right.coverage - left.coverage || left.ev.paragraphIds.length - right.ev.paragraphIds.length);
  return candidates[0]?.ev || null;
}

function groundFacts(record: R, rawAgents: R, source: R): R {
  const current = o(o(record.facts).materialFacts); const raw = o(o(o(rawAgents.raw).facts).materialFacts); const field = current.status === "available" || meaningful(current.value) ? current : raw;
  const value = o(field.value); const points = a(value.points).map(String).filter(Boolean); const anchors: Ev[] = [];
  for (const point of points) { const anchor = bestWindow(source, point, "fact"); if (anchor) anchors.push(anchor); }
  if (!anchors.length) {
    for (const anchor of evidenceValid(field.evidence, source)) anchors.push(anchor);
  }
  let summary = t(value.summary);
  const cut = summary.search(/\s+(?:Το\s+Δικαστήριο\s+εξέτασε|Το\s+Δικαστήριο\s+έκρινε|Κατέληξε\s+ότι|Το\s+Εφετείο\s+έκρινε)/u);
  if (cut > 0) summary = summary.slice(0, cut).trim();
  const unique = [...new Map(anchors.map((anchor) => [`${anchor.paragraphIds.join(",")}|${nfc(anchor.quote)}`, anchor])).values()].slice(0, 10);
  return meaningful(summary) && unique.length >= Math.min(2, Math.max(1, Math.ceil(points.length / 3)))
    ? { status: "available", value: { summary, points }, confidence: 0.97, evidence: unique }
    : { status: "review", value: { summary, points }, confidence: 0, evidence: unique };
}

function groundIssues(record: R, rawAgents: R, source: R): R {
  const current = o(o(record.analysis).legalIssues); const raw = o(o(o(rawAgents.raw).analysis).legalIssues);
  const candidates = a(current.value).length ? a(current.value) : a(raw.value);
  const values: R[] = [];
  for (const item of candidates.slice(0, 5)) {
    const issue = t(item.issue); const principle = t(item.principle); const holding = t(item.holding);
    if (!issue || !holding) continue;
    const existing = evidenceValid(item.evidence, source);
    const principleAnchor = principle ? bestWindow(source, principle, "principle") : null;
    const holdingAnchor = bestWindow(source, holding, "holding");
    const anchors = [...existing, ...(principleAnchor ? [principleAnchor] : []), ...(holdingAnchor ? [holdingAnchor] : [])];
    const unique = [...new Map(anchors.map((anchor) => [`${anchor.paragraphIds.join(",")}|${nfc(anchor.quote)}`, anchor])).values()].slice(0, 8);
    if (!holdingAnchor || !unique.length) continue;
    values.push({ issue, principle, holding, evidence: unique });
  }
  const deduped = new Map<string, R>();
  for (const item of values) {
    const key = fold(item.issue).replace(/[^a-zα-ω0-9]+/gu, " ").trim();
    const prior = [...deduped.entries()].find(([existing]) => {
      const left = new Set(tokens(existing)); const right = new Set(tokens(key)); let common = 0; for (const token of left) if (right.has(token)) common += 1;
      return common / Math.max(1, Math.min(left.size, right.size)) >= 0.72;
    });
    if (!prior) deduped.set(key, item);
    else if (item.evidence.length > prior[1].evidence.length) deduped.set(prior[0], item);
  }
  const output = [...deduped.values()].slice(0, 3);
  return { status: output.length ? "available" : "review", value: output, confidence: output.length ? 0.96 : 0 };
}

function fixOutcome(record: R): void {
  const orders = a(o(o(record.outcome).orders).value); const combined = fold(orders.map((item) => t(item.text)).join(" "));
  const evidence = [...new Map(orders.flatMap((item) => a(item.evidence)).map((anchor: Ev) => [`${anchor.paragraphIds.join(",")}|${nfc(anchor.quote)}`, anchor])).values()];
  const appealDismissed = /εφεση\s+(?:απορριπ|δεν\s+επιτυγχαν)/u.test(combined);
  const appealAllowed = /εφεση[^.]{0,90}(?:επιτυγχαν|γινεται\s+δεκτ)/u.test(combined);
  const crossAppealPart = /αντεφεση[^.]{0,180}(?:απορριπ)[^.]{0,180}(?:επιτυγχαν|βασιμ)/u.test(combined);
  const crossAppealAllowed = /αντεφεση[^.]{0,100}(?:επιτυγχαν|γινεται\s+δεκτ)/u.test(combined);
  let code = t(o(o(record.outcome).overallOutcome).value);
  if (appealDismissed && crossAppealPart) code = "appeal_dismissed_cross_appeal_partly_allowed";
  else if (appealDismissed && crossAppealAllowed) code = "appeal_dismissed_cross_appeal_allowed";
  else if (appealDismissed) code = "appeal_dismissed";
  else if (appealAllowed && /παραπεμπ|εν\s+μερει|μερικ/u.test(combined)) code = "appeal_partly_allowed";
  else if (appealAllowed) code = "appeal_allowed";
  if (code && evidence.length) record.outcome.overallOutcome = { status: "available", value: code, confidence: 0.99, evidence };

  const disposition = o(o(record.outcome).dispositionText); const summary = t(disposition.value) || orders.filter((item) => item.category === "disposition" || item.category === "remittal").map((item) => t(item.text)).filter(Boolean).join(" ");
  if (summary && evidence.length) record.outcome.dispositionText = { status: "available", value: summary, confidence: 0.98, evidence };
}

const S = { string: { type: "string" } };
const verifySchema: R = {
  type: "object", additionalProperties: false,
  properties: {
    checks: { type: "array", items: { type: "object", additionalProperties: false, properties: { id: S.string, verdict: { type: "string", enum: ["accept","reject","review"] }, reason: S.string }, required: ["id","verdict","reason"] } },
    overallComment: S.string,
  },
  required: ["checks","overallComment"],
};
const VERIFY_PROMPT = `You are the final legal attribution verifier for a Cyprus case-law core record. Return exactly one check for every supplied id. Accept a concise synthesis only where its exact source contexts collectively prove it. Reject party submissions presented as findings, quoted authorities presented as the present court's principle, earlier orders presented as the final disposition, wrong mixed appeal/cross-appeal outcomes, and unsupported judge roles. Do not rewrite claims and do not invent ids.`;
function verificationClaims(record: R, source: R): { claims: R[]; meta: Map<string, R> } {
  const paragraphs = a(source.paragraphs); const ordinals = new Map(paragraphs.map((paragraph: R) => [String(paragraph.id), Number(paragraph.ordinal || 0)])); const claims: R[] = []; const meta = new Map<string, R>();
  const add = (id: string, path: string, claim: string, evidence: Ev[], index?: number) => {
    const contexts = evidence.map((anchor) => {
      const indexes = anchor.paragraphIds.map((paragraphId) => (ordinals.get(paragraphId) || 1) - 1); const start = Math.max(0, Math.min(...indexes) - 1); const end = Math.min(paragraphs.length, Math.max(...indexes) + 2);
      return { cited: anchor, context: paragraphs.slice(start, end).map((paragraph: R) => `[${paragraph.id}] ${paragraph.text}`).join("\n") };
    });
    claims.push({ id, path, claim, evidenceContexts: contexts }); meta.set(id, { path, index });
  };
  const facts = o(o(record.facts).materialFacts); if (facts.status === "available") add("facts.materialFacts", "facts.materialFacts", `Πραγματικά: ${t(o(facts.value).summary)}`, a(facts.evidence));
  const issues = o(o(record.analysis).legalIssues); if (issues.status === "available") a(issues.value).forEach((item, index) => add(`analysis.legalIssues[${index}]`, "analysis.legalIssues", `Ζήτημα: ${item.issue}\nΑρχή: ${item.principle}\nΚρίση: ${item.holding}`, a(item.evidence), index));
  const outcome = o(o(record.outcome).overallOutcome); if (outcome.status === "available") add("outcome.overallOutcome", "outcome.overallOutcome", t(outcome.value), a(outcome.evidence));
  const disposition = o(o(record.outcome).dispositionText); if (disposition.status === "available") add("outcome.dispositionText", "outcome.dispositionText", t(disposition.value), a(disposition.evidence));
  return { claims, meta };
}
function applyChecks(record: R, checks: R[], meta: Map<string, R>, blockers: R[]): void {
  const byId = new Map(checks.map((check) => [String(check.id), check])); const rejected = new Map<string, Set<number>>();
  for (const [id, item] of meta) {
    const check = o(byId.get(id)); const verdict = t(check.verdict) || "review"; if (verdict === "accept") continue;
    blockers.push({ code: verdict === "reject" ? "FINAL_VERIFIER_REJECTED" : "FINAL_VERIFIER_REVIEW", path: id, message: t(check.reason), required: true });
    if (item.index === undefined) {
      const parts = String(item.path).split("."); let current = record; for (const key of parts.slice(0, -1)) { current[key] = o(current[key]); current = current[key]; }
      current[parts.at(-1)!] = { ...o(current[parts.at(-1)!]), status: "review", confidence: 0 };
    } else {
      const set = rejected.get(item.path) || new Set<number>(); set.add(item.index); rejected.set(item.path, set);
    }
  }
  for (const [path, indexes] of rejected) {
    const parts = path.split("."); let current = record; for (const key of parts.slice(0, -1)) { current[key] = o(current[key]); current = current[key]; }
    const field = o(current[parts.at(-1)!]); const values = a(field.value).filter((_item, index) => !indexes.has(index)); current[parts.at(-1)!] = { ...field, status: values.length ? "available" : "review", value: values, confidence: values.length ? field.confidence : 0 };
  }
}
function available(record: R, path: string): boolean { const field = path.split(".").reduce((value: any, key) => o(value)[key], record); return o(field).status === "available" && meaningful(o(field).value); }
function cleanBlockers(blockers: R[]): R[] {
  const paths = ["identity.judicialComposition","facts.materialFacts","analysis.legalIssues","outcome.overallOutcome","outcome.dispositionText"];
  return blockers.filter((blocker) => !paths.some((path) => String(blocker.path || "").startsWith(path)) && !["CORE_REQUIRED_FIELD_MISSING","FIELD_NOT_GROUNDED","ITEM_NOT_GROUNDED","VERIFIER_REJECTED","VERIFIER_REVIEW","REFINER_VERIFIER_REJECTED","REFINER_VERIFIER_REVIEW"].includes(String(blocker.code || "")));
}

async function finalize(runId: string): Promise<R> {
  const { data: run, error } = await db.schema("nomologies").from("core_v3_runs").select("*").eq("id", runId).single(); if (error) throw new Error(`RUN_READ_FAILED:${error.message}`);
  const source = await download(run.source_artifact_path); const rawAgents = await download(run.agents_artifact_path); const record = structuredClone(o(run.candidate_record));
  record.identity = { ...o(record.identity), judicialComposition: parsePanel(source) };
  record.facts = { ...o(record.facts), materialFacts: groundFacts(record, rawAgents, source) };
  record.analysis = { ...o(record.analysis), legalIssues: groundIssues(record, rawAgents, source) };
  fixOutcome(record);

  const blockers = cleanBlockers(a(run.blockers)); const claimSet = verificationClaims(record, source);
  const verification = await createStructuredResponse({ stage: "core-v3-final-attribution", schemaName: "core_v3_final_attribution", schema: verifySchema, system: VERIFY_PROMPT, user: JSON.stringify({ contract: "elite-core-v3-final-attribution", claims: claimSet.claims }), effort: "low", model: MODEL, timeoutMs: 120000 });
  applyChecks(record, a(o(verification.data).checks), claimSet.meta, blockers);
  const required = ["identity.caseName","identity.caseNumber","identity.court","identity.decisionDate","identity.caseFamily","identity.judicialComposition","facts.materialFacts","analysis.legalIssues","outcome.overallOutcome","outcome.dispositionText"];
  for (const path of required) if (!available(record, path)) blockers.push({ code: "CORE_REQUIRED_FIELD_MISSING", path, required: true });
  const coreStatus = blockers.some((blocker) => blocker.required === true) ? "review" : "pass";
  record.schemaVersion = "elite-core-v3.5"; record.coreStatus = coreStatus; record.blockers = blockers; record.finalizedAt = now(); record.model = MODEL;
  const path = await upload(`core-v3/runs/${runId}/record-final.json`, record);
  const metrics = { ...o(run.metrics), finalization: { at: now(), schemaVersion: "elite-core-v3.5", verifier: { model: verification.model, responseId: verification.responseId, elapsedMs: verification.elapsedMs, usage: verification.usage, overallComment: o(verification.data).overallComment } }, finalV35: { judges: a(o(o(record.identity).judicialComposition).value).length, issues: a(o(o(record.analysis).legalIssues).value).length, obiter: a(o(o(record.analysis).obiterDicta).value).length, legislation: a(o(o(record.authorities).legislation).value).length, authorities: a(o(o(record.authorities).authorities).value).length, orders: a(o(o(record.outcome).orders).value).length, monetary: a(o(o(record.outcome).monetary).value).length, factsLength: t(o(o(record.facts).materialFacts).value?.summary).length } };
  const { error: updateError } = await db.schema("nomologies").from("core_v3_runs").update({ candidate_record: record, core_status: coreStatus, blockers, metrics, record_artifact_path: path, updated_at: now() }).eq("id", runId); if (updateError) throw new Error(`RUN_UPDATE_FAILED:${updateError.message}`);
  return { runId, coreStatus, blockers: blockers.length, recordPath: path, metrics };
}

Deno.serve(async (req: Request) => {
  if (!authorized(req)) return json({ ok: false, code: "UNAUTHORIZED" }, 401);
  try { const payload = o(await req.json().catch(() => ({}))); const runId = t(payload.runId); if (!/^[0-9a-f-]{36}$/i.test(runId)) return json({ ok: false, code: "RUN_ID_REQUIRED" }, 400); return json({ ok: true, ...await finalize(runId) }); }
  catch (error) { console.error(error); return json({ ok: false, code: "FINALIZER_ERROR", message: error instanceof Error ? error.message : String(error) }, 500); }
});
