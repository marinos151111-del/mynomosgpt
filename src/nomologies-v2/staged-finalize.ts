import { createStructuredResponse } from "./openai-responses.ts";
import { REVIEW_SYSTEM_PROMPT } from "./prompts.ts";
import { NOMOLOGIES_SCHEMAS } from "./schemas.ts";
import { collectEvidence } from "./evidence.ts";
import { detectSourceDateConflicts } from "./quality.ts";
import {
  NOMOLOGIES_V2_VERSION,
  OUTCOME_CODES,
  type EvidenceAnchorV2,
  type ExtractedFieldV2,
  type JudgmentSourceV2,
  type NomologiesCaseRecordV2,
  type PipelineConflictV2,
  type PipelineStageAuditV2,
  type SearchTaxonomyV2,
  type SectionMapV2,
} from "./types.ts";
import type { SpecialistResultsV2 } from "./agents.ts";

type JsonRecord = Record<string, unknown>;

type FinalizeOptions = {
  runId: string;
  createdAt: string;
  priorStages?: PipelineStageAuditV2[];
  signal?: AbortSignal;
  model?: string;
};

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.map((value) => value.trim()).filter((value) => {
    const key = value.toLocaleLowerCase("el");
    if (!value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function available(field: ExtractedFieldV2<unknown> | undefined): boolean {
  if (!field || field.status !== "available" || !Array.isArray(field.evidence) || field.evidence.length === 0) return false;
  if (typeof field.value === "string") return field.value.trim().length > 0;
  if (Array.isArray(field.value)) return field.value.length > 0;
  return field.value !== null && field.value !== undefined;
}
function fieldText(field: ExtractedFieldV2<unknown> | undefined): string[] {
  if (!available(field)) return [];
  const value = field!.value;
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    const row = record(item);
    return [row.issue,row.title,row.description,row.principle,row.finding,row.legalPoint,row.fact,row.summary,row.event]
      .map(text).filter(Boolean);
  });
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
  const subjectMatter = available(results.classification.subjectMatter) ? results.classification.subjectMatter.value : [];
  const legalAreas = available(results.classification.legalAreas) ? results.classification.legalAreas.value : [];
  const keywords = unique([...subjectMatter,...legalAreas,...issueTags,...principleGroups]).slice(0, 100);
  const aliases = unique([
    available(results.identity.caseName) ? results.identity.caseName.value : "",
    available(results.identity.shortName) ? results.identity.shortName.value : "",
    available(results.identity.citation) ? results.identity.citation.value : "",
    available(results.identity.ecli) ? results.identity.ecli.value : "",
    available(results.identity.caseNumber) ? results.identity.caseNumber.value : "",
    available(results.identity.docket) ? results.identity.docket.value : "",
  ]).slice(0, 30);
  return {
    issueTags,
    offenceTags: keywords.filter((value) => /(φόνος|ανθρωποκτον|βιασ|ληστ|κλοπ|απάτ|ναρκωτικ|assault|murder|rape|robbery|theft|fraud|drug)/iu.test(value)).slice(0,30),
    keywords,
    aliases,
    topicGroups: unique([...subjectMatter,...legalAreas]).slice(0,30),
    principleGroups,
    evidenceGroups: keywords.filter((value) => /(μαρτυρ|απόδειξ|evidence|credib|hearsay)/iu.test(value)).slice(0,20),
    procedureGroups: keywords.filter((value) => /(έφεσ|αίτησ|δικον|procedure|appeal|application|certiorari|habeas|mandamus|prohibition)/iu.test(value)).slice(0,20),
    publicLawGroups: keywords.filter((value) => /(διοικητ|συνταγμα|δημόσι|immigration|asylum|tax|customs|public|constitutional)/iu.test(value)).slice(0,20),
  };
}

function officialCyLaw(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["cylaw.org","www.cylaw.org"].includes(url.hostname);
  } catch { return false; }
}

