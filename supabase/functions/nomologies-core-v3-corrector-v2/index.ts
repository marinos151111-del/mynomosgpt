import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const BUCKET = "nomologies-artifacts";
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

type Row = Record<string, any>;
type Evidence = { paragraphIds: string[]; quote: string };
type Ref = { display: string; article: string; index: number };

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

function sourceMaps(source: Row): { paragraphs: Row[]; byId: Map<string, Row>; ordinal: Map<string, number> } {
  const paragraphs = array(source.paragraphs);
  return {
    paragraphs,
    byId: new Map(paragraphs.map((paragraph: Row) => [String(paragraph.id), paragraph])),
    ordinal: new Map(paragraphs.map((paragraph: Row) => [String(paragraph.id), Number(paragraph.ordinal || 0)])),
  };
}
function exactEvidence(raw: unknown, source: Row): Evidence[] {
  const { byId, ordinal } = sourceMaps(source);
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

function operativeRows(record: Row, source: Row): Row[] {
  const { paragraphs, ordinal } = sourceMaps(source);
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const row = object(value);
    for (const rawAnchor of array(row.evidence)) {
      for (const paragraphId of array(object(rawAnchor).paragraphIds).map(String)) ids.add(paragraphId);
    }
    Object.values(row).forEach(visit);
  };
  visit(object(record.outcome));
  const selected = new Set<number>();
  for (const paragraphId of ids) {
    const index = (ordinal.get(paragraphId) || 1) - 1;
    for (let offset = -2; offset <= 2; offset += 1) {
      const candidate = index + offset;
      if (candidate >= 0 && candidate < paragraphs.length) selected.add(candidate);
    }
  }
  if (!selected.size) {
    for (let index = Math.max(0, paragraphs.length - 50); index < paragraphs.length; index += 1) selected.add(index);
  }
  return [...selected].sort((left, right) => left - right).map((index) => paragraphs[index]).filter(Boolean);
}

function numericAmount(raw: string): string {
  return raw.replace(/\./g, "").replace(",", ".").replace(/[^0-9.]/g, "").replace(/\.$/u, "");
}
function parties(raw: string): { payee: string; payer: string } {
  const forAgainst = raw.match(/υπέρ\s+(.+?)\s+και\s+εναντίον\s+(.+?)(?=\s+(?:για\s+(?:το\s+)?ποσό|έξοδα|ποσού|ύψους|€|ως\s+θα)|[,.;]|$)/iu);
  if (forAgainst) return { payee: forAgainst[1].trim(), payer: forAgainst[2].trim() };
  const burden = raw.match(/(?:θα\s+επιβαρυνθεί|επιβαρύνουν)\s+(?:η\s+πλευρά\s+)?((?:των|του|της)\s+[^,.;]+?)(?=\s+ως\s+θα|[,.;]|$)/iu);
  return burden ? { payee: "", payer: burden[1].trim() } : { payee: "", payer: "" };
}
function partiesNear(rows: Row[], wantedAmount: string): { payee: string; payer: string } {
  for (const row of rows) {
    const raw = String(row.text || "");
    if (wantedAmount && ![...raw.matchAll(/€\s*([\d.,]+)/gu)].some((match) => numericAmount(match[1]) === wantedAmount)) continue;
    const result = parties(raw);
    if (result.payee || result.payer) return result;
  }
  for (const row of rows) {
    const result = parties(String(row.text || ""));
    if (result.payee || result.payer) return result;
  }
  return { payee: "", payer: "" };
}
function costAmount(raw: string, costIndex: number): string {
  const after = raw.slice(costIndex);
  const afterAmount = after.match(/€\s*([\d.,]+)/u)?.[1] || "";
  if (afterAmount) return numericAmount(afterAmount);

  const before = raw.slice(0, costIndex);
  const matches = [...before.matchAll(/€\s*([\d.,]+)/gu)];
  const last = matches.at(-1);
  if (!last || last.index === undefined) return "";
  const between = before.slice(last.index + last[0].length);
  if (/πλέον|plus|αποζημί|compensation|damages/iu.test(between)) return "";
  if (normalize(between).length > 20) return "";
  return numericAmount(last[1]);
}
function rebuildMoney(record: Row, source: Row): Row {
  const rows = operativeRows(record, source);
  const values: Row[] = [];

  for (const paragraph of rows) {
    const raw = String(paragraph.text || "");
    const folded = fold(raw);
    const evidence: Evidence[] = [{ paragraphIds: [String(paragraph.id)], quote: raw }];

    if (/(?:δίκαιη\s+)?αποζημίωσ|compensation|damages/iu.test(raw)) {
      for (const match of raw.matchAll(/€\s*([\d.,]+)/gu)) {
        const amount = numericAmount(match[1]);
        if (!amount) continue;
        const party = partiesNear(rows, amount);
        values.push({
          type: /damages/iu.test(raw) ? "damages" : "compensation",
          stage: "not_applicable",
          amount,
          currency: "EUR",
          fixed: true,
          status: "fixed",
          payer: party.payer,
          payee: party.payee,
          interest: "",
          evidence,
        });
      }
    }

    const greekIndex = folded.lastIndexOf("εξοδα");
    const englishIndex = folded.lastIndexOf("costs");
    const costIndex = Math.max(greekIndex, englishIndex);
    if (costIndex >= 0) {
      const amount = costAmount(raw, costIndex);
      const clause = raw.slice(costIndex);
      const assessed = /υπολογισ|Πρωτοκολλητ|to\s+be\s+assessed/iu.test(clause);
      const open = /στο\s+αποτέλεσμα|costs\s+in\s+the\s+cause/iu.test(clause);
      const party = parties(raw);
      const stage = /πρωτόδικ|first[-\s]?instance/iu.test(clause)
        ? "first_instance"
        : /έφεσ|αντέφεσ|appeal/iu.test(clause)
        ? "appeal"
        : "other";
      values.push({
        type: "costs",
        stage,
        amount,
        currency: amount ? "EUR" : "",
        fixed: Boolean(amount),
        status: amount ? "fixed" : assessed ? "to_be_assessed" : open ? "open" : "not_stated",
        payer: party.payer,
        payee: party.payee,
        interest: "",
        evidence,
      });
    }
  }

  for (const item of array(object(object(record.outcome).monetary).value)) {
    if (item.type === "costs") continue;
    const evidence = exactEvidence(item.evidence, source);
    if (!evidence.length) continue;
    values.push({ ...item, amount: numericAmount(text(item.amount)), evidence });
  }

  const deduped = new Map<string, Row>();
  for (const item of values) {
    const key = [item.type, item.stage, item.amount, fold(item.payer || ""), fold(item.payee || ""), array(item.evidence)[0]?.paragraphIds?.join(",") || ""].join("|");
    deduped.set(key, item);
  }
  const output = [...deduped.values()];
  return { status: output.length ? "available" : "not_found", value: output, confidence: output.length ? 0.99 : 1 };
}

