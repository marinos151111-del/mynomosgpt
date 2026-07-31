import type {
  EvidenceAnchorV2,
  ExtractedFieldV2,
  NomologiesCaseRecordV2,
} from "../nomologies-v2/types.ts";
import { buildSmartTags } from "./tags.ts";
import { legalTextVariants, normalizeCaseNumber, normalizeLegalText, parseYear } from "./normalize.ts";
import {
  NOMOLOGIES_SEARCH_VERSION,
  type SearchDocumentV1,
  type SearchFieldNameV1,
  type WeightedSearchFieldV1,
} from "./types.ts";

type UnknownField = ExtractedFieldV2<unknown>;

function available(field: UnknownField): boolean {
  if (field.status !== "available") return false;
  if (typeof field.value === "string") return field.value.trim().length > 0;
  if (Array.isArray(field.value)) return field.value.length > 0;
  return field.value !== null && field.value !== undefined;
}

function ids(evidence: EvidenceAnchorV2[] = []): string[] {
  return [...new Set(evidence.flatMap((anchor) => anchor.paragraphIds).filter((id) => id && id !== "TITLE"))];
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(stringify).filter(Boolean).join(" · ");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  return [
    record.name,
    record.citation,
    record.ecli,
    record.issue,
    record.determination,
    record.title,
    record.description,
    record.fact,
    record.significance,
    record.principle,
    record.applicationToFacts,
    record.finding,
    record.summary,
    record.treatmentByCourt,
    record.legalPoint,
    record.proposition,
    record.display,
    record.normalized,
    record.event,
    record.date,
    record.orderText,
    record.remedy,
    record.amount,
    record.payer,
    record.payee,
    record.sentence,
    record.offence,
  ].map(stringify).filter(Boolean).join(" · ");
}

function fieldText(field: UnknownField): string {
  return available(field) ? stringify(field.value) : "";
}

function joinFields(fields: UnknownField[]): { text: string; paragraphIds: string[] } {
  return {
    text: fields.map(fieldText).filter(Boolean).join("\n"),
    paragraphIds: [...new Set(fields.flatMap((field) => ids(field.evidence)))],
  };
}

function weightedField(
  name: SearchFieldNameV1,
  weight: number,
  fields: UnknownField[],
  extras: string[] = [],
): WeightedSearchFieldV1 | null {
  const joined = joinFields(fields);
  const text = [...extras, joined.text].map((item) => String(item || "").trim()).filter(Boolean).join("\n");
  if (!text) return null;
  return {
    name,
    text,
    normalized: normalizeLegalText(text),
    weight,
    paragraphIds: joined.paragraphIds,
  };
}

function value<T>(field: ExtractedFieldV2<T>, fallback: T): T {
  return available(field) ? field.value : fallback;
}

function yearOf(record: NomologiesCaseRecordV2): number | null {
  return parseYear(value(record.identity.decisionDate, "")) || parseYear(value(record.identity.citation, "")) || parseYear(record.source.sourceTitle);
}