function deterministicConflicts(source: JudgmentSourceV2, results: SpecialistResultsV2, map: SectionMapV2): PipelineConflictV2[] {
  const output: PipelineConflictV2[] = [];
  const add = (code: string, severity: PipelineConflictV2["severity"], fieldPath: string, message: string) =>
    output.push({ code, severity, fieldPath, message, evidenceIds: [] });
  if (!officialCyLaw(source.sourceUrl) && source.sourceDatabase !== "uploaded_text") add("SOURCE_NOT_OFFICIAL_CYLAW","material","source.sourceUrl","The source is not a verified CyLaw HTTPS judgment.");
  if (!map.coverageComplete || !map.overlapFree) add("SECTION_MAP_INCOMPLETE","critical","sectionMap","The section map is incomplete or overlapping.");
  if (!available(results.identity.caseName)) add("CASE_NAME_UNVERIFIED","critical","identity.caseName","The formal case name is not evidence-grounded.");
  if (!available(results.identity.decisionDate)) add("DECISION_DATE_UNVERIFIED","critical","identity.decisionDate","The judgment date is not evidence-grounded.");
  if (!available(results.identity.court)) add("COURT_UNVERIFIED","critical","identity.court","The deciding court is not evidence-grounded.");
  if (![results.identity.caseNumber,results.identity.docket,results.identity.citation,results.identity.ecli].some(available)) add("CASE_REFERENCE_UNVERIFIED","critical","identity","No case reference is evidence-grounded.");
  if (!available(results.identity.judges)) add("JUDGES_UNVERIFIED","material","identity.judges","The judicial panel is not evidence-grounded.");
  if (!available(results.facts.summary)) add("FACTS_UNVERIFIED","material","facts.summary","The facts summary is not evidence-grounded.");
  if (!available(results.analysis.legalIssues)) add("LEGAL_ISSUES_UNVERIFIED","critical","analysis.legalIssues","The issues decided are not evidence-grounded.");
  if (!available(results.analysis.holding)) add("HOLDING_UNVERIFIED","critical","analysis.holding","The holding is not evidence-grounded.");
  if (!available(results.analysis.legalPrincipleSummary) && !available(results.analysis.ratioDecidendi)) add("LEGAL_PRINCIPLE_UNVERIFIED","critical","analysis.legalPrincipleSummary","No legal principle or ratio is evidence-grounded.");
  if (!available(results.outcome.overallOutcome) || results.outcome.overallOutcome.value === "unknown") add("OUTCOME_UNVERIFIED","critical","outcome.overallOutcome","The final outcome is not evidence-grounded.");
  if (!available(results.outcome.dispositionText)) add("DISPOSITION_UNVERIFIED","critical","outcome.dispositionText","The operative order is not evidence-grounded.");
  if (!available(results.classification.primaryLegalArea)) add("PRIMARY_LEGAL_AREA_UNVERIFIED","material","classification.primaryLegalArea","The immediate primary legal area is not evidence-grounded.");
  if (!available(results.classification.proceedingType)) add("PROCEEDING_TYPE_UNVERIFIED","material","classification.proceedingType","The immediate proceeding type is not evidence-grounded.");
  output.push(...detectSourceDateConflicts(source));
  return output;
}

function scoreReadiness(results: SpecialistResultsV2, map: SectionMapV2, conflicts: PipelineConflictV2[], recommendation: string): number {
  let score = officialCyLaw((results as unknown as {source?: {sourceUrl?: string}}).source?.sourceUrl || "") ? 4 : 0;
  if (map.coverageComplete && map.overlapFree) score += 8;
  const identity = [results.identity.caseName,results.identity.decisionDate,results.identity.court,results.identity.caseNumber,results.identity.docket,results.identity.citation,results.identity.ecli,results.identity.judges];
  score += Math.round(identity.filter(available).length / identity.length * 18);
  const classification = [results.classification.caseFamily,results.classification.primaryLegalArea,results.classification.proceedingType,results.classification.proceduralPosture,results.classification.courtLevel];
  score += Math.round(classification.filter(available).length / classification.length * 7);
  const facts = [results.facts.summary,results.facts.materialFacts,results.facts.chronology];
  score += Math.round(facts.filter(available).length / facts.length * 10);
  const procedure = [results.procedure.proceduralHistory,results.procedure.originatingProceeding,results.procedure.lowerCourtDecision,results.procedure.groundsOrIssues];
  score += Math.round(procedure.filter(available).length / procedure.length * 5);
  const analysis = [results.analysis.legalIssues,results.analysis.holding,results.analysis.ratioDecidendi,results.analysis.legalPrincipleSummary,results.analysis.findings,results.analysis.legalTestsAndStandards];
  score += Math.round(analysis.filter(available).length / analysis.length * 24);
  score += Math.round([results.authorities.legislation,results.authorities.authorities].filter(available).length / 2 * 8);
  score += Math.round([results.outcome.overallOutcome,results.outcome.dispositionText,results.outcome.orders,results.outcome.costs].filter(available).length / 4 * 16);
  score -= conflicts.filter((item) => item.severity === "critical").length * 12;
  score -= conflicts.filter((item) => item.severity === "material").length * 4;
  score -= conflicts.filter((item) => item.severity === "minor").length;
  if (recommendation === "approve") score += 4;
  if (recommendation === "review") score -= 2;
  if (recommendation === "reject") score -= 8;
  return Math.max(0,Math.min(100,Math.round(score)));
}

function reviewerConflicts(payload: JsonRecord, validIds: Set<string>): PipelineConflictV2[] {
  return array(payload.conflicts).flatMap((item) => {
    const row = record(item);
    const severity = text(row.severity);
    if (!["critical","material","minor"].includes(severity)) return [];
    return [{
      code: text(row.code) || "REVIEWER_CONFLICT",
      severity: severity as PipelineConflictV2["severity"],
      fieldPath: text(row.fieldPath),
      message: text(row.message),
      evidenceIds: array(row.evidenceIds).map(text).filter((id) => validIds.has(id)),
    }];
  });
}