const STOP = new Set([
  "του", "της", "των", "περι", "νομος", "νομου", "κανονισμος", "κανονισμων", "κανονισμοι",
  "law", "rules", "rule", "part", "civil", "procedure", "the", "of", "and", "chapter", "cap", "κεφ",
]);
function tokens(value: string): string[] {
  return fold(value).replace(/[^a-zα-ω0-9]+/gu, " ").split(/\s+/u).filter(Boolean);
}
function instrumentPositions(raw: string, instrument: Row): number[] {
  const folded = fold(raw);
  const positions: number[] = [];
  const lawId = tokens(text(instrument.lawId)).join(" ");
  if (lawId) {
    const index = folded.indexOf(lawId);
    if (index >= 0) positions.push(index);
  }
  const hints = tokens(text(instrument.name))
    .filter((token) => token.length >= 5 && !STOP.has(token))
    .sort((left, right) => right.length - left.length)
    .slice(0, 4);
  for (const hint of hints) {
    const index = folded.indexOf(hint);
    if (index >= 0) positions.push(index);
  }
  return positions;
}
function refs(raw: string): Ref[] {
  const output: Ref[] = [];
  const add = (match: RegExpExecArray, display: string, article: string): void => {
    output.push({ display, article, index: match.index });
  };
  for (const match of raw.matchAll(/άρθρ(?:ο|ου|α|ων)\s+([0-9]+(?:\([^)]+\))*(?:\s+και\s+\([^)]+\))?)/giu)) add(match, `άρθρο ${match[1]}`, match[1]);
  for (const match of raw.matchAll(/\bArticle\s+([0-9]+(?:\([^)]+\))*)/giu)) add(match, `Article ${match[1]}`, match[1]);
  for (const match of raw.matchAll(/Κανονισμ(?:ός|ού|ο|ων)?\s+([0-9]+(?:\([^)]+\))*)/giu)) add(match, `Κανονισμός ${match[1]}`, match[1]);
  for (const match of raw.matchAll(/\bRule\s+([0-9]+(?:\.[0-9]+)*(?:\([^)]+\))*)/giu)) add(match, `Rule ${match[1]}`, match[1]);
  return output;
}
function explicitOwnership(raw: string, instrument: Row, ref: Ref): boolean {
  const positions = instrumentPositions(raw, instrument);
  if (!positions.length) return false;
  const folded = fold(raw);
  for (const position of positions) {
    if (ref.index >= position) continue;
    const between = folded.slice(ref.index + fold(ref.display).length, position);
    if (between.length <= 260 && /(?:^|\s)(?:του|της|των|of)(?:\s|$)/u.test(between)) return true;
  }
  return false;
}
function provisionKey(provision: Row): string {
  return fold(`${text(provision.display)}|${text(provision.article)}`);
}
function application(raw: string): "applied" | "interpreted" | "considered" | "mentioned" {
  if (/ερμηνεύ|interpret/iu.test(raw)) return "interpreted";
  if (/δυνάμει|εφαρμόζ|στη\s+βάση|βάσει|pursuant/iu.test(raw)) return "applied";
  if (/εξετάζ|λαμβάν|consider/iu.test(raw)) return "considered";
  return "mentioned";
}
function rebuildLegislation(agents: Row, source: Row): Row {
  const rawField = object(object(object(agents.raw).authorities).legislation);
  if (rawField.status !== "available") return { status: "not_found", value: [], confidence: 1 };
  const paragraphs = array(source.paragraphs);
  const instruments: Row[] = [];

  for (const rawInstrument of array(rawField.value)) {
    const instrument = structuredClone(object(rawInstrument));
    const provisionMap = new Map<string, Row>();

    for (const rawProvision of array(instrument.provisions)) {
      const provision = structuredClone(object(rawProvision));
      const evidence = exactEvidence(provision.evidence, source);
      if (evidence.length) provisionMap.set(provisionKey(provision), { ...provision, evidence });
    }

    for (const paragraph of paragraphs) {
      const raw = String(paragraph.text || "");
      for (const ref of refs(raw)) {
        if (!explicitOwnership(raw, instrument, ref)) continue;
        const evidence: Evidence = { paragraphIds: [String(paragraph.id)], quote: raw };
        const existing = [...provisionMap.entries()].find(([key, provision]) => key.includes(fold(ref.article)) || fold(text(provision.article)) === fold(ref.article));
        if (existing) {
          const provision = existing[1];
          provisionMap.set(existing[0], {
            ...provision,
            evidence: [...new Map([...array(provision.evidence), evidence].map((anchor: Evidence) => [`${anchor.paragraphIds.join(",")}|${normalize(anchor.quote)}`, anchor])).values()],
          });
        } else {
          provisionMap.set(fold(`${ref.display}|${ref.article}`), {
            display: ref.display,
            article: ref.article,
            application: application(raw),
            evidence: [evidence],
          });
        }
      }
    }

    const provisions = [...provisionMap.values()];
    if (!provisions.length) continue;
    const evidence = [...new Map([
      ...exactEvidence(instrument.evidence, source),
      ...provisions.flatMap((provision) => array(provision.evidence)),
    ].map((anchor: Evidence) => [`${anchor.paragraphIds.join(",")}|${normalize(anchor.quote)}`, anchor])).values()];
    instruments.push({ ...instrument, provisions, evidence });
  }

  const output = new Map<string, Row>();
  for (const instrument of instruments) {
    const key = fold(`${text(instrument.lawId)}|${text(instrument.name)}`);
    const prior = output.get(key);
    if (!prior) { output.set(key, instrument); continue; }
    const provisions = new Map([...array(prior.provisions), ...array(instrument.provisions)].map((provision) => [provisionKey(provision), provision]));
    output.set(key, { ...prior, provisions: [...provisions.values()], evidence: [...array(prior.evidence), ...array(instrument.evidence)] });
  }
  const values = [...output.values()];
  return { status: values.length ? "available" : "review", value: values, confidence: values.length ? 0.99 : 0 };
}

