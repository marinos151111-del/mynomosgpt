import { createStructuredResponse } from "./openai-responses.ts";
import { REVIEW_SYSTEM_PROMPT } from "./prompts.ts";
import { NOMOLOGIES_SCHEMAS } from "./schemas.ts";
import { collectEvidence } from "./evidence.ts";
import { prepareJudgmentSource } from "./source.ts";
import { buildSectionMap } from "./sections.ts";
import { runSpecialistAgents, type SpecialistResultsV2 } from "./agents.ts";
import { detectSourceDateConflicts } from "./quality.ts";
import {
  NOMOLOGIES_V2_VERSION,
  OUTCOME_CODES,
  SECTION_TYPES,
  type ExtractedFieldV2,
  type NomologiesCaseRecordV2,
  type NomologiesPipelineInputV2,
  type PipelineConflictV2,
  type PipelineStageAuditV2,
  type SearchTaxonomyV2,
  type SectionMapV2,
} from "./types.ts";

type JsonRecord = Record<string, unknown>;

export type NomologiesPipelineResultV2 =
  | {
      mode: "sections";
      runId: string;
      source: Awaited<ReturnType<typeof prepareJudgmentSource>>;
      sectionMap: SectionMapV2;
      stages: PipelineStageAuditV2[];
    }
  | {
      mode: "full";
      record: NomologiesCaseRecordV2;
      reviewer: JsonRecord;
      rawAgents: SpecialistResultsV2["raw"];
    };

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function obj(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.map((value) => value.trim()).filter((value) => {
    const key = value.toLocaleLowerCase("el");
    if (!value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fieldAvailable(field: ExtractedFieldV2<unknown>): boolean {
  if (field.status !== "available" || field.evidence.length === 0) return false;
  if (typeof field.value === "string") return field.value.trim().length > 0;
  if (Array.isArray(field.value)) return field.value.length > 0;
  return field.value !== null && field.value !== undefined;
}

function fieldText(field: ExtractedFieldV2<unknown>): string[] {
  if (!fieldAvailable(field)) return [];
  const value = field.value;
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (!isRecord(item)) return [];
      return [
        str(item.issue), str(item.title), str(item.description), str(item.principle),
        str(item.finding), str(item.legalPoint), str(item.fact), str(item.summary),
      ].filter(Boolean);
    });
  }
  return [];
}

function buildTaxonomy(results: SpecialistResultsV2): SearchTaxonomyV2 {
  const issueTags = unique([
    ...fieldText(results.analysis.dominantIssue),
    ...fieldText(results.analysis.legalIssues),
    ...fieldText(results.procedure.groundsOrIssues),
  ]).slice(0, 40);
  const principleGroups = unique([
    ...fieldText(results.analysis.legalPrincipleSummary),
    ...fieldText(results.analysis.ratioDecidendi),
    ...fieldText(results.analysis.secondaryPrinciples),
    ...fieldText(results.analysis.legalTestsAndStandards),
  ]).slice(0, 40);
  const subjectMatter = fieldAvailable(results.classification.subjectMatter)
    ? results.classification.subjectMatter.value
    : [];
  const legalAreas = fieldAvailable(results.classification.legalAreas)
    ? results.classification.legalAreas.value
    : [];
  const keywords = unique([
    ...subjectMatter,
    ...legalAreas,
    ...issueTags,
    ...principleGroups,
  ]).slice(0, 80);
  const aliases = unique([
    fieldAvailable(results.identity.caseName) ? results.identity.caseName.value : "",
    fieldAvailable(results.identity.shortName) ? results.identity.shortName.value : "",
    fieldAvailable(results.identity.citation) ? results.identity.citation.value : "",
    fieldAvailable(results.identity.ecli) ? results.identity.ecli.value : "",
    fieldAvailable(results.identity.caseNumber) ? results.identity.caseNumber.value : "",
    fieldAvailable(results.identity.docket) ? results.identity.docket.value : "",
  ]).slice(0, 30);

  const offenceSignals = keywords.filter((value) =>
    /(φόνος|ανθρωποκτον|βιασ|ληστ|κλοπ|απάτ|ναρκωτικ|assault|murder|rape|robbery|theft|fraud|drug)/iu.test(value)
  );
  return {
    issueTags,
    offenceTags: offenceSignals.slice(0, 30),
    keywords,
    aliases,
    topicGroups: unique([...subjectMatter, ...legalAreas]).slice(0, 30),
    principleGroups,
    evidenceGroups: keywords.filter((value) => /(μαρτυρ|απόδειξ|evidence|credib|hearsay)/iu.test(value)).slice(0, 20),
    procedureGroups: keywords.filter((value) => /(έφεσ|αίτησ|δικον|procedure|appeal|application|certiorari|habeas|mandamus|prohibition)/iu.test(value)).slice(0, 20),
    publicLawGroups: keywords.filter((value) => /(διοικητ|συνταγμα|δημόσι|immigration|asylum|tax|customs|public|constitutional)/iu.test(value)).slice(0, 20),
  };
}

function deterministicConflicts(
  source: Awaited<ReturnType<typeof prepareJudgmentSource>>,
  results: SpecialistResultsV2,
  sectionMap: SectionMapV2,
  officialSource: boolean,
): PipelineConflictV2[] {
  const conflicts: PipelineConflictV2[] = [];
  const add = (code: string, severity: PipelineConflictV2["severity"], fieldPath: string, message: string) => {
    conflicts.push({ code, severity, fieldPath, message, evidenceIds: [] });
  };

  if (!officialSource) add("SOURCE_NOT_OFFICIAL_CYLAW", "material", "source.sourceUrl", "The source URL is not a verified CyLaw HTTPS address.");
  if (!sectionMap.coverageComplete || !sectionMap.overlapFree) add("SECTION_MAP_INCOMPLETE", "critical", "sectionMap", "The section map does not form a complete non-overlapping judgment partition.");
  if (!fieldAvailable(results.identity.caseName)) add("CASE_NAME_UNVERIFIED", "critical", "identity.caseName", "The present judgment's formal case name is not evidence-grounded.");
  if (!fieldAvailable(results.identity.decisionDate)) add("DECISION_DATE_UNVERIFIED", "critical", "identity.decisionDate", "The judgment date is not evidence-grounded.");
  if (!fieldAvailable(results.identity.court)) add("COURT_UNVERIFIED", "critical", "identity.court", "The deciding court is not evidence-grounded.");
  const hasReference = [results.identity.caseNumber, results.identity.docket, results.identity.citation, results.identity.ecli].some(fieldAvailable);
  if (!hasReference) add("CASE_REFERENCE_UNVERIFIED", "critical", "identity", "No case number, docket, citation or ECLI is evidence-grounded.");
  if (!fieldAvailable(results.identity.judges)) add("JUDGES_UNVERIFIED", "material", "identity.judges", "The judicial panel is not evidence-grounded.");
  if (!fieldAvailable(results.facts.summary)) add("FACTS_UNVERIFIED", "material", "facts.summary", "The material facts summary is not evidence-grounded.");
  if (!fieldAvailable(results.analysis.legalIssues)) add("LEGAL_ISSUES_UNVERIFIED", "critical", "analysis.legalIssues", "The issues determined by the present court are not evidence-grounded.");
  if (!fieldAvailable(results.analysis.holding)) add("HOLDING_UNVERIFIED", "critical", "analysis.holding", "The present court's holding is not evidence-grounded.");
  if (!fieldAvailable(results.analysis.legalPrincipleSummary) && !fieldAvailable(results.analysis.ratioDecidendi)) {
    add("LEGAL_PRINCIPLE_UNVERIFIED", "critical", "analysis.legalPrincipleSummary", "No evidence-grounded legal principle or ratio decidendi was extracted.");
  }
  if (!fieldAvailable(results.outcome.overallOutcome) || results.outcome.overallOutcome.value === "unknown") {
    add("OUTCOME_UNVERIFIED", "critical", "outcome.overallOutcome", "The final outcome is not evidence-grounded.");
  }
  if (!fieldAvailable(results.outcome.dispositionText)) add("DISPOSITION_UNVERIFIED", "critical", "outcome.dispositionText", "The operative final order is not evidence-grounded.");
  if (!fieldAvailable(results.classification.primaryLegalArea)) add("PRIMARY_LEGAL_AREA_UNVERIFIED", "material", "classification.primaryLegalArea", "The immediate primary legal area is not evidence-grounded.");
  if (!fieldAvailable(results.classification.proceedingType)) add("PROCEEDING_TYPE_UNVERIFIED", "material", "classification.proceedingType", "The immediate proceeding type is not evidence-grounded.");
  conflicts.push(...detectSourceDateConflicts(source));

  // Raw invalid anchors remain visible in reviewFlags, but do not become critical
  // conflicts when the validated field is optional or has been independently repaired.
  return conflicts;
}

function scoreReadiness(
  results: SpecialistResultsV2,
  sectionMap: SectionMapV2,
  conflicts: PipelineConflictV2[],
  officialSource: boolean,
  reviewerRecommendation: string,
): number {
  let score = 0;
  if (officialSource) score += 4;
  if (sectionMap.coverageComplete && sectionMap.overlapFree) score += 8;

  const identityFields = [
    results.identity.caseName, results.identity.decisionDate, results.identity.court,
    results.identity.caseNumber, results.identity.docket, results.identity.citation,
    results.identity.ecli, results.identity.judges,
  ];
  score += Math.round(identityFields.filter(fieldAvailable).length / identityFields.length * 18);

  const classificationFields = [
    results.classification.caseFamily, results.classification.primaryLegalArea,
    results.classification.proceedingType, results.classification.proceduralPosture,
    results.classification.courtLevel,
  ];
  score += Math.round(classificationFields.filter(fieldAvailable).length / classificationFields.length * 7);

  const factFields = [results.facts.summary, results.facts.materialFacts, results.facts.chronology];
  score += Math.round(factFields.filter(fieldAvailable).length / factFields.length * 10);

  const procedureFields = [
    results.procedure.proceduralHistory,
    results.procedure.originatingProceeding,
    results.procedure.lowerCourtDecision,
    results.procedure.groundsOrIssues,
  ];
  score += Math.round(procedureFields.filter(fieldAvailable).length / procedureFields.length * 5);

  const analysisFields = [
    results.analysis.legalIssues, results.analysis.holding, results.analysis.ratioDecidendi,
    results.analysis.legalPrincipleSummary, results.analysis.findings,
    results.analysis.legalTestsAndStandards,
  ];
  score += Math.round(analysisFields.filter(fieldAvailable).length / analysisFields.length * 24);

  const authorityFields = [results.authorities.legislation, results.authorities.authorities];
  score += Math.round(authorityFields.filter(fieldAvailable).length / authorityFields.length * 8);

  const outcomeFields = [
    results.outcome.overallOutcome, results.outcome.dispositionText,
    results.outcome.orders, results.outcome.costs,
  ];
  score += Math.round(outcomeFields.filter(fieldAvailable).length / outcomeFields.length * 16);

  score -= conflicts.filter((item) => item.severity === "critical").length * 12;
  score -= conflicts.filter((item) => item.severity === "material").length * 4;
  score -= conflicts.filter((item) => item.severity === "minor").length;
  if (reviewerRecommendation === "approve") score += 4;
  if (reviewerRecommendation === "review") score -= 2;
  if (reviewerRecommendation === "reject") score -= 8;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function officialCylawUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "cylaw.org" || url.hostname === "www.cylaw.org");
  } catch {
    return false;
  }
}