export async function finalizeNomologiesRecordV2(
  source: JudgmentSourceV2,
  sectionMap: SectionMapV2,
  specialists: SpecialistResultsV2,
  options: FinalizeOptions,
): Promise<{ record: NomologiesCaseRecordV2; reviewer: JsonRecord; audit: PipelineStageAuditV2 }> {
  const taxonomy = buildTaxonomy(specialists);
  const deterministic = deterministicConflicts(source,specialists,sectionMap);
  const evidence = collectEvidence({
    identity:specialists.identity,classification:specialists.classification,facts:specialists.facts,
    procedure:specialists.procedure,analysis:specialists.analysis,authorities:specialists.authorities,outcome:specialists.outcome,
  }) as EvidenceAnchorV2[];
  const required = new Set<string>();
  source.paragraphs.slice(0,45).forEach((p) => required.add(p.id));
  source.paragraphs.slice(-90).forEach((p) => required.add(p.id));
  evidence.forEach((anchor) => anchor.paragraphIds.forEach((id) => required.add(id)));
  const reviewUser = JSON.stringify({
    contract:"nomologies.review.v2",
    source:{sourceTitle:source.sourceTitle,sourceUrl:source.sourceUrl,sourceHash:source.sourceHash},
    sectionMap,
    extracted:{identity:specialists.identity,classification:specialists.classification,facts:specialists.facts,procedure:specialists.procedure,analysis:specialists.analysis,authorities:specialists.authorities,outcome:specialists.outcome,taxonomy},
    deterministicConflicts:deterministic,
    sourceParagraphs:source.paragraphs.filter((p) => required.has(p.id)).map((p) => ({id:p.id,ordinal:p.ordinal,text:p.text})),
  });
  const startedAt = new Date().toISOString();
  const response = await createStructuredResponse({
    stage:"independent-review",schemaName:NOMOLOGIES_SCHEMAS.review.name,schema:NOMOLOGIES_SCHEMAS.review.schema,
    system:REVIEW_SYSTEM_PROMPT,user:reviewUser,effort:"medium",model:options.model,timeoutMs:125_000,signal:options.signal,
  });
  const audit: PipelineStageAuditV2 = {
    stage:"independent-review",status:"completed",model:response.model,responseId:response.responseId,
    startedAt,completedAt:new Date().toISOString(),elapsedMs:response.elapsedMs,inputCharacters:reviewUser.length,
    outputCharacters:JSON.stringify(response.data).length,errorCode:"",
  };
  const validIds = new Set([...evidence.map((item) => item.id),...source.paragraphs.map((p) => p.id)]);
  const conflictMap = new Map<string,PipelineConflictV2>();
  for (const conflict of [...deterministic,...reviewerConflicts(response.data,validIds)]) {
    const key = conflict.code === "SOURCE_DATE_CONFLICT" ? conflict.code : `${conflict.code}|${conflict.fieldPath}|${conflict.message}`;
    const current = conflictMap.get(key);
    if (!current) conflictMap.set(key,conflict);
    else current.evidenceIds = [...new Set([...current.evidenceIds,...conflict.evidenceIds])];
  }
  const conflicts = [...conflictMap.values()];
  const rawRecommendation = text(response.data.publishRecommendation) || "review";
  const critical = conflicts.some((item) => item.severity === "critical");
  const recommendation = rawRecommendation === "reject" && !critical ? "review" : rawRecommendation;
  let readinessScore = scoreReadiness(specialists,sectionMap,conflicts,recommendation);
  if (officialCyLaw(source.sourceUrl)) readinessScore = Math.min(100,readinessScore + 4);
  const strictReady = readinessScore >= 90 && !critical && recommendation === "approve" &&
    available(specialists.identity.caseName) && available(specialists.analysis.holding) &&
    (available(specialists.analysis.legalPrincipleSummary) || available(specialists.analysis.ratioDecidendi)) &&
    available(specialists.outcome.dispositionText) && available(specialists.outcome.overallOutcome) &&
    (OUTCOME_CODES as readonly string[]).includes(String(specialists.outcome.overallOutcome.value));
  const now = new Date().toISOString();
  const finalRecord: NomologiesCaseRecordV2 = {
    schemaVersion:NOMOLOGIES_V2_VERSION,runId:options.runId,source,sectionMap,
    identity:specialists.identity,classification:specialists.classification,facts:specialists.facts,
    procedure:specialists.procedure,analysis:specialists.analysis,authorities:specialists.authorities,outcome:specialists.outcome,
    taxonomy,allEvidence:evidence,conflicts,
    reviewFlags:unique([...specialists.reviewFlags,...sectionMap.reviewFlags,...conflicts.map((item) => item.code)]),
    readinessScore,strictReady,humanReviewRequired:true,
    stages:[...(options.priorStages || []),...specialists.audits,audit],createdAt:options.createdAt,updatedAt:now,
  };
  return {
    record:finalRecord,
    reviewer:{...response.data,effectivePublishRecommendation:recommendation,rawPublishRecommendation:rawRecommendation},
    audit,
  };
}
