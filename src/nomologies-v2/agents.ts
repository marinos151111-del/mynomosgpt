import {
  createStructuredResponseWithRetry,
  nomologiesMiniModel,
  nomologiesProfile,
  type ReasoningEffort,
} from "./openai-responses.ts";
import {
  ANALYSIS_SYSTEM_PROMPT,
  AUTHORITIES_SYSTEM_PROMPT,
  FACTS_SYSTEM_PROMPT,
  DEFERRED_CHRONOLOGY_SYSTEM_PROMPT,
  DEFERRED_WITNESSES_SYSTEM_PROMPT,
  IDENTITY_SYSTEM_PROMPT,
  OUTCOME_SYSTEM_PROMPT,
  PROCEDURE_SYSTEM_PROMPT,
} from "./prompts.ts";
import { NOMOLOGIES_SCHEMAS } from "./schemas.ts";
import { reconcileNomologiesQuality } from "./quality.ts";
import { isBareHoldingResult } from "./quality-core.ts";
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
  EvidenceAnchorV2,
  GroundOrIssueV2,
  OutcomeComponentV2,
  JudgmentParagraphV2,
  JudgmentSourceV2,
  PipelineStageAuditV2,
  SectionMapV2,
  SectionSpanV2,
  SectionType,
  ExtractedFieldV2,
  TimelineEventV2,
  EvidenceOrWitnessV2,
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

export type SpecialistAgentKindV2 =
  | "identity"
  | "facts"
  | "procedure"
  | "analysis"
  | "authorities"
  | "outcome";

export interface SpecialistAgentRunV2 {
  kind: SpecialistAgentKindV2;
  raw: JsonRecord;
  audit: PipelineStageAuditV2;
}

export interface SpecialistRepairBriefV2 {
  previousOutput: JsonRecord;
  conflicts: Array<{
    code: string;
    severity: string;
    fieldPath: string;
    message: string;
  }>;
}