function reviewContextParagraphs(
  source: Awaited<ReturnType<typeof prepareJudgmentSource>>,
  evidenceIds: string[],
  recordEvidence: ReturnType<typeof collectEvidence>,
): JsonRecord[] {
  const required = new Set<string>();
  source.paragraphs.slice(0, 45).forEach((paragraph) => required.add(paragraph.id));
  source.paragraphs.slice(-90).forEach((paragraph) => required.add(paragraph.id));
  for (const evidence of recordEvidence) for (const id of evidence.paragraphIds) if (id !== "TITLE") required.add(id);
  for (const id of evidenceIds) if (id.startsWith("P")) required.add(id);
  return source.paragraphs
    .filter((paragraph) => required.has(paragraph.id))
    .map((paragraph) => ({ id: paragraph.id, ordinal: paragraph.ordinal, text: paragraph.text }));
}

async function runReviewer(
  source: Awaited<ReturnType<typeof prepareJudgmentSource>>,
  sectionMap: SectionMapV2,
  results: SpecialistResultsV2,
  taxonomy: SearchTaxonomyV2,
  deterministic: PipelineConflictV2[],
  options: { signal?: AbortSignal; model?: string },
): Promise<{ payload: JsonRecord; audit: PipelineStageAuditV2 }> {
  const evidence = collectEvidence({
    identity: results.identity,
    classification: results.classification,
    facts: results.facts,
    procedure: results.procedure,
    analysis: results.analysis,
    authorities: results.authorities,
    outcome: results.outcome,
  });
  const startedAt = new Date().toISOString();
  const user = JSON.stringify({
    contract: "nomologies.review.v2",
    source: {
      sourceTitle: source.sourceTitle,
      sourceUrl: source.sourceUrl,
      sourceHash: source.sourceHash,
    },
    sectionMap,
    extracted: {
      identity: results.identity,
      classification: results.classification,
      facts: results.facts,
      procedure: results.procedure,
      analysis: results.analysis,
      authorities: results.authorities,
      outcome: results.outcome,
      taxonomy,
    },
    deterministicConflicts: deterministic,
    sourceParagraphs: reviewContextParagraphs(source, [], evidence),
  });
  const response = await createStructuredResponse({
    stage: "independent-review",
    schemaName: NOMOLOGIES_SCHEMAS.review.name,
    schema: NOMOLOGIES_SCHEMAS.review.schema,
    system: REVIEW_SYSTEM_PROMPT,
    user,
    effort: "medium",
    model: options.model,
    timeoutMs: 240_000,
    signal: options.signal,
  });
  return {
    payload: response.data,
    audit: {
      stage: "independent-review",
      status: "completed",
      model: response.model,
      responseId: response.responseId,
      startedAt,
      completedAt: new Date().toISOString(),
      elapsedMs: response.elapsedMs,
      inputCharacters: user.length,
      outputCharacters: JSON.stringify(response.data).length,
      errorCode: "",
    },
  };
}