export function buildSearchDocument(record: NomologiesCaseRecordV2): SearchDocumentV1 {
  const title = value(record.identity.caseName, record.source.sourceTitle || "Ανώνυμη απόφαση");
  const shortTitle = value(record.identity.shortName, title);
  const citation = value(record.identity.citation, "");
  const caseNumber = value(record.identity.caseNumber, value(record.identity.docket, ""));
  const aliases = [...new Set([
    title,
    shortTitle,
    citation,
    caseNumber,
    value(record.identity.docket, ""),
    value(record.identity.ecli, ""),
    ...(record.taxonomy?.aliases || []),
  ].flatMap(legalTextVariants).filter(Boolean))];

  const authorityText = available(record.authorities.authorities)
    ? record.authorities.authorities.value.map((authority) => [
      authority.name,
      authority.citation,
      authority.ecli,
      authority.treatment,
      authority.citationContext,
      authority.legalPoint,
    ].filter(Boolean).join(" · ")).join("\n")
    : "";

  const provisionText = available(record.authorities.legislation)
    ? record.authorities.legislation.value.map((instrument) => [
      instrument.lawLabel,
      instrument.lawId,
      instrument.instrumentName,
      instrument.role,
      instrument.primary ? "primary" : "contextual",
      instrument.proposition,
      ...instrument.provisions.flatMap((provision) => [
        provision.display,
        provision.normalized,
        provision.application,
      ]),
    ].filter(Boolean).join(" · ")).join("\n")
    : "";

  const identityExtra = [
    title,
    shortTitle,
    citation,
    caseNumber,
    value(record.identity.ecli, ""),
    value(record.identity.court, ""),
    ...value(record.identity.judges, []).map((judge) => judge.name),
    ...value(record.identity.authoringJudges, []),
    ...value(record.identity.parties, []).map((party) => `${party.name} ${party.role}`),
  ];

  const fields = [
    weightedField("identity", 16, [record.identity.caseName, record.identity.shortName, record.identity.citation, record.identity.caseNumber, record.identity.ecli, record.identity.parties, record.identity.judges], identityExtra),
    weightedField("principle", 13, [record.analysis.legalPrincipleSummary, record.analysis.legalTestsAndStandards, record.analysis.secondaryPrinciples]),
    weightedField("ratio", 12, [record.analysis.ratioDecidendi]),
    weightedField("holding", 11, [record.analysis.holding, record.analysis.findings]),
    weightedField("issues", 10, [record.analysis.dominantIssue, record.analysis.legalIssues, record.procedure.groundsOrIssues]),
    weightedField("provisions", 12, [record.authorities.legislation, record.authorities.primaryLegislation, record.authorities.secondaryLegislation], [provisionText]),
    weightedField("authorities", 8, [record.authorities.authorities], [authorityText]),
    weightedField("outcome", 10, [record.outcome.overallOutcome, record.outcome.dispositionText, record.outcome.components, record.outcome.orders, record.outcome.remedies, record.outcome.sentence, record.outcome.costs]),
    weightedField("procedure", 7, [record.procedure.proceduralHistory, record.procedure.originatingProceeding, record.procedure.lowerCourtDecision, record.procedure.reliefSought, record.procedure.submissionsByParty, record.classification.proceedingType, record.classification.proceduralPosture]),
    weightedField("facts", 6, [record.facts.summary, record.facts.materialFacts, record.facts.undisputedFacts, record.facts.disputedFacts]),
    weightedField("evidence", 5, [record.facts.witnessesAndEvidence, record.analysis.credibilityFindings, record.analysis.burdenAndStandardOfProof]),
    weightedField("chronology", 3.5, [record.facts.chronology]),
  ].filter(Boolean) as WeightedSearchFieldV1[];

  const smartTags = buildSmartTags(record);
  const legalAreas = value(record.classification.legalAreas, []);
  const outcome = value(record.outcome.overallOutcome, "" as const);
  const lawIds = available(record.authorities.legislation)
    ? [...new Set(record.authorities.legislation.value.map((instrument) => instrument.lawId || instrument.lawLabel).filter(Boolean))]
    : [];
  const provisionKeys = available(record.authorities.legislation)
    ? [...new Set(record.authorities.legislation.value.flatMap((instrument) => instrument.provisions.map((provision) => normalizeLegalText(`${instrument.lawId || instrument.lawLabel} ${provision.normalized || provision.display}`))).filter(Boolean))]
    : [];
  const authorityTreatments = available(record.authorities.authorities)
    ? [...new Set(record.authorities.authorities.value.map((authority) => authority.treatment))]
    : [];
  const authorityContexts = available(record.authorities.authorities)
    ? [...new Set(record.authorities.authorities.value.map((authority) => authority.citationContext))]
    : [];

  const criticalConflicts = record.conflicts.filter((conflict) => conflict.severity === "critical").length;
  const materialConflicts = record.conflicts.filter((conflict) => conflict.severity === "material").length;

  return {
    schemaVersion: NOMOLOGIES_SEARCH_VERSION,
    id: record.source.sourceHash || record.runId,
    runId: record.runId,
    sourceUrl: record.source.sourceUrl,
    sourceHash: record.source.sourceHash,
    title,
    shortTitle,
    citation,
    caseNumber,
    decisionDate: value(record.identity.decisionDate, ""),
    year: yearOf(record),
    court: value(record.identity.court, ""),
    judges: value(record.identity.judges, []).map((judge) => judge.name),
    authoringJudges: value(record.identity.authoringJudges, []),
    outcome,
    aliases,
    exactTerms: [...new Set([
      caseNumber ? normalizeCaseNumber(caseNumber) : "",
      citation ? normalizeLegalText(citation) : "",
      value(record.identity.ecli, ""),
      ...provisionKeys,
    ].filter(Boolean))],
    smartTags,
    facets: {
      caseFamily: value(record.classification.caseFamily, "" as const),
      legalAreas,
      primaryLegalArea: value(record.classification.primaryLegalArea, "" as const),
      proceedingType: value(record.classification.proceedingType, "" as const),
      proceduralPosture: value(record.classification.proceduralPosture, "" as const),
      courtLevel: value(record.classification.courtLevel, "" as const),
      court: value(record.identity.court, ""),
      year: yearOf(record),
      judges: value(record.identity.judges, []).map((judge) => judge.name),
      authoringJudges: value(record.identity.authoringJudges, []),
      outcomes: outcome ? [outcome] : [],
      lawIds,
      provisionKeys,
      authorityTreatments,
      authorityContexts,
    },
    fields,
    quality: {
      readinessScore: record.readinessScore,
      strictReady: record.strictReady,
      humanReviewRequired: record.humanReviewRequired,
      criticalConflicts,
      materialConflicts,
      evidenceCount: record.allEvidence.length,
    },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