function cleanFacts(field: Row): Row {
  if (field.status !== "available") return field;
  const value = object(field.value);
  const summary = text(value.summary);
  const filtered = summary.split(/(?<=[.!;··])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .filter((sentence) => !/^(?:το\s+)?(?:ανωτατο\s+)?(?:δικαστηριο|εφετειο)\s+(?:εξετασε|εκρινε|κατεληξε|απερριψε|δεχθηκε)/u.test(fold(sentence)));
  return { ...field, value: { ...value, summary: filtered.join(" ").trim() || summary } };
}
function weight(record: Row): "Υψηλή" | "Μέση" | "Χαμηλή" {
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
  const agents = await download(run.agents_artifact_path);
  const record = structuredClone(object(run.candidate_record));

  record.facts = { ...object(record.facts), materialFacts: cleanFacts(object(object(record.facts).materialFacts)) };
  record.outcome = { ...object(record.outcome), monetary: rebuildMoney(record, source) };
  record.authorities = { ...object(record.authorities), legislation: rebuildLegislation(agents, source) };
  record.header = {
    ...object(record.header),
    precedentialWeight: weight(record),
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
  record.schemaVersion = "elite-core-v3.9";
  record.coreStatus = coreStatus;
  record.blockers = blockers;
  record.correctedAt = now();

  const path = await upload(`core-v3/runs/${runId}/record-corrected-v2.json`, record);
  const metrics = {
    ...object(run.metrics),
    correctionV2: { at: now(), schemaVersion: "elite-core-v3.9" },
    correctedV2: {
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