function reviewerConflicts(
  payload: JsonRecord,
  validEvidenceRefs: Set<string>,
  results: SpecialistResultsV2,
): PipelineConflictV2[] {
  const explicitlyNumbered = fieldAvailable(results.procedure.groundsOrIssues) &&
    results.procedure.groundsOrIssues.value.some((ground) => ground.number.trim().length > 0);
  return asArray(payload.conflicts).flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const code = str(raw.code) || "REVIEWER_CONFLICT";
    const fieldPath = str(raw.fieldPath);
    if (code === "HOLDING_NOT_POPULATED" && fieldAvailable(results.analysis.holding)) return [];
    if (["MISSING_COMPONENT_OUTCOMES", "OUTCOME_COMPONENTS_INCOMPLETE"].includes(code) && !explicitlyNumbered) return [];
    if (code === "MISSING_COMPONENT_OUTCOMES" && fieldAvailable(results.outcome.components) &&
      fieldAvailable(results.procedure.groundsOrIssues)) {
      const resolved = results.procedure.groundsOrIssues.value.filter((ground) =>
        ["succeeded", "failed", "partly_succeeded"].includes(ground.result)
      );
      if (results.outcome.components.value.length >= resolved.length) return [];
    }
    if (code === "HOLDING_EVIDENCE_MISATTRIBUTED" && fieldAvailable(results.analysis.holding)) return [];
    if (code === "SECTION_CROSSCONTAMINATION_OUTCOME_IN_FACTS" &&
      fieldAvailable(results.facts.summary) &&
      !/(?:έφεση|αίτηση|προσφυγή)\s+(?:απορρίπ|επιτρέπ|γίνεται\s+δεκτ)/iu.test(results.facts.summary.value)) return [];
    if (code === "LOWER_COURT_ORDER_CONFLICT" && results.procedure.lowerCourtDecision.status === "available") return [];
    let severity = str(raw.severity);
    if (code === "LEGISLATION_ATTRIBUTION_AMBIGUOUS") severity = "minor";
    if (!["critical", "material", "minor"].includes(severity)) return [];
    return [{
      code,
      severity: severity as PipelineConflictV2["severity"],
      fieldPath,
      message: str(raw.message),
      evidenceIds: asArray(raw.evidenceIds).map(str).filter((id) => validEvidenceRefs.has(id)),
    }];
  });
}

