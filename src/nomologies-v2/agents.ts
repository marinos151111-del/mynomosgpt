import {
  createStructuredResponse,
  type ReasoningEffort,
} from "./openai-responses.ts";
import {
  ANALYSIS_SYSTEM_PROMPT,
  AUTHORITIES_SYSTEM_PROMPT,
  FACTS_PROCEDURE_SYSTEM_PROMPT,
  IDENTITY_SYSTEM_PROMPT,
  OUTCOME_SYSTEM_PROMPT,
} from "./prompts.ts";
import { NOMOLOGIES_SCHEMAS } from "./schemas.ts";
import {
  buildEvidenceContext,
  validateExtractedField,
  type EvidenceValidationContext,
} from "./evidence.ts";
import type {
  CaseAnalysisV2,
  CaseAuthoritiesV2,
  CaseClassificationV2,
  CaseFactsV2,
  CaseIdentityV2,
  CaseOutcomeV2,
  CaseProcedureV2,
  JudgmentParagraphV2,
  JudgmentSourceV2,
  PipelineStageAuditV2,
  SectionMapV2,
  SectionSpanV2,
  SectionType,
} from "./types.ts";

type JsonRecord = Record<string, unknown>;

export interface SpecialistResultsV2 {
  identity: CaseIdentityV2;
  classification: CaseClassificationV2;
  facts: CaseFactsV2;
  procedure: CaseProcedureV2;
  analysis: CaseAnalysisV2;
  authorities: CaseAuthoritiesV2;
  outcome: CaseOutcomeV2;
  reviewFlags: string[];
  audits: PipelineStageAuditV2[];
  raw: {
    identity: JsonRecord;
    factsProcedure: JsonRecord;
    analysis: JsonRecord;
    authorities: JsonRecord;
    outcome: JsonRecord;
  };
}