const IDENTITY_TYPES = new Set<SectionType>([
  "caption", "court_header", "case_metadata", "appearances", "procedural_history",
]);
const FACT_TYPES = new Set<SectionType>([
  "facts", "witness_evidence", "documentary_evidence", "findings_of_fact",
]);
const PROCEDURE_TYPES = new Set<SectionType>([
  "caption", "case_metadata", "facts",
  "procedural_history",
  "appellant_submissions", "respondent_submissions", "applicant_submissions",
  "respondent_public_body_submissions", "prosecution_submissions",
  "defence_submissions", "other_party_submissions", "findings_of_fact",
  "court_analysis", "holding", "disposition", "remedy", "costs",
]);
const ANALYSIS_TYPES = new Set<SectionType>([
  "facts", "legal_framework", "court_analysis", "findings_of_fact", "legal_findings", "holding",
  "ratio_decidendi", "obiter_dictum", "dissent", "concurrence", "disposition",
]);
const AUTHORITY_TYPES = new Set<SectionType>([
  "case_metadata", "facts", "procedural_history", "documentary_evidence",
  "appellant_submissions", "respondent_submissions", "applicant_submissions",
  "respondent_public_body_submissions", "prosecution_submissions",
  "defence_submissions", "other_party_submissions",
  "legal_framework", "quoted_legislation", "quoted_authority", "adopted_authority", "court_analysis",
  "legal_findings", "holding", "ratio_decidendi", "obiter_dictum", "dissent",
  "concurrence", "disposition", "remedy", "sentence",
]);
const OUTCOME_TYPES = new Set<SectionType>([
  "court_analysis", "legal_findings", "holding", "disposition", "remedy", "sentence", "damages", "costs",
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
  repair?: SpecialistRepairBriefV2,
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
    ...(repair ? {
      repair: {
        instruction: "Correct the identified fields from source evidence and return the complete specialist schema.",
        previousOutput: repair.previousOutput,
        conflicts: repair.conflicts,
      },
    } : {}),
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
  // Each specialist is a separate durable task. No individual model call may
  // consume the whole Edge Function wall-clock budget.
  const timeoutMs = 165_000;
  const response = await createStructuredResponseWithRetry({
    stage,
    schemaName: schema.name,
    schema: schema.schema,
    system,
    user,
    effort,
    model: options.model,
    fallbackModel: nomologiesMiniModel(),
    timeoutMs,
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
    withdrawnOrAbandoned: v(outcomeRaw.withdrawnOrAbandoned, "outcome.withdrawnOrAbandoned", [] as string[]),
  };
}

const PRESENT_OUTCOME_RE = /(?:η|η παρούσα|το|ο)\s*(?:έφεση|αίτηση|προσφυγή|αναφορά|ένσταση)\s+(?:απορρίπ|επιτρέπ|γίνεται\s+δεκτ|έγινε\s+δεκτ|withdrawn|dismissed|allowed)/iu;

function removeOutcomeClauses(value: string): string {
  const pieces = String(value || "")
    .split(/(?<=[.!;··])\s+|\s*[·;]\s*/u)
    .map((piece) => piece.trim())
    .filter(Boolean)
    .filter((piece) => !PRESENT_OUTCOME_RE.test(piece));
  return pieces.join(". ").replace(/\.{2,}/g, ".").trim();
}

function clearFieldFlags(flags: Set<string>, paths: string[]): void {
  for (const flag of [...flags]) {
    if (paths.some((path) => flag.startsWith(`${path}:`))) flags.delete(flag);
  }
}

function resultAnchorNumber(anchor: EvidenceAnchorV2): string {
  const match = anchor.quote.match(/λόγ(?:ος|οι)\s+(?:έφεσης\s+)?(\d{1,3})/iu);
  return match?.[1] || "";
}

function explicitGroundResultAnchors(procedure: CaseProcedureV2): EvidenceAnchorV2[] {
  return procedure.groundsOrIssues.evidence.filter((anchor) =>
    /λόγ(?:ος|οι)\s+(?:έφεσης\s+)?\d+/iu.test(anchor.quote) &&
    /(απορρίπ|δεν\s+ευσταθ|δεν\s+ευστατεί|γίνεται\s+δεκτ|έγινε\s+δεκτ|επιτρέπ|μερικώς)/iu.test(anchor.quote)
  );
}

function outcomeCodeForGround(result: GroundOrIssueV2["result"]): OutcomeComponentV2["result"] | "" {
  if (result === "failed") return "dismissed";
  if (result === "succeeded") return "allowed";
  if (result === "partly_succeeded") return "partly_allowed";
  return "";
}

function buildHoldingText(grounds: GroundOrIssueV2[]): string {
  const resolved = grounds.filter((ground) => outcomeCodeForGround(ground.result));
  if (!resolved.length) return "";
  return resolved.map((ground) => {
    const label = ground.number ? `Λόγος ${ground.number}` : (ground.title || "Ζήτημα");
    if (ground.result === "failed") return `${label}: απορρίφθηκε`;
    if (ground.result === "succeeded") return `${label}: έγινε δεκτός`;
    return `${label}: έγινε εν μέρει δεκτός`;
  }).join("· ") + ".";
}

function cumulativeLowerCourtDecision(procedure: CaseProcedureV2): CaseProcedureV2["lowerCourtDecision"] | null {
  if (procedure.lowerCourtDecision.status !== "conflicted") return null;
  const orderEvidence = procedure.lowerCourtDecision.evidence.filter((anchor) =>
    /(διατάχ|ακύρω|μεταβίβ|εγγραφ|επιδικά)/iu.test(anchor.quote)
  );
  if (orderEvidence.length < 2) return null;
  const kinds = new Set<string>();
  for (const anchor of orderEvidence) {
    if (/ακύρω/iu.test(anchor.quote)) kinds.add("cancellation");
    if (/μεταβίβ/iu.test(anchor.quote)) kinds.add("transfer");
    if (/εγγραφ/iu.test(anchor.quote)) kinds.add("registration");
    if (/επιδικά/iu.test(anchor.quote)) kinds.add("award");
  }
  if (kinds.size < 2) return null;
  const value = `Το πρωτόδικο Δικαστήριο εξέδωσε σωρευτικά τις ακόλουθες διαταγές: ${orderEvidence.map((anchor, index) => `(${index + 1}) ${anchor.quote}`).join(" ")}`;
  return {
    status: "available",
    value,
    confidence: Math.max(0.9, procedure.lowerCourtDecision.confidence),
    evidence: orderEvidence,
    conflicts: [],
  };
}

function reconcileSpecialistFields(input: {
  facts: CaseFactsV2;
  procedure: CaseProcedureV2;
  analysis: CaseAnalysisV2;
  outcome: CaseOutcomeV2;
  flags: Set<string>;
}): void {
  const { facts, procedure, analysis, outcome, flags } = input;

  if (facts.summary.status === "available") {
    const cleaned = removeOutcomeClauses(facts.summary.value);
    const evidence = facts.summary.evidence.filter((anchor) => anchor.sectionType !== "disposition" && anchor.sectionType !== "remedy" && anchor.sectionType !== "costs");
    if (cleaned && evidence.length) {
      facts.summary = { ...facts.summary, value: cleaned, evidence };
      clearFieldFlags(flags, ["facts.summary"]);
    }
  }

  if (procedure.proceduralHistory.status === "available") {
    const cleaned = removeOutcomeClauses(procedure.proceduralHistory.value);
    const evidence = procedure.proceduralHistory.evidence.filter((anchor) => anchor.sectionType !== "disposition" && anchor.sectionType !== "remedy" && anchor.sectionType !== "costs");
    if (cleaned && evidence.length) {
      procedure.proceduralHistory = { ...procedure.proceduralHistory, value: cleaned, evidence };
      clearFieldFlags(flags, ["procedure.proceduralHistory"]);
    }
  }

  const lowerCourt = cumulativeLowerCourtDecision(procedure);
  if (lowerCourt) {
    procedure.lowerCourtDecision = lowerCourt;
    clearFieldFlags(flags, ["procedure.lowerCourtDecision"]);
  }

  const explicitAnchors = explicitGroundResultAnchors(procedure);
  const grounds = procedure.groundsOrIssues.status === "available" ? procedure.groundsOrIssues.value : [];
  if (grounds.length && explicitAnchors.length) {
    const holdingText = buildHoldingText(grounds);
    // Ground results are a verification fallback, not the lawyer-written
    // holding.  Preserve a reasoned specialist/whole-judgment synthesis and
    // replace only an empty or already-bare value.
    if (
      holdingText &&
      (analysis.holding.status !== "available" || isBareHoldingResult(analysis.holding.value))
    ) {
      analysis.holding = {
        status: "available",
        value: holdingText,
        confidence: 0.98,
        evidence: explicitAnchors,
        conflicts: [],
      };
      clearFieldFlags(flags, ["analysis.holding"]);
    }

    const existing = new Map(outcome.components.status === "available"
      ? outcome.components.value.map((component) => [component.groundOrIssue.toLocaleLowerCase("el"), component])
      : []);
    const components: OutcomeComponentV2[] = outcome.components.status === "available" ? [...outcome.components.value] : [];
    const componentEvidence = outcome.components.status === "available" ? [...outcome.components.evidence] : [];
    for (const ground of grounds) {
      const result = outcomeCodeForGround(ground.result);
      if (!result || !ground.number) continue;
      const key = `λόγος έφεσης ${ground.number}`.toLocaleLowerCase("el");
      if (existing.has(key)) continue;
      const anchor = explicitAnchors.find((item) => resultAnchorNumber(item) === ground.number);
      if (!anchor) continue;
      const component: OutcomeComponentV2 = {
        target: `Λόγος έφεσης ${ground.number}`,
        groundOrIssue: `λόγος έφεσης ${ground.number}`,
        result,
        remedy: "",
        orderText: anchor.quote,
      };
      components.push(component);
      componentEvidence.push(anchor);
      existing.set(key, component);
    }
    if (components.length) {
      outcome.components = {
        status: "available",
        value: components.sort((left, right) => left.target.localeCompare(right.target, "el", { numeric: true })),
        confidence: Math.max(0.97, outcome.components.confidence),
        evidence: [...new Map(componentEvidence.map((anchor) => [`${anchor.paragraphIds.join(",")}|${anchor.quote}`, anchor])).values()],
        conflicts: [],
      };
      clearFieldFlags(flags, ["outcome.components"]);
    }
  }

  const dominantNeedsRepair = analysis.dominantIssue.status !== "available" ||
    [...flags].some((flag) => flag.startsWith("analysis.dominantIssue:"));
  if (dominantNeedsRepair && analysis.legalIssues.status === "available" && analysis.legalIssues.value.length) {
    const primary = analysis.legalIssues.value.find((issue) => issue.centrality === "primary") || analysis.legalIssues.value[0];
    const evidence = analysis.legalIssues.evidence.filter((anchor) => anchor.sectionType !== "disposition");
    if (primary?.issue && evidence.length) {
      analysis.dominantIssue = {
        status: "available",
        value: primary.issue,
        confidence: 0.96,
        evidence,
        conflicts: [],
      };
      clearFieldFlags(flags, ["analysis.dominantIssue"]);
    }
  }

  const principleNeedsRepair = analysis.legalPrincipleSummary.status !== "available" ||
    [...flags].some((flag) => flag.startsWith("analysis.legalPrincipleSummary:"));
  if (principleNeedsRepair && analysis.ratioDecidendi.status === "available" && analysis.ratioDecidendi.evidence.length) {
    const principles = analysis.ratioDecidendi.value
      .map((item) => item.principle.trim())
      .filter(Boolean);
    const selected: string[] = [];
    for (const principle of principles) {
      const candidate = [...selected, principle].join(" ");
      if (selected.length && candidate.length > 760) break;
      selected.push(principle);
      if (selected.length === 3) break;
    }
    if (selected.length) {
      analysis.legalPrincipleSummary = {
        status: "available",
        value: selected.join(" "),
        confidence: Math.max(0.95, analysis.ratioDecidendi.confidence),
        evidence: [...analysis.ratioDecidendi.evidence],
        conflicts: [],
      };
      clearFieldFlags(flags, ["analysis.legalPrincipleSummary"]);
    }
  }
}

function specialistConfig(kind: SpecialistAgentKindV2): {
  stage: string;
  schema: { name: string; schema: JsonRecord };
  system: string;
  types: ReadonlySet<SectionType>;
  fallback: "head" | "tail" | "all" | "none";
  contract: string;
} {
  if (kind === "identity") return {
    stage: "identity-classification", schema: NOMOLOGIES_SCHEMAS.identity,
    system: IDENTITY_SYSTEM_PROMPT, types: IDENTITY_TYPES, fallback: "head",
    contract: "nomologies.identity.v2",
  };
  if (kind === "facts") return {
    stage: "material-facts", schema: NOMOLOGIES_SCHEMAS.facts,
    system: FACTS_SYSTEM_PROMPT, types: FACT_TYPES, fallback: "none",
    contract: "nomologies.facts.v2",
  };
  if (kind === "procedure") return {
    stage: "procedure-grounds", schema: NOMOLOGIES_SCHEMAS.procedure,
    system: PROCEDURE_SYSTEM_PROMPT, types: PROCEDURE_TYPES, fallback: "none",
    contract: "nomologies.procedure.v2",
  };
  if (kind === "analysis") return {
    stage: "judicial-analysis", schema: NOMOLOGIES_SCHEMAS.analysis,
    system: ANALYSIS_SYSTEM_PROMPT, types: ANALYSIS_TYPES, fallback: "none",
    contract: "nomologies.analysis.v2",
  };
  if (kind === "authorities") return {
    stage: "legislation-authorities", schema: NOMOLOGIES_SCHEMAS.authorities,
    system: AUTHORITIES_SYSTEM_PROMPT, types: AUTHORITY_TYPES, fallback: "none",
    contract: "nomologies.authorities.v2",
  };
  return {
    stage: "outcome-orders", schema: NOMOLOGIES_SCHEMAS.outcome,
    system: OUTCOME_SYSTEM_PROMPT, types: OUTCOME_TYPES, fallback: "tail",
    contract: "nomologies.outcome.v2",
  };
}

export async function runSpecialistAgent(
  kind: SpecialistAgentKindV2,
  source: JudgmentSourceV2,
  sectionMap: SectionMapV2,
  options: { signal?: AbortSignal; model?: string; repair?: SpecialistRepairBriefV2 } = {},
): Promise<SpecialistAgentRunV2> {
  const config = specialistConfig(kind);
  const user = agentPayload(
    source,
    sectionMap,
    sectionPayload(source, sectionMap, config.types, config.fallback),
    config.contract,
    options.repair,
  );
  const repairSystem = options.repair
    ? `${config.system}\n\nSECOND-PASS REPAIR\nAn independent verifier identified the supplied conflicts. Re-check each one against the source. Correct only what the source proves, preserve supported content, and return the complete specialist schema. Never repair by guessing.`
    : config.system;
  // Elite tiering: legal nuance (facts, procedure, judicial analysis) runs on
  // the flagship model with medium reasoning; mechanical header/outcome reading
  // stays flagship at low effort; citation linking may use the mini model in
  // the economy profile. An explicit model pin overrides everything.
  const economy = nomologiesProfile() === "economy";
  const nuanced = kind === "analysis" || kind === "facts" || kind === "procedure";
  const stageModel = options.model || (kind === "authorities" && economy ? nomologiesMiniModel() : undefined);
  const response = await runAgent(
    options.repair ? `repair-${config.stage}` : config.stage,
    config.schema,
    repairSystem,
    user,
    nuanced ? "medium" : "low",
    { ...options, model: stageModel },
  );
  return { kind, raw: response.data, audit: response.audit };
}

export async function runDeferredFieldAgent(
  kind: "chronology" | "witnessesAndEvidence",
  source: JudgmentSourceV2,
  sectionMap: SectionMapV2,
  options: { signal?: AbortSignal; model?: string } = {},
): Promise<ExtractedFieldV2<TimelineEventV2[] | EvidenceOrWitnessV2[]>> {
  const chronology = kind === "chronology";
  const schema = chronology ? NOMOLOGIES_SCHEMAS.deferredChronology : NOMOLOGIES_SCHEMAS.deferredWitnesses;
  const system = chronology ? DEFERRED_CHRONOLOGY_SYSTEM_PROMPT : DEFERRED_WITNESSES_SYSTEM_PROMPT;
  const user = agentPayload(
    source,
    sectionMap,
    sectionPayload(source, sectionMap, FACT_TYPES, "none"),
    chronology ? "nomologies.deferred.chronology.v1" : "nomologies.deferred.witnesses.v1",
  );
  const response = await runAgent(
    chronology ? "deferred-chronology" : "deferred-witnesses-evidence",
    schema,
    system,
    user,
    "low",
    { ...options, model: options.model || (nomologiesProfile() === "economy" ? nomologiesMiniModel() : undefined) },
  );
  const raw = obj(response.data);
  const context = buildEvidenceContext(source, sectionMap);
  const path = chronology ? "facts.chronology" : "facts.witnessesAndEvidence";
  const value = chronology ? raw.chronology : raw.witnessesAndEvidence;
  return validateExtractedField(value, path, [], context).field as ExtractedFieldV2<TimelineEventV2[] | EvidenceOrWitnessV2[]>;
}

// ECLI court codes are an EU-wide public standard, and «(YYYY) N Α.Α.Δ. p» /
// "(YYYY) N C.L.R. p" are the official Cyprus reporter citations. Law-report
// pages carry these instead of a formal court caption, so when the model
// cannot ground the deciding court, derive it deterministically from those
// verbatim lines.
const ECLI_RE = /ECLI:CY:(AD|DOD|EDD|AAP):\d{4}:[A-Z]?\d+/i;
const REPORTER_CITATION_RE = /\(\d{4}\)\s+\d\s+(?:Α\.?Α\.?Δ\.?|C\.?\s?L\.?\s?R\.?)\s+\d+/u;

export function groundIdentityFromCitations(
  identity: CaseIdentityV2,
  source: JudgmentSourceV2,
  context: EvidenceValidationContext,
  flags: Set<string>,
): void {
  const head = source.paragraphs.slice(0, 40);
  const anchorFor = (paragraph: JudgmentParagraphV2, quote: string, field: string): EvidenceAnchorV2 => {
    const span = context.sectionByParagraphId.get(paragraph.id);
    return {
      id: `EV_${field}_citation_derived`,
      paragraphIds: [paragraph.id],
      quote,
      sectionType: span?.sectionType || "case_metadata",
      speakerRole: span?.speakerRole || "court",
      supports: [field],
      exactMatch: true,
    };
  };
  const isAvailable = (field: { status: string }) => field.status === "available";
  const ecliParagraph = head.find((paragraph) => ECLI_RE.test(paragraph.text));
  const ecliMatch = ecliParagraph?.text.match(ECLI_RE) || null;
  const citationParagraph = head.find((paragraph) => REPORTER_CITATION_RE.test(paragraph.text));
  const citationMatch = citationParagraph?.text.match(REPORTER_CITATION_RE) || null;

  if (!isAvailable(identity.court) && (ecliMatch || citationMatch)) {
    const paragraph = (ecliMatch ? ecliParagraph : citationParagraph) as JudgmentParagraphV2;
    const quote = ecliMatch ? ecliMatch[0] : (citationMatch as RegExpMatchArray)[0];
    identity.court = {
      status: "available",
      value: "Ανώτατο Δικαστήριο",
      confidence: 0.97,
      evidence: [anchorFor(paragraph, quote, "identity.court")],
      conflicts: [],
    };
    clearFieldFlags(flags, ["identity.court"]);
    flags.add("identity.court:derived_from_official_citation");
  }
  if (!isAvailable(identity.ecli) && ecliMatch && ecliParagraph) {
    identity.ecli = {
      status: "available",
      value: ecliMatch[0],
      confidence: 0.99,
      evidence: [anchorFor(ecliParagraph, ecliMatch[0], "identity.ecli")],
      conflicts: [],
    };
    clearFieldFlags(flags, ["identity.ecli"]);
  }
  if (!isAvailable(identity.citation) && citationMatch && citationParagraph) {
    identity.citation = {
      status: "available",
      value: citationMatch[0],
      confidence: 0.98,
      evidence: [anchorFor(citationParagraph, citationMatch[0], "identity.citation")],
      conflicts: [],
    };
    clearFieldFlags(flags, ["identity.citation"]);
  }
}

export function combineSpecialistAgentResults(
  source: JudgmentSourceV2,
  sectionMap: SectionMapV2,
  runs: SpecialistAgentRunV2[],
): SpecialistResultsV2 {
  const byKind = new Map<SpecialistAgentKindV2, SpecialistAgentRunV2>(runs.map((run) => [run.kind, run]));
  const required: SpecialistAgentKindV2[] = ["identity", "facts", "procedure", "analysis", "authorities", "outcome"];
  for (const kind of required) {
    if (!byKind.has(kind)) throw new Error(`SPECIALIST_RESULT_MISSING:${kind}`);
  }

  const raw = (kind: SpecialistAgentKindV2) => byKind.get(kind)!.raw;
  const context = buildEvidenceContext(source, sectionMap);
  const flags = new Set<string>(sectionMap.reviewFlags);
  const identity = validatedIdentity(raw("identity"), context, flags);
  groundIdentityFromCitations(identity.identity, source, context, flags);
  const factsProcedure = validatedFactsProcedure({
    facts: obj(raw("facts").facts),
    procedure: obj(raw("procedure").procedure),
  }, context, flags);
  const analysis = validatedAnalysis(raw("analysis"), context, flags);
  const authorities = validatedAuthorities(raw("authorities"), context, flags);
  const outcome = validatedOutcome(raw("outcome"), context, flags);

  reconcileSpecialistFields({
    facts: factsProcedure.facts,
    procedure: factsProcedure.procedure,
    analysis,
    outcome,
    flags,
  });
  reconcileNomologiesQuality({
    source,
    context,
    classification: identity.classification,
    procedure: factsProcedure.procedure,
    analysis,
    authorities,
    outcome,
    flags,
  });

  return {
    identity: identity.identity,
    classification: identity.classification,
    facts: factsProcedure.facts,
    procedure: factsProcedure.procedure,
    analysis,
    authorities,
    outcome,
    reviewFlags: [...flags].sort(),
    audits: required.map((kind) => byKind.get(kind)!.audit),
    raw: {
      identity: raw("identity"),
      factsProcedure: { facts: obj(raw("facts").facts), procedure: obj(raw("procedure").procedure) },
      analysis: raw("analysis"),
      authorities: raw("authorities"),
      outcome: raw("outcome"),
    },
  };
}

export async function runSpecialistAgents(
  source: JudgmentSourceV2,
  sectionMap: SectionMapV2,
  options: { signal?: AbortSignal; model?: string } = {},
): Promise<SpecialistResultsV2> {
  const kinds: SpecialistAgentKindV2[] = ["identity", "facts", "procedure", "analysis", "authorities", "outcome"];
  const runs = await Promise.all(kinds.map((kind) => runSpecialistAgent(kind, source, sectionMap, options)));
  return combineSpecialistAgentResults(source, sectionMap, runs);
}