function sectionAudits(
  audits: Array<Record<string, unknown>>,
  startedAt: string,
): PipelineStageAuditV2[] {
  return audits.map((audit, index) => ({
    stage: str(audit.stage) || `sections-${index + 1}`,
    status: "completed",
    model: str(audit.model),
    responseId: str(audit.responseId),
    startedAt,
    completedAt: new Date().toISOString(),
    elapsedMs: Number(audit.elapsedMs) || 0,
    inputCharacters: 0,
    outputCharacters: 0,
    errorCode: "",
  }));
}

export async function runNomologiesPipelineV2(
  input: NomologiesPipelineInputV2,
  options: { signal?: AbortSignal; model?: string } = {},
): Promise<NomologiesPipelineResultV2> {
  const runId = crypto.randomUUID();
  const pipelineStarted = new Date().toISOString();
  const sourceStartedMs = Date.now();
  const source = await prepareJudgmentSource(input);
  const sourceAudit: PipelineStageAuditV2 = {
    stage: "source-preparation",
    status: "completed",
    model: "deterministic",
    responseId: "",
    startedAt: pipelineStarted,
    completedAt: new Date().toISOString(),
    elapsedMs: Date.now() - sourceStartedMs,
    inputCharacters: String(input.text || input.html || "").length,
    outputCharacters: source.cleanText.length,
    errorCode: "",
  };

  const sectionStarted = new Date().toISOString();
  const sections = await buildSectionMap(source, options);
  const stages = [sourceAudit, ...sectionAudits(sections.audits, sectionStarted)];
  if ((input.mode || "full") === "sections") {
    return { mode: "sections", runId, source, sectionMap: sections.map, stages };
  }

  const specialists = await runSpecialistAgents(source, sections.map, options);
  const taxonomy = buildTaxonomy(specialists);
  const officialSource = officialCylawUrl(source.sourceUrl);
  const deterministic = deterministicConflicts(source, specialists, sections.map, officialSource);
  const review = await runReviewer(source, sections.map, specialists, taxonomy, deterministic, options);

  const preliminaryEvidence = collectEvidence({
    identity: specialists.identity,
    classification: specialists.classification,
    facts: specialists.facts,
    procedure: specialists.procedure,
    analysis: specialists.analysis,
    authorities: specialists.authorities,
    outcome: specialists.outcome,
  });
  const validEvidenceRefs = new Set([
    ...preliminaryEvidence.map((item) => item.id),
    ...source.paragraphs.map((paragraph) => paragraph.id),
  ]);
  const conflictMap = new Map<string, PipelineConflictV2>();
  for (const conflict of [...deterministic, ...reviewerConflicts(review.payload, validEvidenceRefs, specialists)]) {
    const key = conflict.code === "SOURCE_DATE_CONFLICT"
      ? conflict.code
      : `${conflict.code}|${conflict.fieldPath}|${conflict.message}`;
    const existing = conflictMap.get(key);
    if (!existing) {
      conflictMap.set(key, conflict);
      continue;
    }
    existing.evidenceIds = [...new Set([...existing.evidenceIds, ...conflict.evidenceIds])];
  }
  const conflicts = [...conflictMap.values()];
  const rawRecommendation = str(review.payload.publishRecommendation) || "review";
  const criticalConflict = conflicts.some((item) => item.severity === "critical");
  const recommendation = rawRecommendation === "reject" && !criticalConflict ? "review" : rawRecommendation;
  const readinessScore = scoreReadiness(specialists, sections.map, conflicts, officialSource, recommendation);
  const strictReady =
    readinessScore >= 90 &&
    !criticalConflict &&
    recommendation === "approve" &&
    fieldAvailable(specialists.identity.caseName) &&
    fieldAvailable(specialists.analysis.holding) &&
    (fieldAvailable(specialists.analysis.legalPrincipleSummary) || fieldAvailable(specialists.analysis.ratioDecidendi)) &&
    fieldAvailable(specialists.outcome.dispositionText) &&
    fieldAvailable(specialists.outcome.overallOutcome) &&
    (OUTCOME_CODES as readonly string[]).includes(String(specialists.outcome.overallOutcome.value));

  const now = new Date().toISOString();
  const record: NomologiesCaseRecordV2 = {
    schemaVersion: NOMOLOGIES_V2_VERSION,
    runId,
    source,
    sectionMap: sections.map,
    identity: specialists.identity,
    classification: specialists.classification,
    facts: specialists.facts,
    procedure: specialists.procedure,
    analysis: specialists.analysis,
    authorities: specialists.authorities,
    outcome: specialists.outcome,
    taxonomy,
    allEvidence: preliminaryEvidence,
    conflicts,
    reviewFlags: unique([
      ...specialists.reviewFlags,
      ...sections.map.reviewFlags,
      ...conflicts.map((item) => item.code),
      ...asArray(review.payload.sectionCorrections).map((item) => `review_section_correction:${str(obj(item).spanId)}`),
    ]),
    readinessScore,
    strictReady,
    // V2 initially remains human-review-first even when strict-ready. The UI can
    // approve and create a signed review decision before deployment.
    humanReviewRequired: true,
    stages: [...stages, ...specialists.audits, review.audit],
    createdAt: pipelineStarted,
    updatedAt: now,
  };

  return {
    mode: "full",
    record,
    reviewer: {
      ...review.payload,
      effectivePublishRecommendation: recommendation,
      rawPublishRecommendation: rawRecommendation,
    },
    rawAgents: specialists.raw,
  };
}