const IDENTITY_TYPES = new Set<SectionType>([
  "caption", "court_header", "case_metadata", "appearances", "procedural_history",
]);
const FACT_PROCEDURE_TYPES = new Set<SectionType>([
  "procedural_history", "facts", "witness_evidence", "documentary_evidence",
  "appellant_submissions", "respondent_submissions", "applicant_submissions",
  "respondent_public_body_submissions", "prosecution_submissions",
  "defence_submissions", "other_party_submissions", "findings_of_fact",
  "court_analysis", "holding", "disposition", "remedy",
]);
const ANALYSIS_TYPES = new Set<SectionType>([
  "facts", "court_analysis", "findings_of_fact", "legal_findings", "holding",
  "ratio_decidendi", "obiter_dictum", "dissent", "concurrence", "disposition",
]);
const AUTHORITY_TYPES = new Set<SectionType>([
  "legal_framework", "quoted_legislation", "quoted_authority", "court_analysis",
  "legal_findings", "holding", "ratio_decidendi", "obiter_dictum", "dissent",
  "concurrence", "disposition", "remedy", "sentence",
]);
const OUTCOME_TYPES = new Set<SectionType>([
  "holding", "disposition", "remedy", "sentence", "damages", "costs",
]);

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function obj(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function paragraphRange(
  source: JudgmentSourceV2,
  span: SectionSpanV2,
): JudgmentParagraphV2[] {
  const start = source.paragraphs.findIndex((paragraph) => paragraph.id === span.startParagraphId);
  const end = source.paragraphs.findIndex((paragraph) => paragraph.id === span.endParagraphId);
  if (start < 0 || end < start) return [];
  return source.paragraphs.slice(start, end + 1);
}

function sectionPayload(
  source: JudgmentSourceV2,
  map: SectionMapV2,
  types: ReadonlySet<SectionType>,
  fallback: "head" | "tail" | "all" | "none",
): JsonRecord[] {
  const selected = map.spans
    .filter((span) => types.has(span.sectionType))
    .map((span) => ({
      sectionId: span.id,
      sectionType: span.sectionType,
      speakerRole: span.speakerRole,
      heading: span.heading,
      isQuotedMaterial: span.isQuotedMaterial,
      quotedSourceType: span.quotedSourceType,
      confidence: span.confidence,
      paragraphs: paragraphRange(source, span).map((paragraph) => ({
        id: paragraph.id,
        ordinal: paragraph.ordinal,
        text: paragraph.text,
      })),
    }))
    .filter((section) => section.paragraphs.length > 0);

  const included = new Set(selected.flatMap((section) => section.paragraphs.map((paragraph) => paragraph.id)));
  let fallbackParagraphs: JudgmentParagraphV2[] = [];
  if (fallback === "head") fallbackParagraphs = source.paragraphs.slice(0, 60);
  if (fallback === "tail") fallbackParagraphs = source.paragraphs.slice(-100);
  if (fallback === "all" && source.characterCount <= 220_000) fallbackParagraphs = source.paragraphs;

  const additional = fallbackParagraphs.filter((paragraph) => !included.has(paragraph.id));
  if (additional.length) {
    selected.push({
      sectionId: `FALLBACK_${fallback.toUpperCase()}`,
      sectionType: "other",
      speakerRole: "unknown",
      heading: "Context fallback — do not override explicit section attribution",
      isQuotedMaterial: false,
      quotedSourceType: "none",
      confidence: 0.25,
      paragraphs: additional.map((paragraph) => ({
        id: paragraph.id,
        ordinal: paragraph.ordinal,
        text: paragraph.text,
      })),
    });
  }
  return selected;
}

function agentPayload(
  source: JudgmentSourceV2,
  sectionMap: SectionMapV2,
  sections: JsonRecord[],
  contract: string,
): string {
  return JSON.stringify({
    contract,
    source: {
      sourceTitle: source.sourceTitle,
      sourceUrl: source.sourceUrl,
      sourceDatabase: source.sourceDatabase,
      languageHint: source.languageHint,
      sourceHash: source.sourceHash,
      paragraphCount: source.paragraphs.length,
    },
    sectionMapVersion: sectionMap.version,
    sectionReviewFlags: sectionMap.reviewFlags,
    sections,
  });
}

async function runAgent(
  stage: string,
  schema: { name: string; schema: JsonRecord },
  system: string,
  user: string,
  effort: ReasoningEffort,
  options: { signal?: AbortSignal; model?: string },
): Promise<{ data: JsonRecord; audit: PipelineStageAuditV2 }> {
  const startedAt = new Date().toISOString();
  const response = await createStructuredResponse({
    stage,
    schemaName: schema.name,
    schema: schema.schema,
    system,
    user,
    effort,
    model: options.model,
    timeoutMs: 185_000,
    signal: options.signal,
  });
  return {
    data: response.data,
    audit: {
      stage,
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

function validatedIdentity(
  raw: JsonRecord,
  context: EvidenceValidationContext,
  flags: Set<string>,
): { identity: CaseIdentityV2; classification: CaseClassificationV2 } {
  const identityRaw = obj(raw.identity);
  const classificationRaw = obj(raw.classification);
  const v = <T>(value: unknown, path: string, fallback: T) => {
    const result = validateExtractedField(value, path, fallback, context);
    result.reviewFlags.forEach((flag) => flags.add(flag));
    return result.field;
  };
  return {
    identity: {
      caseName: v(identityRaw.caseName, "identity.caseName", ""),
      shortName: v(identityRaw.shortName, "identity.shortName", ""),
      citation: v(identityRaw.citation, "identity.citation", ""),
      ecli: v(identityRaw.ecli, "identity.ecli", ""),
      docket: v(identityRaw.docket, "identity.docket", ""),
      caseNumber: v(identityRaw.caseNumber, "identity.caseNumber", ""),
      joinedCaseNumbers: v(identityRaw.joinedCaseNumbers, "identity.joinedCaseNumbers", [] as string[]),
      decisionDate: v(identityRaw.decisionDate, "identity.decisionDate", ""),
      court: v(identityRaw.court, "identity.court", ""),
      courtLevel: v(identityRaw.courtLevel, "identity.courtLevel", "unknown" as const),
      jurisdiction: v(identityRaw.jurisdiction, "identity.jurisdiction", ""),
      language: v(identityRaw.language, "identity.language", ""),
      era: v(identityRaw.era, "identity.era", "unknown" as const),
      judges: v(identityRaw.judges, "identity.judges", []),
      authoringJudges: v(identityRaw.authoringJudges, "identity.authoringJudges", [] as string[]),
      parties: v(identityRaw.parties, "identity.parties", []),
      appearances: v(identityRaw.appearances, "identity.appearances", []),
    },
    classification: {
      caseFamily: v(classificationRaw.caseFamily, "classification.caseFamily", "unknown" as const),
      legalAreas: v(classificationRaw.legalAreas, "classification.legalAreas", []),
      primaryLegalArea: v(classificationRaw.primaryLegalArea, "classification.primaryLegalArea", "unknown" as const),
      proceedingType: v(classificationRaw.proceedingType, "classification.proceedingType", "unknown" as const),
      proceduralPosture: v(classificationRaw.proceduralPosture, "classification.proceduralPosture", "unknown" as const),
      courtLevel: v(classificationRaw.courtLevel, "classification.courtLevel", "unknown" as const),
      caseTypeLabels: v(classificationRaw.caseTypeLabels, "classification.caseTypeLabels", [] as string[]),
      applicationTypes: v(classificationRaw.applicationTypes, "classification.applicationTypes", [] as string[]),
      writsRequested: v(classificationRaw.writsRequested, "classification.writsRequested", [] as string[]),
      subjectMatter: v(classificationRaw.subjectMatter, "classification.subjectMatter", [] as string[]),
    },
  };
}

function validatedFactsProcedure(
  raw: JsonRecord,
  context: EvidenceValidationContext,
  flags: Set<string>,
): { facts: CaseFactsV2; procedure: CaseProcedureV2 } {
  const factsRaw = obj(raw.facts);
  const procedureRaw = obj(raw.procedure);
  const v = <T>(value: unknown, path: string, fallback: T) => {
    const result = validateExtractedField(value, path, fallback, context);
    result.reviewFlags.forEach((flag) => flags.add(flag));
    return result.field;
  };
  return {
    facts: {
      summary: v(factsRaw.summary, "facts.summary", ""),
      materialFacts: v(factsRaw.materialFacts, "facts.materialFacts", []),
      chronology: v(factsRaw.chronology, "facts.chronology", []),
      witnessesAndEvidence: v(factsRaw.witnessesAndEvidence, "facts.witnessesAndEvidence", []),
      undisputedFacts: v(factsRaw.undisputedFacts, "facts.undisputedFacts", [] as string[]),
      disputedFacts: v(factsRaw.disputedFacts, "facts.disputedFacts", [] as string[]),
    },
    procedure: {
      proceduralHistory: v(procedureRaw.proceduralHistory, "procedure.proceduralHistory", ""),
      originatingProceeding: v(procedureRaw.originatingProceeding, "procedure.originatingProceeding", ""),
      lowerCourtDecision: v(procedureRaw.lowerCourtDecision, "procedure.lowerCourtDecision", ""),
      groundsOrIssues: v(procedureRaw.groundsOrIssues, "procedure.groundsOrIssues", []),
      reliefSought: v(procedureRaw.reliefSought, "procedure.reliefSought", []),
      submissionsByParty: v(procedureRaw.submissionsByParty, "procedure.submissionsByParty", []),
    },
  };
}

function validatedAnalysis(
  raw: JsonRecord,
  context: EvidenceValidationContext,
  flags: Set<string>,
): CaseAnalysisV2 {
  const analysisRaw = obj(raw.analysis);
  const v = <T>(value: unknown, path: string, fallback: T) => {
    const result = validateExtractedField(value, path, fallback, context);
    result.reviewFlags.forEach((flag) => flags.add(flag));
    return result.field;
  };
  return {
    legalIssues: v(analysisRaw.legalIssues, "analysis.legalIssues", []),
    dominantIssue: v(analysisRaw.dominantIssue, "analysis.dominantIssue", ""),
    findings: v(analysisRaw.findings, "analysis.findings", []),
    holding: v(analysisRaw.holding, "analysis.holding", ""),
    ratioDecidendi: v(analysisRaw.ratioDecidendi, "analysis.ratioDecidendi", []),
    legalPrincipleSummary: v(analysisRaw.legalPrincipleSummary, "analysis.legalPrincipleSummary", ""),
    secondaryPrinciples: v(analysisRaw.secondaryPrinciples, "analysis.secondaryPrinciples", []),
    obiterDicta: v(analysisRaw.obiterDicta, "analysis.obiterDicta", [] as string[]),
    legalTestsAndStandards: v(analysisRaw.legalTestsAndStandards, "analysis.legalTestsAndStandards", [] as string[]),
    burdenAndStandardOfProof: v(analysisRaw.burdenAndStandardOfProof, "analysis.burdenAndStandardOfProof", [] as string[]),
    credibilityFindings: v(analysisRaw.credibilityFindings, "analysis.credibilityFindings", [] as string[]),
    dissentOrConcurrence: v(analysisRaw.dissentOrConcurrence, "analysis.dissentOrConcurrence", []),
  };
}

function validatedAuthorities(
  raw: JsonRecord,
  context: EvidenceValidationContext,
  flags: Set<string>,
): CaseAuthoritiesV2 {
  const authorityRaw = obj(raw.authorities);
  const v = <T>(value: unknown, path: string, fallback: T) => {
    const result = validateExtractedField(value, path, fallback, context);
    result.reviewFlags.forEach((flag) => flags.add(flag));
    return result.field;
  };
  return {
    legislation: v(authorityRaw.legislation, "authorities.legislation", []),
    primaryLegislation: v(authorityRaw.primaryLegislation, "authorities.primaryLegislation", []),
    secondaryLegislation: v(authorityRaw.secondaryLegislation, "authorities.secondaryLegislation", []),
    authorities: v(authorityRaw.authorities, "authorities.authorities", []),
  };
}

function validatedOutcome(
  raw: JsonRecord,
  context: EvidenceValidationContext,
  flags: Set<string>,
): CaseOutcomeV2 {
  const outcomeRaw = obj(raw.outcome);
  const v = <T>(value: unknown, path: string, fallback: T) => {
    const result = validateExtractedField(value, path, fallback, context);
    result.reviewFlags.forEach((flag) => flags.add(flag));
    return result.field;
  };
  return {
    overallOutcome: v(outcomeRaw.overallOutcome, "outcome.overallOutcome", "unknown" as const),
    scope: v(outcomeRaw.scope, "outcome.scope", ""),
    dispositionText: v(outcomeRaw.dispositionText, "outcome.dispositionText", ""),
    components: v(outcomeRaw.components, "outcome.components", []),
    orders: v(outcomeRaw.orders, "outcome.orders", [] as string[]),
    remedies: v(outcomeRaw.remedies, "outcome.remedies", [] as string[]),
    sentence: v(outcomeRaw.sentence, "outcome.sentence", []),
    monetaryAwards: v(outcomeRaw.monetaryAwards, "outcome.monetaryAwards", []),
    costs: v(outcomeRaw.costs, "outcome.costs", []),
    remittalInstructions: v(outcomeRaw.remittalInstructions, "outcome.remittalInstructions", [] as string[]),
  };
}

export async function runSpecialistAgents(
  source: JudgmentSourceV2,
  sectionMap: SectionMapV2,
  options: { signal?: AbortSignal; model?: string } = {},
): Promise<SpecialistResultsV2> {
  const context = buildEvidenceContext(source, sectionMap);
  const identityUser = agentPayload(source, sectionMap, sectionPayload(source, sectionMap, IDENTITY_TYPES, "head"), "nomologies.identity.v2");
  const factsUser = agentPayload(source, sectionMap, sectionPayload(source, sectionMap, FACT_PROCEDURE_TYPES, "all"), "nomologies.facts-procedure.v2");
  const analysisUser = agentPayload(source, sectionMap, sectionPayload(source, sectionMap, ANALYSIS_TYPES, "all"), "nomologies.analysis.v2");
  const authoritiesUser = agentPayload(source, sectionMap, sectionPayload(source, sectionMap, AUTHORITY_TYPES, "none"), "nomologies.authorities.v2");
  const outcomeUser = agentPayload(source, sectionMap, sectionPayload(source, sectionMap, OUTCOME_TYPES, "tail"), "nomologies.outcome.v2");

  const [identityResponse, factsResponse, analysisResponse, authorityResponse, outcomeResponse] = await Promise.all([
    runAgent("identity-classification", NOMOLOGIES_SCHEMAS.identity, IDENTITY_SYSTEM_PROMPT, identityUser, "medium", options),
    runAgent("facts-procedure", NOMOLOGIES_SCHEMAS.factsProcedure, FACTS_PROCEDURE_SYSTEM_PROMPT, factsUser, "medium", options),
    runAgent("judicial-analysis", NOMOLOGIES_SCHEMAS.analysis, ANALYSIS_SYSTEM_PROMPT, analysisUser, "high", options),
    runAgent("legislation-authorities", NOMOLOGIES_SCHEMAS.authorities, AUTHORITIES_SYSTEM_PROMPT, authoritiesUser, "medium", options),
    runAgent("outcome-orders", NOMOLOGIES_SCHEMAS.outcome, OUTCOME_SYSTEM_PROMPT, outcomeUser, "high", options),
  ]);

  const flags = new Set<string>(sectionMap.reviewFlags);
  const identity = validatedIdentity(identityResponse.data, context, flags);
  const factsProcedure = validatedFactsProcedure(factsResponse.data, context, flags);
  const analysis = validatedAnalysis(analysisResponse.data, context, flags);
  const authorities = validatedAuthorities(authorityResponse.data, context, flags);
  const outcome = validatedOutcome(outcomeResponse.data, context, flags);

  return {
    identity: identity.identity,
    classification: identity.classification,
    facts: factsProcedure.facts,
    procedure: factsProcedure.procedure,
    analysis,
    authorities,
    outcome,
    reviewFlags: [...flags].sort(),
    audits: [
      identityResponse.audit,
      factsResponse.audit,
      analysisResponse.audit,
      authorityResponse.audit,
      outcomeResponse.audit,
    ],
    raw: {
      identity: identityResponse.data,
      factsProcedure: factsResponse.data,
      analysis: analysisResponse.data,
      authorities: authorityResponse.data,
      outcome: outcomeResponse.data,
    },
  };
}
