import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const BUCKET = "nomologies-artifacts";
const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, any>;
type CoreEvidence = { paragraphIds: string[]; quote: string };
type CanonicalEvidence = CoreEvidence & {
  id: string;
  sectionType: string;
  speakerRole: string;
  supports: string[];
  exactMatch: boolean;
};

const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const array = (value: unknown): any[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const now = (): string => new Date().toISOString();
const meaningful = (value: unknown): boolean => {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value && typeof value === "object" && Object.keys(value as Row).length > 0);
};
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
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
function safeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a[index] ^ b[index];
  return mismatch === 0;
}
function authorized(req: Request): boolean {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return Boolean(SERVICE_KEY && safeEqual(bearer, SERVICE_KEY));
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

function unavailable<T>(fallback: T): Row {
  return { status: "unavailable", value: fallback, confidence: 0, evidence: [], conflicts: [] };
}
function indeterminate<T>(fallback: T, conflicts: string[] = []): Row {
  return { status: "indeterminate", value: fallback, confidence: 0, evidence: [], conflicts };
}
function available<T>(value: T, evidence: CanonicalEvidence[], confidence = 0.96): Row {
  return {
    status: "available",
    value,
    confidence: Math.max(0, Math.min(1, confidence)),
    evidence,
    conflicts: [],
  };
}
function coreStatus(field: Row): "available" | "unavailable" | "indeterminate" {
  if (field.status === "available" && meaningful(field.value)) return "available";
  if (field.status === "not_found") return "unavailable";
  return "indeterminate";
}

function sourceMaps(source: Row): {
  paragraphs: Row[];
  byId: Map<string, Row>;
  ordinal: Map<string, number>;
} {
  const paragraphs = array(source.paragraphs);
  return {
    paragraphs,
    byId: new Map(paragraphs.map((paragraph: Row) => [String(paragraph.id), paragraph])),
    ordinal: new Map(paragraphs.map((paragraph: Row) => [String(paragraph.id), Number(paragraph.ordinal || 0)])),
  };
}

function validSectionMap(source: Row, baseline: Row): Row {
  const { paragraphs, byId } = sourceMaps(source);
  const baselineMap = object(baseline.sectionMap);
  const spans = array(baselineMap.spans);
  if (
    spans.length &&
    spans.every((span) => byId.has(String(span.startParagraphId)) && byId.has(String(span.endParagraphId)))
  ) {
    return {
      ...baselineMap,
      version: text(baselineMap.version) || "core-v3-baseline-sections",
      paragraphCount: paragraphs.length,
      coverageComplete: true,
      overlapFree: true,
    };
  }

  const first = String(paragraphs[0]?.id || "");
  const last = String(paragraphs.at(-1)?.id || first);
  return {
    version: "elite-core-v3-live-generic-sections",
    paragraphCount: paragraphs.length,
    spans: first
      ? [{
        id: "CORE_ALL",
        startParagraphId: first,
        endParagraphId: last,
        sectionType: "other",
        speakerRole: "unknown",
        heading: "Core V3 source",
        isQuotedMaterial: false,
        quotedSourceType: "none",
        confidence: 0.5,
        boundaryEvidenceParagraphIds: [first, last],
        rationale: "Fallback span used because the prior section map did not match the refreshed source.",
      }]
      : [],
    coverageComplete: Boolean(first),
    overlapFree: true,
    reviewFlags: first ? [] : ["sectionMap:source_empty"],
  };
}

class EvidenceRegistry {
  private readonly byKey = new Map<string, CanonicalEvidence>();
  private readonly paragraphs: Row[];
  private readonly byId: Map<string, Row>;
  private readonly ordinal: Map<string, number>;
  private readonly sectionByParagraphId = new Map<string, Row>();

  constructor(source: Row, sectionMap: Row) {
    const maps = sourceMaps(source);
    this.paragraphs = maps.paragraphs;
    this.byId = maps.byId;
    this.ordinal = maps.ordinal;
    for (const span of array(sectionMap.spans)) {
      const start = this.ordinal.get(String(span.startParagraphId));
      const end = this.ordinal.get(String(span.endParagraphId));
      if (!start || !end || end < start) continue;
      for (let ordinal = start; ordinal <= end; ordinal += 1) {
        const paragraph = this.paragraphs.find((candidate) => Number(candidate.ordinal || 0) === ordinal);
        if (paragraph) this.sectionByParagraphId.set(String(paragraph.id), span);
      }
    }
  }

  register(raw: unknown, fieldPath: string): CanonicalEvidence[] {
    const output: CanonicalEvidence[] = [];
    for (const rawAnchor of array(raw)) {
      const anchor = object(rawAnchor);
      const paragraphIds = array(anchor.paragraphIds).map(String).filter(Boolean);
      const quote = text(anchor.quote);
      if (!paragraphIds.length || !quote) continue;

      const rows = paragraphIds.map((id) => this.byId.get(id));
      if (rows.some((row) => !row)) continue;
      const ordinals = paragraphIds
        .map((id) => this.ordinal.get(id) || 0)
        .sort((left, right) => left - right);
      if (ordinals.some((value, index) => index > 0 && value !== ordinals[index - 1] + 1)) continue;
      const haystack = normalize(rows.map((row) => String(row?.text || "")).join(" "));
      if (!haystack.includes(normalize(quote))) continue;

      const key = `${paragraphIds.join(",")}|${normalize(quote)}`;
      let canonical = this.byKey.get(key);
      if (!canonical) {
        const section = this.sectionByParagraphId.get(paragraphIds[0]) || {};
        canonical = {
          id: `EV_CORE_${String(this.byKey.size + 1).padStart(4, "0")}`,
          paragraphIds,
          quote,
          sectionType: text(section.sectionType) || "other",
          speakerRole: text(section.speakerRole) || "unknown",
          supports: [],
          exactMatch: true,
        };
        this.byKey.set(key, canonical);
      }
      if (!canonical.supports.includes(fieldPath)) canonical.supports.push(fieldPath);
      output.push(canonical);
    }
    return [...new Map(output.map((anchor) => [anchor.id, anchor])).values()];
  }

  values(): CanonicalEvidence[] {
    return [...this.byKey.values()].map((anchor) => ({
      ...anchor,
      supports: [...new Set(anchor.supports)].sort(),
    }));
  }
}

function coreScalar(
  field: Row,
  fallback: unknown,
  fieldPath: string,
  registry: EvidenceRegistry,
): Row {
  const status = coreStatus(field);
  if (status === "unavailable") return unavailable(fallback);
  if (status === "indeterminate") return indeterminate(fallback, ["Core V3 did not verify this field."]);
  const evidence = registry.register(field.evidence, fieldPath);
  if (!evidence.length) return indeterminate(fallback, ["Core V3 field lacks exact paragraph evidence."]);
  return available(field.value, evidence, Number(field.confidence || 0.96));
}
function itemEvidence(field: Row, fieldPath: string, registry: EvidenceRegistry): CanonicalEvidence[] {
  return [...new Map(array(field.value).flatMap((item) => registry.register(object(item).evidence, fieldPath)).map((anchor) => [anchor.id, anchor])).values()];
}
function uniqueStrings(values: unknown[]): string[] {
  const output = new Map<string, string>();
  for (const raw of values) {
    const value = text(raw);
    const key = fold(value);
    if (value && !output.has(key)) output.set(key, value);
  }
  return [...output.values()];
}

function caseFamily(value: string): string {
  const map: Record<string, string> = {
    civil: "private_law",
    criminal: "criminal_law",
    administrative: "public_law",
    constitutional: "constitutional_law",
    family: "family_law",
    employment: "employment_law",
    disciplinary: "disciplinary",
    mixed: "mixed",
    other: "unknown",
  };
  return map[value] || "unknown";
}
function outcomeCode(value: string): string {
  const map: Record<string, string> = {
    appeal_dismissed_cross_appeal_partly_allowed: "appeal_partly_allowed",
    appeal_dismissed_cross_appeal_allowed: "appeal_partly_allowed",
  };
  return map[value] || value || "unknown";
}
function courtLevel(court: string, fallback: unknown): unknown {
  if (fallback) return fallback;
  const value = fold(court);
  if (/ανωτατο|supreme/u.test(value)) return "supreme_court";
  if (/εφετειο|court of appeal/u.test(value)) return "court_of_appeal";
  return "unknown";
}
function instrumentType(name: string): string {
  const value = fold(name);
  if (/συνταγμα|constitution/u.test(value)) return "constitution";
  if (/κεφ\.?|chapter|cap\.?/u.test(value)) return "chapter";
  if (/πρωτοκολλ|συμβασ|treaty|convention/u.test(value)) return "treaty";
  if (/οδηγ|directive/u.test(value)) return "directive";
  if (/κανονισμ|rules?|regulation/u.test(value)) return "rule";
  return "law";
}
function normalizedProvision(lawId: string, display: string, article: string): string {
  return fold(`${lawId || "law"}:${article || display}`)
    .replace(/[^a-zα-ω0-9]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 180);
}
function precedentialWeight(raw: unknown): Row {
  const value = text(raw);
  const score = value === "Υψηλή" ? 80 : value === "Μέση" ? 55 : 30;
  const tier = value === "Υψηλή" ? "High" : value === "Μέση" ? "Medium" : "Low";
  return {
    score,
    tier,
    factors: {
      courtLevel: score,
      treatment: 0,
      novelty: 0,
      subsequentCitation: 0,
      doctrinalSignificance: 0,
    },
  };
}

function buildCanonical(core: Row, baseline: Row, source: Row, v2RunId: string): {
  record: Row;
  readinessScore: number;
  strictReady: boolean;
} {
  const sectionMap = validSectionMap(source, baseline);
  const registry = new EvidenceRegistry(source, sectionMap);
  const record = structuredClone(baseline || {});
  const coreIdentity = object(core.identity);
  const coreFacts = object(core.facts);
  const coreAnalysis = object(core.analysis);
  const coreOutcome = object(core.outcome);
  const coreAuthorities = object(core.authorities);

  const caseName = coreScalar(object(coreIdentity.caseName), "", "identity.caseName", registry);
  const caseNumber = coreScalar(object(coreIdentity.caseNumber), "", "identity.caseNumber", registry);
  const court = coreScalar(object(coreIdentity.court), "", "identity.court", registry);
  const decisionDate = coreScalar(object(coreIdentity.decisionDate), "", "identity.decisionDate", registry);
  const familyCore = coreScalar(object(coreIdentity.caseFamily), "unknown", "classification.caseFamily", registry);

  const judgesCore = object(coreIdentity.judicialComposition);
  const judges = array(judgesCore.value).flatMap((judge) => {
    const evidence = registry.register(object(judge).evidence, "identity.judges");
    const name = text(object(judge).name);
    return name && evidence.length
      ? [{ name, role: text(object(judge).role) || "unknown", honorific: "" }]
      : [];
  });
  const judgeEvidence = itemEvidence(judgesCore, "identity.judges", registry);
  const judgeField = judges.length && judgeEvidence.length
    ? available(judges, judgeEvidence, Number(judgesCore.confidence || 0.98))
    : indeterminate([], ["Judicial composition did not pass exact evidence validation."]);
  const authoring = judges.filter((judge) => judge.role === "authoring").map((judge) => judge.name);

  const baselineIdentity = object(record.identity);
  record.identity = {
    ...baselineIdentity,
    caseName,
    caseNumber,
    court,
    decisionDate,
    judges: judgeField,
    authoringJudges: authoring.length ? available(authoring, judgeEvidence, 0.98) : unavailable([]),
    courtLevel: court.status === "available" && array(court.evidence).length
      ? available(
        courtLevel(text(court.value), object(baselineIdentity.courtLevel).value),
        array(court.evidence),
        0.9,
      )
      : object(baselineIdentity.courtLevel).status
      ? baselineIdentity.courtLevel
      : indeterminate("unknown"),
  };

  const baselineClassification = object(record.classification);
  record.classification = {
    ...baselineClassification,
    caseFamily: familyCore.status === "available"
      ? available(caseFamily(text(familyCore.value)), familyCore.evidence, familyCore.confidence)
      : indeterminate("unknown"),
    courtLevel: record.identity.courtLevel,
  };

  const material = object(coreFacts.materialFacts);
  const materialValue = object(material.value);
  const factsEvidence = registry.register(material.evidence, "facts.summary");
  const summary = text(materialValue.summary);
  const points = uniqueStrings(array(materialValue.points));
  const factsAvailable = material.status === "available" && summary && factsEvidence.length;
  record.facts = {
    summary: factsAvailable
      ? available(summary, factsEvidence, Number(material.confidence || 0.96))
      : indeterminate("", ["Material facts require review."]),
    materialFacts: factsAvailable && points.length
      ? available(points.map((fact) => ({ fact, significance: "" })), registry.register(material.evidence, "facts.materialFacts"), Number(material.confidence || 0.96))
      : unavailable([]),
    chronology: unavailable([]),
    witnessesAndEvidence: unavailable([]),
    undisputedFacts: unavailable([]),
    disputedFacts: unavailable([]),
  };

  const legalField = object(coreAnalysis.legalIssues);
  const legalItems = array(legalField.value).flatMap((item, index) => {
    const row = object(item);
    const evidence = registry.register(row.evidence, "analysis.legalIssues");
    const issue = text(row.issue);
    const principle = text(row.principle);
    const holding = text(row.holding);
    return issue && holding && evidence.length ? [{ issue, principle, holding, evidence, index }] : [];
  });
  const dedupedIssues = new Map<string, typeof legalItems[number]>();
  for (const item of legalItems) {
    const key = fold(item.issue).replace(/[^a-zα-ω0-9]+/gu, " ");
    if (!dedupedIssues.has(key)) dedupedIssues.set(key, item);
  }
  const issues = [...dedupedIssues.values()].slice(0, 3);
  const issueEvidence = [...new Map(issues.flatMap((item) => item.evidence).map((anchor) => [anchor.id, anchor])).values()];
  const issueValues = issues.map((item, index) => ({
    issue: item.issue,
    centrality: index === 0 ? "primary" : "secondary",
    determination: item.holding,
  }));
  const holdings = uniqueStrings(issues.map((item) => item.holding));
  const principles = uniqueStrings(issues.map((item) => item.principle));
  for (const item of issues) {
    registry.register(item.evidence, "analysis.holding");
    registry.register(item.evidence, "analysis.ratioDecidendi");
    registry.register(item.evidence, "analysis.legalPrincipleSummary");
  }

  const obiterField = object(coreAnalysis.obiterDicta);
  const obiter = array(obiterField.value).flatMap((item) => {
    const row = object(item);
    const evidence = registry.register(row.evidence, "analysis.obiterDicta");
    const value = text(row.text);
    return value && evidence.length ? [{ value, evidence }] : [];
  });
  const obiterEvidence = [...new Map(obiter.flatMap((item) => item.evidence).map((anchor) => [anchor.id, anchor])).values()];

  record.analysis = {
    legalIssues: issueValues.length && issueEvidence.length
      ? available(issueValues, issueEvidence, Number(legalField.confidence || 0.96))
      : indeterminate([], ["Legal issues require review."]),
    dominantIssue: issueValues.length
      ? available(issueValues.map((item) => item.issue).join(" "), issueEvidence, 0.96)
      : indeterminate(""),
    findings: unavailable([]),
    holding: holdings.length
      ? available(holdings.join(" "), registry.register(issueEvidence, "analysis.holding"), 0.97)
      : indeterminate(""),
    ratioDecidendi: principles.length
      ? available(
        principles.map((principle, index) => ({
          principle,
          type: "ratio",
          conditions: [],
          exceptions: [],
          applicationToFacts: holdings[index] || holdings[0] || "",
        })),
        registry.register(issueEvidence, "analysis.ratioDecidendi"),
        0.96,
      )
      : unavailable([]),
    legalPrincipleSummary: principles.length
      ? available(principles.join(" "), registry.register(issueEvidence, "analysis.legalPrincipleSummary"), 0.96)
      : unavailable(""),
    secondaryPrinciples: unavailable([]),
    obiterDicta: obiter.length
      ? available(obiter.map((item) => item.value), obiterEvidence, Number(obiterField.confidence || 0.9))
      : unavailable([]),
    legalTestsAndStandards: unavailable([]),
    burdenAndStandardOfProof: unavailable([]),
    credibilityFindings: unavailable([]),
    dissentOrConcurrence: unavailable([]),
  };

  record.procedure = {
    proceduralHistory: unavailable(""),
    originatingProceeding: unavailable(""),
    lowerCourtDecision: unavailable(""),
    groundsOrIssues: unavailable([]),
    reliefSought: unavailable([]),
    submissionsByParty: unavailable([]),
  };

  const overall = coreScalar(object(coreOutcome.overallOutcome), "unknown", "outcome.overallOutcome", registry);
  if (overall.status === "available") overall.value = outcomeCode(text(overall.value));
  const disposition = coreScalar(object(coreOutcome.dispositionText), "", "outcome.dispositionText", registry);

  const ordersField = object(coreOutcome.orders);
  const orderItems = array(ordersField.value).flatMap((item) => {
    const row = object(item);
    const evidence = registry.register(row.evidence, "outcome.orders");
    const value = text(row.text);
    return value && evidence.length ? [{ ...row, text: value, evidence }] : [];
  });
  const orderEvidence = [...new Map(orderItems.flatMap((item) => item.evidence).map((anchor) => [anchor.id, anchor])).values()];

  const moneyField = object(coreOutcome.monetary);
  const monetary = array(moneyField.value).flatMap((item) => {
    const row = object(item);
    const evidence = registry.register(row.evidence, row.type === "costs" ? "outcome.costs" : "outcome.monetaryAwards");
    if (!evidence.length) return [];
    return [{
      type: text(row.type) || "other",
      stage: text(row.stage) === "appeal" ? "appellate" : text(row.stage) || "other",
      amount: text(row.amount),
      currency: text(row.currency),
      payer: text(row.payer),
      payee: text(row.payee),
      vatIncluded: false,
      vatStatus: "not_stated",
      interest: text(row.interest),
      evidence,
    }];
  });
  const costs = monetary.filter((item) => item.type === "costs");
  const awards = monetary.filter((item) => item.type !== "costs");
  const costEvidence = [...new Map(costs.flatMap((item) => item.evidence).map((anchor) => [anchor.id, anchor])).values()];
  const awardEvidence = [...new Map(awards.flatMap((item) => item.evidence).map((anchor) => [anchor.id, anchor])).values()];

  record.outcome = {
    overallOutcome: overall,
    scope: unavailable(""),
    dispositionText: disposition,
    components: unavailable([]),
    orders: orderItems.length
      ? available(orderItems.map((item) => item.text), orderEvidence, Number(ordersField.confidence || 0.98))
      : unavailable([]),
    remedies: unavailable([]),
    sentence: unavailable([]),
    monetaryAwards: awards.length
      ? available(awards.map(({ evidence: _evidence, ...item }) => item), awardEvidence, Number(moneyField.confidence || 0.98))
      : unavailable([]),
    costs: costs.length
      ? available(costs.map(({ evidence: _evidence, ...item }) => item), costEvidence, Number(moneyField.confidence || 0.98))
      : unavailable([]),
    remittalInstructions: unavailable([]),
    withdrawnOrAbandoned: unavailable([]),
  };

  const legislationField = object(coreAuthorities.legislation);
  const legislation = array(legislationField.value).flatMap((item) => {
    const row = object(item);
    const itemEvidence = registry.register(row.evidence, "authorities.legislation");
    const lawName = text(row.name);
    const lawId = text(row.lawId);
    const provisions = array(row.provisions).flatMap((provision) => {
      const value = object(provision);
      const evidence = registry.register(value.evidence, "authorities.legislation");
      const display = text(value.display);
      if (!display || !evidence.length) return [];
      return [{
        display,
        article: text(value.article),
        paragraph: "",
        subparagraph: "",
        part: "",
        normalized: normalizedProvision(lawId, display, text(value.article)),
        application: text(value.application) || "mentioned",
        evidence,
      }];
    });
    const evidence = [...new Map([...itemEvidence, ...provisions.flatMap((value) => value.evidence)].map((anchor) => [anchor.id, anchor])).values()];
    if (!lawName || !provisions.length || !evidence.length) return [];
    const primary = text(row.role) !== "background" && provisions.some((value) => ["applied", "interpreted", "considered"].includes(value.application));
    return [{
      lawId,
      lawLabel: lawName,
      instrumentName: lawName,
      instrumentType: instrumentType(lawName),
      role: text(row.role) || "background",
      primary,
      provisions: provisions.map(({ evidence: _evidence, ...value }) => value),
      proposition: text(row.proposition),
      evidence,
    }];
  });
  const legislationEvidence = [...new Map(legislation.flatMap((item) => item.evidence).map((anchor) => [anchor.id, anchor])).values()];
  const primaryLegislation = legislation.filter((item) => item.primary);
  const secondaryLegislation = legislation.filter((item) => !item.primary);

  const authorityField = object(coreAuthorities.authorities);
  const authorities = array(authorityField.value).flatMap((item) => {
    const row = object(item);
    const evidence = registry.register(row.evidence, "authorities.authorities");
    const name = text(row.name);
    if (!name || !evidence.length) return [];
    const yearMatch = `${text(row.citation)} ${name}`.match(/\b(19|20)\d{2}\b/u);
    return [{
      name,
      citation: text(row.citation),
      ecli: "",
      court: "",
      year: yearMatch ? Number(yearMatch[0]) : null,
      sourceType: "decision",
      treatment: text(row.treatment) || "mentioned",
      citationContext: "direct",
      legalPoint: text(row.legalPoint),
      quoted: false,
      evidence,
    }];
  });
  const authorityEvidence = [...new Map(authorities.flatMap((item) => item.evidence).map((anchor) => [anchor.id, anchor])).values()];

  record.authorities = {
    legislation: legislation.length
      ? available(legislation.map(({ evidence: _evidence, ...item }) => item), legislationEvidence, Number(legislationField.confidence || 0.97))
      : unavailable([]),
    primaryLegislation: primaryLegislation.length
      ? available(primaryLegislation.map(({ evidence: _evidence, ...item }) => item), [...new Map(primaryLegislation.flatMap((item) => item.evidence).map((anchor) => [anchor.id, anchor])).values()], 0.97)
      : unavailable([]),
    secondaryLegislation: secondaryLegislation.length
      ? available(secondaryLegislation.map(({ evidence: _evidence, ...item }) => item), [...new Map(secondaryLegislation.flatMap((item) => item.evidence).map((anchor) => [anchor.id, anchor])).values()], 0.95)
      : unavailable([]),
    authorities: authorities.length
      ? available(authorities.map(({ evidence: _evidence, ...item }) => item), authorityEvidence, Number(authorityField.confidence || 0.95))
      : unavailable([]),
  };

  const blockers = array(core.blockers);
  const strictReady = core.coreStatus === "pass" && !blockers.some((blocker) => object(blocker).required === true);
  const readinessScore = strictReady ? 95 : Math.max(35, 75 - blockers.filter((blocker) => object(blocker).required === true).length * 10);
  const conflicts = blockers.map((blocker) => ({
    code: text(object(blocker).code) || "CORE_V3_REVIEW",
    severity: object(blocker).required === true ? "critical" : "material",
    fieldPath: text(object(blocker).path),
    message: text(object(blocker).message) || "Core V3 requires review of this field.",
    evidenceIds: [],
  }));

  record.schemaVersion = "elite-core-v3.10-live-compat";
  record.runId = v2RunId;
  record.source = source;
  record.sectionMap = sectionMap;
  record.taxonomy = object(record.taxonomy);
  record.principleArchitecture = {};
  record.allEvidence = registry.values();
  record.conflicts = conflicts;
  record.reviewFlags = conflicts.map((conflict) => `${conflict.fieldPath}:${conflict.code}`);
  record.extractionConfidenceScore = strictReady ? 95 : readinessScore;
  record.readinessScore = readinessScore;
  record.readinessBreakdown = {
    baseScore: readinessScore,
    finalScore: readinessScore,
    components: [
      { key: "core", label: "Elite Core V3", earned: strictReady ? 95 : readinessScore, possible: 100, verified: strictReady },
    ],
    deductions: conflicts.length
      ? [{ severity: "material", points: 100 - readinessScore, codes: conflicts.map((conflict) => conflict.code) }]
      : [],
    blockers: conflicts,
    recommendation: strictReady ? "approve" : "review",
  };
  record.precedentialWeight = precedentialWeight(object(core.header).precedentialWeight);
  record.strictReady = strictReady;
  record.humanReviewRequired = true;
  record.stages = array(record.stages);
  record.apiUsage = object(record.apiUsage);
  record.coreV3 = {
    model: text(core.model) || "gpt-5.4-mini",
    coreStatus: text(core.coreStatus),
    sourceSchemaVersion: text(core.schemaVersion),
    primaryLegislation: array(object(core.header).primaryLegislation),
    candidateOnly: true,
  };
  record.createdAt = text(record.createdAt) || now();
  record.updatedAt = now();

  return { record, readinessScore, strictReady };
}

async function upsertChunks(table: string, rows: Row[], conflict: string, chunkSize = 400): Promise<void> {
  for (let index = 0; index < rows.length; index += chunkSize) {
    const { error } = await db.schema("nomologies").from(table).upsert(rows.slice(index, index + chunkSize), { onConflict: conflict });
    if (error) throw new Error(`${table.toUpperCase()}_UPSERT_FAILED:${error.message}`);
  }
}

async function publish(coreRunId: string): Promise<Row> {
  const [linkResult, runResult] = await Promise.all([
    db.schema("nomologies").from("core_v3_live_links").select("*").eq("core_run_id", coreRunId).single(),
    db.schema("nomologies").from("core_v3_runs").select("*").eq("id", coreRunId).single(),
  ]);
  if (linkResult.error) throw new Error(`LIVE_LINK_READ_FAILED:${linkResult.error.message}`);
  if (runResult.error) throw new Error(`CORE_RUN_READ_FAILED:${runResult.error.message}`);
  const link = linkResult.data;
  const coreRun = runResult.data;
  if (coreRun.status !== "completed") throw new Error(`CORE_RUN_NOT_COMPLETED:${coreRun.status}`);

  const [baselineResult, caseResult, shadowRunResult] = await Promise.all([
    db.schema("nomologies").from("case_versions").select("*").eq("id", link.baseline_version_id).single(),
    db.schema("nomologies").from("cases").select("*").eq("id", link.case_id).single(),
    db.schema("nomologies").from("pipeline_runs").select("stage_state").eq("id", link.v2_run_id).single(),
  ]);
  if (baselineResult.error) throw new Error(`BASELINE_READ_FAILED:${baselineResult.error.message}`);
  if (caseResult.error) throw new Error(`CASE_READ_FAILED:${caseResult.error.message}`);
  if (shadowRunResult.error) throw new Error(`SHADOW_RUN_READ_FAILED:${shadowRunResult.error.message}`);
  const baselineVersion = baselineResult.data;
  const caseRow = caseResult.data;
  const shadowStageState = object(shadowRunResult.data?.stage_state);
  const source = await download(coreRun.source_artifact_path);
  const core = object(coreRun.candidate_record);
  const built = buildCanonical(core, object(baselineVersion.canonical_record), source, link.v2_run_id);

  const recordPath = await upload(`core-v3/runs/${coreRunId}/record-live-compatible.json`, built.record);
  const reviewer = {
    pipeline: "elite-core-v3-live",
    model: "gpt-5.4-mini",
    coreRunId,
    v2RunId: link.v2_run_id,
    baselineVersionId: link.baseline_version_id,
    coreStatus: text(core.coreStatus),
    strictReady: built.strictReady,
    readinessScore: built.readinessScore,
    blockers: array(core.blockers),
    publicationRecommendation: built.strictReady ? "approve" : "review",
    reviewedAt: now(),
  };
  const reviewerPath = await upload(`core-v3/runs/${coreRunId}/reviewer-live-compatible.json`, reviewer);

  let versionId = text(link.candidate_version_id);
  let versionNo = 0;
  if (versionId) {
    const { data, error } = await db.schema("nomologies").from("case_versions").select("id,version_no").eq("id", versionId).maybeSingle();
    if (error) throw new Error(`CANDIDATE_VERSION_READ_FAILED:${error.message}`);
    if (data) versionNo = Number(data.version_no || 0);
    else versionId = "";
  }
  if (!versionId) {
    const { data: existing, error: existingError } = await db.schema("nomologies").from("case_versions")
      .select("id,version_no")
      .eq("run_id", link.v2_run_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existingError) throw new Error(`CANDIDATE_VERSION_LOOKUP_FAILED:${existingError.message}`);
    if (existing) {
      versionId = String(existing.id);
      versionNo = Number(existing.version_no || 0);
    }
  }
  if (!versionId) {
    const { data: latest, error: latestError } = await db.schema("nomologies").from("case_versions")
      .select("version_no")
      .eq("case_id", link.case_id)
      .order("version_no", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestError) throw new Error(`VERSION_NUMBER_READ_FAILED:${latestError.message}`);
    versionNo = Number(latest?.version_no || 0) + 1;
    const { data: created, error: createError } = await db.schema("nomologies").from("case_versions").insert({
      case_id: link.case_id,
      run_id: link.v2_run_id,
      version_no: versionNo,
      schema_version: built.record.schemaVersion,
      canonical_record: built.record,
      reviewer_record: reviewer,
      record_artifact_path: recordPath,
      readiness_score: built.readinessScore,
      strict_ready: built.strictReady,
      human_review_required: true,
      conflict_summary: { conflicts: built.record.conflicts, reviewFlags: built.record.reviewFlags },
    }).select("id").single();
    if (createError || !created) throw new Error(`CASE_VERSION_CREATE_FAILED:${createError?.message || "unknown"}`);
    versionId = String(created.id);
    await db.schema("nomologies").from("core_v3_live_links").update({ candidate_version_id: versionId, updated_at: now() }).eq("core_run_id", coreRunId);
  } else {
    const { error } = await db.schema("nomologies").from("case_versions").update({
      schema_version: built.record.schemaVersion,
      canonical_record: built.record,
      reviewer_record: reviewer,
      record_artifact_path: recordPath,
      readiness_score: built.readinessScore,
      strict_ready: built.strictReady,
      human_review_required: true,
      conflict_summary: { conflicts: built.record.conflicts, reviewFlags: built.record.reviewFlags },
    }).eq("id", versionId);
    if (error) throw new Error(`CASE_VERSION_UPDATE_FAILED:${error.message}`);
  }

  const paragraphs = array(source.paragraphs).map((paragraph) => ({
    case_version_id: versionId,
    paragraph_id: String(paragraph.id),
    ordinal: Number(paragraph.ordinal || 0),
    paragraph_text: String(paragraph.text || ""),
    start_offset: Number(paragraph.startOffset || 0),
    end_offset: Number(paragraph.endOffset || 0),
    relative_position: Number(paragraph.relativePosition || 0),
    formatting: object(paragraph.formatting),
  }));
  const sections = array(built.record.sectionMap?.spans).map((span) => ({
    case_version_id: versionId,
    section_id: String(span.id),
    start_paragraph_id: String(span.startParagraphId),
    end_paragraph_id: String(span.endParagraphId),
    section_type: text(span.sectionType) || "other",
    speaker_role: text(span.speakerRole) || "unknown",
    heading: text(span.heading),
    is_quoted_material: Boolean(span.isQuotedMaterial),
    quoted_source_type: text(span.quotedSourceType) || "none",
    confidence: Number(span.confidence || 0),
    rationale: text(span.rationale),
  }));
  const evidence = array(built.record.allEvidence).map((anchor) => ({
    case_version_id: versionId,
    evidence_id: text(anchor.id),
    field_path: array(anchor.supports)[0] || "",
    paragraph_ids: array(anchor.paragraphIds).map(String),
    quote: text(anchor.quote),
    section_type: text(anchor.sectionType),
    speaker_role: text(anchor.speakerRole),
    supports: array(anchor.supports).map(String),
    exact_match: Boolean(anchor.exactMatch),
  }));

  await Promise.all([
    db.schema("nomologies").from("case_paragraphs").delete().eq("case_version_id", versionId),
    db.schema("nomologies").from("case_sections").delete().eq("case_version_id", versionId),
    db.schema("nomologies").from("evidence_anchors").delete().eq("case_version_id", versionId),
  ]);
  await upsertChunks("case_paragraphs", paragraphs, "case_version_id,paragraph_id");
  await upsertChunks("case_sections", sections, "case_version_id,section_id");
  await upsertChunks("evidence_anchors", evidence, "case_version_id,evidence_id");

  await db.schema("nomologies").from("cases").update({
    pending_version_id: versionId,
    pending_run_id: link.v2_run_id,
    pending_readiness_score: built.readinessScore,
    pending_strict_ready: built.strictReady,
    pending_created_at: now(),
    human_review_required: true,
    updated_at: now(),
  }).eq("id", link.case_id);

  const critical = array(built.record.conflicts).filter((conflict) => conflict.severity === "critical").length;
  const material = array(built.record.conflicts).filter((conflict) => conflict.severity === "material").length;
  const runStatus = built.strictReady ? "strict_ready" : "review";
  await db.schema("nomologies").from("pipeline_runs").update({
    schema_version: built.record.schemaVersion,
    status: runStatus,
    current_stage: "review",
    model: "gpt-5.4-mini",
    record_artifact_path: recordPath,
    reviewer_artifact_path: reviewerPath,
    readiness_score: built.readinessScore,
    strict_ready: built.strictReady,
    human_review_required: true,
    critical_conflicts: critical,
    material_conflicts: material,
    minor_conflicts: 0,
    error_code: "",
    error_message: "",
    completed_at: now(),
    stage_state: {
      ...shadowStageState,
      coreV3: {
        enabled: true,
        pipeline: built.record.schemaVersion,
        model: "gpt-5.4-mini",
        coreRunId,
        baselineVersionId: link.baseline_version_id,
        candidateVersionId: versionId,
        readinessScore: built.readinessScore,
        strictReady: built.strictReady,
        phase: "review",
        completedAt: now(),
      },
    },
    updated_at: now(),
  }).eq("id", link.v2_run_id);

  if (link.bulk_item_id) {
    await db.schema("nomologies").from("bulk_items").update({
      case_id: link.case_id,
      pipeline_run_id: link.v2_run_id,
      status: runStatus,
      current_stage: "review",
      progress: 100,
      last_error_code: "",
      last_error_message: "",
      result_summary: {
        caseName: text(object(built.record.identity.caseName).value) || caseRow.case_name,
        caseNumber: text(object(built.record.identity.caseNumber).value) || caseRow.case_number,
        readinessScore: built.readinessScore,
        strictReady: built.strictReady,
        pipeline: built.record.schemaVersion,
        coreRunId,
        caseVersionId: versionId,
      },
      updated_at: now(),
    }).eq("id", link.bulk_item_id);
  }

  const { data: control } = await db.schema("nomologies").from("system_controls")
    .select("enabled")
    .eq("control_key", "elite_core_v3_auto_publish_enabled")
    .maybeSingle();
  const autoPublished = Boolean(link.auto_publish && control?.enabled && built.strictReady);

  if (autoPublished) {
    await db.schema("nomologies").from("cases").update({
      current_version_id: versionId,
      pending_version_id: null,
      pending_run_id: null,
      pending_readiness_score: null,
      pending_strict_ready: null,
      pending_created_at: null,
      publication_status: "published",
      readiness_score: built.readinessScore,
      strict_ready: true,
      human_review_required: false,
      approved_at: now(),
      published_at: now(),
      updated_at: now(),
    }).eq("id", link.case_id);
    await db.schema("nomologies").from("pipeline_tasks").upsert({
      run_id: link.v2_run_id,
      batch_id: link.batch_id || null,
      bulk_item_id: link.bulk_item_id || null,
      stage: "embeddings",
      status: "queued",
      priority: 180,
      payload: { caseId: link.case_id, caseVersionId: versionId, publish: true },
      attempt_count: 0,
      available_at: now(),
      locked_at: null,
      locked_until: null,
      locked_by: "",
      last_error_code: "",
      last_error_message: "",
    }, { onConflict: "run_id,stage" });
    await db.schema("nomologies").from("pipeline_runs").update({
      status: "running",
      current_stage: "embeddings",
      completed_at: null,
      updated_at: now(),
    }).eq("id", link.v2_run_id);
  }

  await db.schema("nomologies").from("core_v3_live_links").update({
    candidate_version_id: versionId,
    status: autoPublished ? "completed" : "review",
    phase: "done",
    driver_token: "",
    error_code: "",
    error_message: "",
    result: {
      ...object(link.result),
      caseId: link.case_id,
      caseVersionId: versionId,
      readinessScore: built.readinessScore,
      strictReady: built.strictReady,
      autoPublished,
      recordPath,
      reviewerPath,
    },
    orchestrator_locked_at: null,
    orchestrator_locked_until: null,
    orchestrator_locked_by: "",
    completed_at: now(),
    updated_at: now(),
  }).eq("core_run_id", coreRunId);

  await db.schema("nomologies").from("pipeline_events").insert({
    run_id: link.v2_run_id,
    batch_id: link.batch_id || null,
    bulk_item_id: link.bulk_item_id || null,
    level: "info",
    event_type: "core_v3_candidate_persisted",
    message: "Elite Core V3 candidate was persisted for live application review.",
    data: {
      coreRunId,
      caseId: link.case_id,
      caseVersionId: versionId,
      readinessScore: built.readinessScore,
      strictReady: built.strictReady,
      autoPublished,
    },
  });

  return {
    coreRunId,
    v2RunId: link.v2_run_id,
    caseId: link.case_id,
    caseVersionId: versionId,
    readinessScore: built.readinessScore,
    strictReady: built.strictReady,
    autoPublished,
    status: autoPublished ? "indexing" : "review",
  };
}

Deno.serve(async (req: Request) => {
  if (!authorized(req)) return json({ ok: false, code: "UNAUTHORIZED" }, 401);
  try {
    const payload = object(await req.json().catch(() => ({})));
    const coreRunId = text(payload.coreRunId || payload.runId);
    if (!/^[0-9a-f-]{36}$/i.test(coreRunId)) {
      return json({ ok: false, code: "CORE_RUN_ID_REQUIRED" }, 400);
    }
    return json({ ok: true, ...await publish(coreRunId) });
  } catch (error) {
    console.error(error);
    return json({
      ok: false,
      code: "LIVE_PUBLISHER_ERROR",
      message: error instanceof Error ? error.message : String(error),
    }, 500);
  }
});
