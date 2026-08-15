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
const meaningful = (value: unknown): boolean => typeof value === "string" ? !!value.trim() : Array.isArray(value) ? value.length > 0 : !!value && typeof value === "object" && Object.keys(value as Row).length > 0;
const now = (): string => new Date().toISOString();
const normalize = (value: string): string => String(value || "")
  .normalize("NFC")
  .replace(/[\u00ad\u200b]/g, "")
  .replace(/[\u00a0\u2007\u202f]/g, " ")
  .replace(/[’‘`´]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/[‐‑‒–—―]/g, "-")
  .replace(/\s+/gu, " ")
  .trim();
const fold = (value: string): string => normalize(value)
  .toLocaleLowerCase("el")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/ς/g, "σ");

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
function authorized(req: Request): boolean {
  return SERVICE_KEY !== "" && (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") === SERVICE_KEY;
}
async function download(path: string): Promise<any> {
  const { data, error } = await db.storage.from(BUCKET).download(path);
  if (error || !data) throw new Error(`ARTIFACT_DOWNLOAD_FAILED:${error?.message || path}`);
  return JSON.parse(await data.text());
}
async function upload(path: string, value: unknown): Promise<string> {
  const { error } = await db.storage.from(BUCKET).upload(
    path,
    new TextEncoder().encode(JSON.stringify(value)),
    { contentType: "application/json", upsert: true },
  );
  if (error) throw new Error(`ARTIFACT_UPLOAD_FAILED:${error.message}`);
  return path;
}

function paragraphMaps(source: Row): { paragraphs: Row[]; byId: Map<string, Row>; ordinal: Map<string, number> } {
  const paragraphs = array(source.paragraphs);
  return {
    paragraphs,
    byId: new Map(paragraphs.map((paragraph: Row) => [String(paragraph.id), paragraph])),
    ordinal: new Map(paragraphs.map((paragraph: Row) => [String(paragraph.id), Number(paragraph.ordinal || 0)])),
  };
}
function exactEvidence(raw: unknown, source: Row): Evidence[] {
  const { byId, ordinal } = paragraphMaps(source);
  const valid: Evidence[] = [];
  for (const rawAnchor of array(raw)) {
    const anchor = object(rawAnchor);
    const paragraphIds = array(anchor.paragraphIds).map(String).filter(Boolean);
    const quote = text(anchor.quote);
    if (!paragraphIds.length || !quote) continue;
    const rows = paragraphIds.map((id) => byId.get(id));
    const ordinals = paragraphIds.map((id) => ordinal.get(id) || 0).sort((left, right) => left - right);
    const contiguous = rows.every(Boolean) && !ordinals.some((value, index) => index > 0 && value !== ordinals[index - 1] + 1);
    if (contiguous && normalize(rows.map((row) => String(row?.text || "")).join(" ")).includes(normalize(quote))) {
      valid.push({ paragraphIds, quote });
    }
  }
  return [...new Map(valid.map((anchor) => [`${anchor.paragraphIds.join(",")}|${normalize(anchor.quote)}`, anchor])).values()];
}

function operativeParagraphs(record: Row, source: Row): Row[] {
  const { paragraphs, byId, ordinal } = paragraphMaps(source);
  const ids = new Set<string>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(collect); return; }
    const row = object(value);
    for (const rawAnchor of array(row.evidence)) {
      for (const id of array(object(rawAnchor).paragraphIds).map(String)) ids.add(id);
    }
    Object.values(row).forEach(collect);
  };
  collect(object(record.outcome));
  const indexes = [...ids].map((id) => (ordinal.get(id) || 1) - 1).filter((index) => index >= 0);
  const selected = new Set<number>();
  for (const index of indexes) {
    for (let offset = -2; offset <= 2; offset += 1) {
      const candidate = index + offset;
      if (candidate >= 0 && candidate < paragraphs.length) selected.add(candidate);
    }
  }
  if (!selected.size) {
    for (let index = Math.max(0, paragraphs.length - 50); index < paragraphs.length; index += 1) selected.add(index);
  }
  return [...selected]
    .sort((left, right) => left - right)
    .map((index) => paragraphs[index])
    .filter(Boolean)
    .filter((paragraph) => byId.has(String(paragraph.id)));
}

function amount(raw: string): string {
  return raw.replace(/\./g, "").replace(",", ".").replace(/[^0-9.]/g, "").replace(/\.$/u, "");
}
function extractParties(raw: string): { payee: string; payer: string } {
  const match = raw.match(/υπέρ\s+(.+?)\s+και\s+εναντίον\s+(.+?)(?=\s+(?:για\s+(?:το\s+)?ποσό|έξοδα|ποσού|ύψους|€|ως\s+θα)|[,.;]|$)/iu);
  if (!match) return { payee: "", payer: "" };
  return { payee: match[1].trim(), payer: match[2].trim() };
}
function nearbyParties(rows: Row[], wantedAmount: string): { payee: string; payer: string } {
  for (const row of rows) {
    const raw = String(row.text || "");
    if (wantedAmount && !amount(raw.match(/€\s*([\d.,]+)/u)?.[1] || "").includes(wantedAmount)) continue;
    const parties = extractParties(raw);
    if (parties.payee || parties.payer) return parties;
  }
  for (const row of rows) {
    const parties = extractParties(String(row.text || ""));
    if (parties.payee || parties.payer) return parties;
  }
  return { payee: "", payer: "" };
}
function rebuildMonetary(record: Row, source: Row): Row {
  const rows = operativeParagraphs(record, source);
  const values: Row[] = [];

  for (const paragraph of rows) {
    const raw = String(paragraph.text || "");
    const evidence: Evidence[] = [{ paragraphIds: [String(paragraph.id)], quote: raw }];
    const euroMatches = [...raw.matchAll(/€\s*([\d.,]+)/gu)];

    if (/(?:δίκαιη\s+)?αποζημίωσ|compensation|damages/iu.test(raw)) {
      for (const match of euroMatches) {
        const numeric = amount(match[1]);
        if (!numeric) continue;
        const parties = nearbyParties(rows, numeric);
        values.push({
          type: /damages/iu.test(raw) ? "damages" : "compensation",
          stage: "not_applicable",
          amount: numeric,
          currency: "EUR",
          fixed: true,
          status: "fixed",
          payer: parties.payer,
          payee: parties.payee,
          interest: "",
          evidence,
        });
      }
    }

    const costsIndex = fold(raw).indexOf("εξοδα");
    if (costsIndex >= 0 || /\bcosts\b/iu.test(raw)) {
      const costClause = costsIndex >= 0 ? raw.slice(costsIndex) : raw;
      const costAmountRaw = costClause.match(/€\s*([\d.,]+)/u)?.[1] || "";
      const numeric = amount(costAmountRaw);
      const assessed = /υπολογισ|Πρωτοκολλητ|to\s+be\s+assessed/iu.test(costClause);
      const parties = extractParties(raw);
      const stage = /πρωτόδικ|first[-\s]?instance/iu.test(costClause)
        ? "first_instance"
        : /έφεσ|αντέφεσ|appeal/iu.test(costClause)
        ? "appeal"
        : "other";
      values.push({
        type: "costs",
        stage,
        amount: numeric,
        currency: numeric ? "EUR" : "",
        fixed: Boolean(numeric),
        status: numeric ? "fixed" : assessed ? "to_be_assessed" : "not_stated",
        payer: parties.payer,
        payee: parties.payee,
        interest: "",
        evidence,
      });
    }
  }

  for (const item of array(object(object(record.outcome).monetary).value)) {
    const evidence = exactEvidence(item.evidence, source);
    if (!evidence.length) continue;
    if (item.type === "costs") continue;
    values.push({ ...item, amount: amount(text(item.amount)), evidence });
  }

  const deduped = new Map<string, Row>();
  for (const item of values) {
    const key = [item.type, item.stage, item.amount, fold(item.payer || ""), fold(item.payee || "")].join("|");
    const prior = deduped.get(key);
    if (!prior) { deduped.set(key, item); continue; }
    const priorEvidence = array(prior.evidence);
    deduped.set(key, {
      ...prior,
      evidence: [...new Map([...priorEvidence, ...array(item.evidence)].map((anchor: Evidence) => [`${anchor.paragraphIds.join(",")}|${normalize(anchor.quote)}`, anchor])).values()],
      status: prior.status === "not_stated" && item.status === "to_be_assessed" ? "to_be_assessed" : prior.status,
    });
  }
  const output = [...deduped.values()];
  return { status: output.length ? "available" : "not_found", value: output, confidence: output.length ? 0.99 : 1 };
}

const INSTRUMENT_STOP = new Set([
  "του", "της", "των", "περι", "νομος", "νομου", "κανονισμος", "κανονισμων", "κανονισμοι",
  "law", "rules", "rule", "part", "civil", "procedure", "the", "of", "and", "chapter", "cap", "κεφ",
]);
function tokens(value: string): string[] {
  return fold(value).replace(/[^a-zα-ω0-9]+/gu, " ").split(/\s+/u).filter(Boolean);
}
function instrumentMatch(paragraph: string, instrument: Row): boolean {
  const folded = fold(paragraph);
  const lawIdPhrase = tokens(text(instrument.lawId)).join(" ");
  if (lawIdPhrase && folded.includes(lawIdPhrase)) return true;
  const hints = tokens(text(instrument.name))
    .filter((token) => token.length >= 5 && !INSTRUMENT_STOP.has(token))
    .sort((left, right) => right.length - left.length)
    .slice(0, 4);
  if (!hints.length) return false;
  return hints.filter((hint) => folded.includes(hint)).length >= Math.min(2, hints.length);
}
function articleRefs(raw: string): Array<{ display: string; article: string }> {
  const refs: Array<{ display: string; article: string }> = [];
  for (const match of raw.matchAll(/άρθρ(?:ο|ου|α|ων)\s+([0-9]+(?:\([^)]+\))*(?:\s+και\s+\([^)]+\))?)/giu)) {
    refs.push({ display: `άρθρο ${match[1]}`, article: match[1] });
  }
  for (const match of raw.matchAll(/\bArticle\s+([0-9]+(?:\([^)]+\))*)/giu)) {
    refs.push({ display: `Article ${match[1]}`, article: match[1] });
  }
  for (const match of raw.matchAll(/Κανονισμ(?:ός|ού|ο|ων)?\s+([0-9]+(?:\([^)]+\))*)/giu)) {
    refs.push({ display: `Κανονισμός ${match[1]}`, article: match[1] });
  }
  for (const match of raw.matchAll(/\bRule\s+([0-9]+(?:\.[0-9]+)*(?:\([^)]+\))*)/giu)) {
    refs.push({ display: `Rule ${match[1]}`, article: match[1] });
  }
  for (const match of raw.matchAll(/Δ\.?\s*([0-9]+)\s*,\s*Κ\.?\s*([0-9]+)/giu)) {
    refs.push({ display: `Δ.${match[1]}, Κ.${match[2]}`, article: `Δ.${match[1]}, Κ.${match[2]}` });
  }
  return [...new Map(refs.map((ref) => [fold(`${ref.display}|${ref.article}`), ref])).values()];
}
function application(raw: string): "applied" | "interpreted" | "considered" | "mentioned" {
  if (/ερμηνεύ|interpret/iu.test(raw)) return "interpreted";
  if (/δυνάμει|εφαρμόζ|στη\s+βάση|βάσει|pursuant/iu.test(raw)) return "applied";
  if (/εξετάζ|λαμβάν|consider/iu.test(raw)) return "considered";
  return "mentioned";
}
function augmentLegislation(record: Row, source: Row): Row {
  const paragraphs = array(source.paragraphs);
  const currentField = object(object(record.authorities).legislation);
  const instruments: Row[] = array(currentField.value).map((item) => structuredClone(object(item)));

  for (const instrument of instruments) {
    const provisionMap = new Map<string, Row>();
    for (const provision of array(instrument.provisions)) {
      provisionMap.set(fold(`${provision.display}|${provision.article}`), provision);
    }
    const instrumentEvidence = array(instrument.evidence);
    for (const paragraph of paragraphs) {
      const raw = String(paragraph.text || "");
      if (!instrumentMatch(raw, instrument)) continue;
      const refs = articleRefs(raw);
      if (!refs.length) continue;
      const evidence: Evidence = { paragraphIds: [String(paragraph.id)], quote: raw };
      instrumentEvidence.push(evidence);
      for (const ref of refs) {
        const key = fold(`${ref.display}|${ref.article}`);
        const existing = [...provisionMap.entries()].find(([existingKey]) => existingKey.includes(fold(ref.article)) || key.includes(existingKey.split("|").at(-1) || ""));
        if (existing) {
          const provision = existing[1];
          provisionMap.set(existing[0], {
            ...provision,
            evidence: [...new Map([...array(provision.evidence), evidence].map((anchor: Evidence) => [`${anchor.paragraphIds.join(",")}|${normalize(anchor.quote)}`, anchor])).values()],
          });
          continue;
        }
        provisionMap.set(key, {
          display: ref.display,
          article: ref.article,
          application: application(raw),
          evidence: [evidence],
        });
      }
    }
    instrument.provisions = [...provisionMap.values()];
    instrument.evidence = [...new Map(instrumentEvidence.map((anchor: Evidence) => [`${anchor.paragraphIds.join(",")}|${normalize(anchor.quote)}`, anchor])).values()];
  }

  const output = instruments.filter((instrument) => array(instrument.provisions).length > 0);
  return { status: output.length ? "available" : currentField.status || "not_found", value: output, confidence: output.length ? 0.99 : Number(currentField.confidence || 0) };
}

function cleanFacts(field: Row): Row {
  if (field.status !== "available") return field;
  const value = object(field.value);
  const summary = text(value.summary);
  const sentences = summary.split(/(?<=[.!;··])\s+/u).map((sentence) => sentence.trim()).filter(Boolean);
  const filtered = sentences.filter((sentence) => {
    const folded = fold(sentence);
    return !/^(?:το\s+)?(?:ανωτατο\s+)?(?:δικαστηριο|εφετειο)\s+(?:εξετασε|εκρινε|κατεληξε|απερριψε|δεχθηκε)/u.test(folded);
  });
  return { ...field, value: { ...value, summary: filtered.join(" ").trim() || summary } };
}
function precedentialWeight(record: Row): "Υψηλή" | "Μέση" | "Χαμηλή" {
  const court = fold(text(object(object(record.identity).court).value));
  const issues = array(object(object(record.analysis).legalIssues).value);
  const outcome = text(object(object(record.outcome).overallOutcome).value);
  const senior = /ανωτατο|εφετειο|supreme|court of appeal/u.test(court);
  const proceduralApplication = /application_/.test(outcome);
  if (senior && issues.length && !proceduralApplication) return "Υψηλή";
  if (senior || issues.length) return "Μέση";
  return "Χαμηλή";
}
function primaryLegislation(field: Row): string[] {
  return array(field.value)
    .filter((instrument) => instrument.role !== "background" && array(instrument.provisions).some((provision) => ["applied", "interpreted", "considered"].includes(provision.application)))
    .slice(0, 5)
    .map((instrument) => `${instrument.name}${instrument.lawId ? ` (${instrument.lawId})` : ""} — ${array(instrument.provisions).map((provision) => provision.display).join(", ")}`);
}
function available(record: Row, path: string): boolean {
  const field = path.split(".").reduce((value: any, key) => object(value)[key], record);
  return object(field).status === "available" && meaningful(object(field).value);
}

async function correct(runId: string): Promise<Row> {
  const { data: run, error } = await db.schema("nomologies").from("core_v3_runs").select("*").eq("id", runId).single();
  if (error) throw new Error(`RUN_READ_FAILED:${error.message}`);
  const source = await download(run.source_artifact_path);
  const record = structuredClone(object(run.candidate_record));

  record.facts = { ...object(record.facts), materialFacts: cleanFacts(object(object(record.facts).materialFacts)) };
  record.outcome = { ...object(record.outcome), monetary: rebuildMonetary(record, source) };
  record.authorities = { ...object(record.authorities), legislation: augmentLegislation(record, source) };
  record.header = {
    ...object(record.header),
    precedentialWeight: precedentialWeight(record),
    primaryLegislation: primaryLegislation(object(record.authorities.legislation)),
  };

  let blockers = array(run.blockers).filter((blocker) => !["outcome.monetary", "authorities.legislation", "facts.materialFacts"].some((path) => String(blocker.path || "").startsWith(path)));
  const required = [
    "identity.caseName", "identity.caseNumber", "identity.court", "identity.decisionDate", "identity.caseFamily",
    "identity.judicialComposition", "facts.materialFacts", "analysis.legalIssues", "outcome.overallOutcome", "outcome.dispositionText",
  ];
  for (const path of required) {
    if (!available(record, path) && !blockers.some((blocker) => blocker.code === "CORE_REQUIRED_FIELD_MISSING" && blocker.path === path)) {
      blockers.push({ code: "CORE_REQUIRED_FIELD_MISSING", path, required: true });
    }
  }
  if (/άρθρ|κανονισμ|νόμ|κεφ\.|\brule\b|\barticle\b/iu.test(String(source.cleanText || "")) && !available(record, "authorities.legislation")) {
    blockers.push({ code: "CORE_LEGISLATION_COVERAGE_FAILED", path: "authorities.legislation", required: true });
  }
  const coreStatus = blockers.some((blocker) => blocker.required === true) ? "review" : "pass";
  record.schemaVersion = "elite-core-v3.8";
  record.coreStatus = coreStatus;
  record.blockers = blockers;
  record.correctedAt = now();

  const path = await upload(`core-v3/runs/${runId}/record-corrected.json`, record);
  const metrics = {
    ...object(run.metrics),
    correction: { at: now(), schemaVersion: "elite-core-v3.8" },
    corrected: {
      judges: array(object(object(record.identity).judicialComposition).value).length,
      issues: array(object(object(record.analysis).legalIssues).value).length,
      obiter: array(object(object(record.analysis).obiterDicta).value).length,
      legislation: array(object(object(record.authorities).legislation).value).length,
      authorities: array(object(object(record.authorities).authorities).value).length,
      orders: array(object(object(record.outcome).orders).value).length,
      monetary: array(object(object(record.outcome).monetary).value).length,
      factsLength: text(object(object(record.facts).materialFacts).value?.summary).length,
    },
  };
  const { error: updateError } = await db.schema("nomologies").from("core_v3_runs").update({
    candidate_record: record,
    core_status: coreStatus,
    blockers,
    metrics,
    record_artifact_path: path,
    updated_at: now(),
  }).eq("id", runId);
  if (updateError) throw new Error(`RUN_UPDATE_FAILED:${updateError.message}`);
  return { runId, coreStatus, blockers: blockers.length, recordPath: path, metrics };
}

Deno.serve(async (req: Request) => {
  if (!authorized(req)) return json({ ok: false, code: "UNAUTHORIZED" }, 401);
  try {
    const payload = object(await req.json().catch(() => ({})));
    const runId = text(payload.runId);
    if (!/^[0-9a-f-]{36}$/i.test(runId)) return json({ ok: false, code: "RUN_ID_REQUIRED" }, 400);
    return json({ ok: true, ...await correct(runId) });
  } catch (error) {
    console.error(error);
    return json({ ok: false, code: "CORRECTOR_ERROR", message: error instanceof Error ? error.message : String(error) }, 500);
  }
});
