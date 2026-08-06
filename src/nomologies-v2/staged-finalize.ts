import {
  createStructuredResponseWithRetry,
  nomologiesMiniModel,
  nomologiesProfile,
} from "./openai-responses.ts";
import { REVIEW_SYSTEM_PROMPT } from "./prompts.ts";
import { NOMOLOGIES_SCHEMAS } from "./schemas.ts";
import { collectEvidence } from "./evidence.ts";
import { detectSourceDateConflicts } from "./quality.ts";
import { provisionOwnershipConflicts } from "./deterministic-baseline.ts";
import { dedupeRecordPresentation } from "./quality-core.ts";
import { basePrecedentialWeight } from "./authority-weighting.ts";
import { buildPrincipleArchitecture } from "./principle-architecture.ts";
import {
  NOMOLOGIES_V2_VERSION,
  OUTCOME_CODES,
  type EvidenceAnchorV2,
  type ExtractedFieldV2,
  type JudgmentSourceV2,
  type NomologiesCaseRecordV2,
  type PipelineConflictV2,
  type PipelineStageAuditV2,
  type ReadinessBreakdownV2,
  type SearchTaxonomyV2,
  type SectionMapV2,
} from "./types.ts";
import type { SpecialistResultsV2 } from "./agents.ts";
import { detectConcepts } from "../nomologies-search/synonyms.ts";

type JsonRecord = Record<string, unknown>;

type FinalizeOptions = {
  runId: string;
  createdAt: string;
  priorStages?: PipelineStageAuditV2[];
  signal?: AbortSignal;
  model?: string;
  reviewPass?: "initial" | "final";
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
  const centralText = unique([
    ...fieldText(results.analysis.dominantIssue),
    ...fieldText(results.analysis.legalIssues),
    ...fieldText(results.analysis.legalPrincipleSummary),
    ...fieldText(results.analysis.ratioDecidendi),
    ...fieldText(results.analysis.secondaryPrinciples),
    ...fieldText(results.analysis.legalTestsAndStandards),
    ...fieldText(results.analysis.holding),
    ...fieldText(results.procedure.groundsOrIssues),
  ]).join("\n");
  const centralConcepts = detectConcepts(centralText);
  const issueTags = unique(centralConcepts
    .filter((concept) => ["area", "principle", "evidence", "remedy", "institution"].includes(concept.type))
    .map((concept) => concept.label)).slice(0, 24);
  const principleGroups = unique(centralConcepts
    .filter((concept) => ["principle", "evidence"].includes(concept.type))
    .map((concept) => concept.label)).slice(0, 24);
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
  const appealLike = results.classification.proceedingType.value === "appeal" || /(?:έφεση|appeal)/iu.test(source.sourceTitle);
  if (appealLike && !available(results.procedure.proceduralHistory)) add("PROCEDURAL_HISTORY_UNVERIFIED","material","procedure.proceduralHistory","The route to the appellate judgment is stated in the source but missing from the record.");
  if (!available(results.analysis.legalIssues)) add("LEGAL_ISSUES_UNVERIFIED","critical","analysis.legalIssues","The issues decided are not evidence-grounded.");
  if (!available(results.analysis.holding)) add("HOLDING_UNVERIFIED","critical","analysis.holding","The holding is not evidence-grounded.");
  if (!available(results.analysis.legalPrincipleSummary) && !available(results.analysis.ratioDecidendi)) add("LEGAL_PRINCIPLE_UNVERIFIED","critical","analysis.legalPrincipleSummary","No legal principle or ratio is evidence-grounded.");
  const principleText = unique([
    ...fieldText(results.analysis.legalPrincipleSummary),
    ...fieldText(results.analysis.ratioDecidendi),
  ]).join(" ");
  if (/^(?:κατά\s+πόσον|εάν|αν|whether|if)\b/iu.test(principleText.replace(/^[\s"“”'‘’]+/u,""))) {
    add("ISSUE_AS_LEGAL_PRINCIPLE","material","analysis.legalPrincipleSummary","Το εμφανιζόμενο ratio/αρχή είναι νομικό ερώτημα και όχι ο εφαρμοστέος κανόνας δικαίου.");
  }
  if (!available(results.outcome.overallOutcome) || results.outcome.overallOutcome.value === "unknown") add("OUTCOME_UNVERIFIED","critical","outcome.overallOutcome","The final outcome is not evidence-grounded.");
  if (!available(results.outcome.dispositionText)) add("DISPOSITION_UNVERIFIED","critical","outcome.dispositionText","The operative order is not evidence-grounded.");
  if (available(results.outcome.dispositionText)) {
    const tailIds = new Set(source.paragraphs.slice(-120).map((paragraph) => paragraph.id));
    const operativeEvidence = results.outcome.dispositionText.evidence.some((anchor) =>
      anchor.paragraphIds.some((id) => tailIds.has(id)) &&
      /(?:έφεση|αίτηση|appeal|application|judgment|απόφαση|έξοδ|costs?|ζημι|damages?|επανεκδίκ|retrial|remitt)[\s\S]{0,260}(?:απορρίπ|επιτυγχ|επιτρέπ|γίνεται\s+δεκτ|παραμερίζ|επιδικάζ|allowed|dismissed|set\s+aside|award)/iu.test(anchor.quote)
    );
    if (!operativeEvidence) add("FINAL_ORDER_NOT_OPERATIVE_EVIDENCE","critical","outcome.dispositionText","Το τελικό αποτέλεσμα δεν συνδέεται με παράγραφο του διατακτικού της παρούσας απόφασης.");
  }
  if (!available(results.classification.primaryLegalArea)) add("PRIMARY_LEGAL_AREA_UNVERIFIED","material","classification.primaryLegalArea","The immediate primary legal area is not evidence-grounded.");
  if (!available(results.classification.proceedingType)) add("PROCEEDING_TYPE_UNVERIFIED","material","classification.proceedingType","The immediate proceeding type is not evidence-grounded.");
  const explicitLegislation = source.paragraphs.some((paragraph) => /(?:άρθρ(?:ο|ου|ων)|article|section|regulation|rule)\s+\d/iu.test(paragraph.text));
  if (explicitLegislation && !available(results.authorities.legislation)) add("LEGISLATION_OMITTED","material","authorities.legislation","The judgment expressly identifies legislation or a numbered provision, but the structured legislation field is empty.");
  output.push(...provisionOwnershipConflicts(source,map,results.authorities.legislation));
  if (available(results.authorities.authorities)) {
    const resultStylePoint = results.authorities.authorities.value.find((authority) =>
      /^(?:το|η|ο)\s+.{3,180}\s+κρίθηκε\s+ότι\b|^(?:the|this)\s+.{3,180}\s+(?:was|were)\s+held\s+to\b/iu.test(authority.legalPoint.trim())
    );
    if (resultStylePoint) add(
      "AUTHORITY_POINT_NOT_GENERAL",
      "material",
      "authorities.authorities",
      `Η σύνοψη της παραπεμπόμενης απόφασης «${resultStylePoint.name}» περιγράφεται ως ειδικό αποτέλεσμα αντί ως γενική νομική αρχή.`,
    );
  }
  if (
    available(results.outcome.costs) &&
    available(results.outcome.dispositionText) &&
    !/(?:έξοδ|costs?|ΦΠΑ|VAT)/iu.test(results.outcome.dispositionText.value)
  ) add(
    "DISPOSITION_COSTS_OMITTED",
    "material",
    "outcome.dispositionText",
    "Το πλήρες διατακτικό δεν περιλαμβάνει την εκφρασμένη διαταγή εξόδων, ποσού ή ΦΠΑ.",
  );
  const partyOutcomeOrders = source.paragraphs.filter((paragraph) =>
    /(?:έφεση|appeal)\s+(?:εναντίον|κατά|against)\s+.{1,120}(?:αποσύρ|withdrawn|επιτυγχ|allowed|succeeds?|απορρίπ|dismissed)/iu.test(paragraph.text)
  );
  if (partyOutcomeOrders.length > 1) {
    const partyComponents = available(results.outcome.components)
      ? results.outcome.components.value.filter((item) => item.target && !/(?:λόγος|ground)/iu.test(item.target))
      : [];
    if (partyComponents.length < partyOutcomeOrders.length) add(
      "MIXED_OUTCOME_COMPONENTS_MISSING",
      "critical",
      "outcome.components",
      "Το διατακτικό περιέχει διαφορετικά αποτελέσματα ανά διάδικο, αλλά δεν έχουν αποθηκευθεί όλα ως χωριστά δομημένα στοιχεία.",
    );
  }
  output.push(...detectSourceDateConflicts(source));
  return output;
}

function severityRank(value: PipelineConflictV2["severity"]): number {
  return value === "critical" ? 3 : value === "material" ? 2 : 1;
}

function circularFamily(conflict: PipelineConflictV2): string {
  if (/PROVISION_(?:WRONG_STATUTE|OWNERSHIP_UNVERIFIED)/.test(conflict.code)) return `${conflict.fieldPath}|ownership|${conflict.message}`;
  if (/(?:UNVERIFIED|UNGROUNDED|MISSING|EVIDENCE|OMITTED)/i.test(`${conflict.code} ${conflict.message}`)) {
    return `${conflict.fieldPath}|evidence`;
  }
  return `${conflict.fieldPath}|${conflict.code}|${conflict.message}`;
}

export function collapseCircularConflicts(conflicts: PipelineConflictV2[]): PipelineConflictV2[] {
  const output = new Map<string, PipelineConflictV2>();
  for (const conflict of conflicts) {
    const key = circularFamily(conflict);
    const current = output.get(key);
    if (!current || severityRank(conflict.severity) > severityRank(current.severity)) output.set(key,{...conflict});
    else current.evidenceIds = [...new Set([...current.evidenceIds,...conflict.evidenceIds])];
  }
  return [...output.values()];
}

export function readinessAssessment(
  source: JudgmentSourceV2,
  results: SpecialistResultsV2,
  map: SectionMapV2,
  rawConflicts: PipelineConflictV2[],
  recommendationInput: string,
): ReadinessBreakdownV2 {
  const recommendation = (["approve","review","reject"].includes(recommendationInput) ? recommendationInput : "review") as ReadinessBreakdownV2["recommendation"];
  const referenceVerified = [results.identity.caseNumber,results.identity.docket,results.identity.citation,results.identity.ecli].some(available);
  const appealLike = /(?:έφεση|appeal)/iu.test(source.sourceTitle) || /appeal/iu.test(String(results.classification.proceedingType.value || ""));
  const component = (key:string,label:string,earned:number,possible:number) => ({key,label,earned,possible,verified:earned===possible});
  const components = [
    component("source","Επίσημη πηγή",officialCyLaw(source.sourceUrl)?6:source.sourceDatabase==="uploaded_text"?3:0,6),
    component("structure","Δομή απόφασης",map.coverageComplete&&map.overlapFree?8:0,8),
    component("identity","Ταυτότητα",(available(results.identity.caseName)?4:0)+(available(results.identity.decisionDate)?4:0)+(available(results.identity.court)?4:0)+(referenceVerified?4:0)+(available(results.identity.judges)?3:0),19),
    component("classification","Νομική ταξινόμηση",(available(results.classification.primaryLegalArea)?3:0)+(available(results.classification.proceedingType)?3:0)+(available(results.classification.courtLevel)?2:0),8),
    component("facts","Πραγματικά περιστατικά",available(results.facts.summary)?7:0,7),
    component("procedure","Διαδικαστική ιστορία",!appealLike||available(results.procedure.proceduralHistory)?5:0,5),
    component("issues","Νομικό ζήτημα",available(results.analysis.legalIssues)?8:0,8),
    component("holding","Κρίση",available(results.analysis.holding)?8:0,8),
    component("principle","Ratio / αρχή",available(results.analysis.legalPrincipleSummary)||available(results.analysis.ratioDecidendi)?8:0,8),
    component("authorities","Νομοθεσία και αρχές",available(results.authorities.legislation)||available(results.authorities.authorities)?6:0,6),
    component("outcome","Τελικό διατακτικό",(available(results.outcome.overallOutcome)?7:0)+(available(results.outcome.dispositionText)?8:0),15),
  ];
  const richness = Math.min(4,[results.facts.materialFacts,results.facts.chronology,results.procedure.groundsOrIssues,results.analysis.findings,results.analysis.legalTestsAndStandards,results.outcome.components,results.outcome.orders,results.outcome.costs].filter(available).length);
  components.push(component("richness","Δομημένο βάθος",richness,4));
  if (recommendation === "approve") components.push(component("review","Ανεξάρτητος έλεγχος",3,3));

  const conflicts = collapseCircularConflicts(rawConflicts);
  const critical = conflicts.filter((item)=>item.severity==="critical");
  const material = conflicts.filter((item)=>item.severity==="material");
  const minor = conflicts.filter((item)=>item.severity==="minor");
  const deductions = [
    critical.length ? {severity:"critical" as const,points:Math.min(36,18+Math.max(0,critical.length-1)*6),codes:critical.map((item)=>item.code)} : null,
    material.length ? {severity:"material" as const,points:Math.min(15,material.length*5),codes:material.map((item)=>item.code)} : null,
    minor.length ? {severity:"minor" as const,points:Math.min(5,minor.length),codes:minor.map((item)=>item.code)} : null,
  ].filter(Boolean) as ReadinessBreakdownV2["deductions"];
  const baseScore = Math.min(100,components.reduce((sum,item)=>sum+item.earned,0));
  let finalScore = Math.max(0,Math.min(100,Math.round(baseScore-deductions.reduce((sum,item)=>sum+item.points,0))));
  if (recommendation === "reject") finalScore = Math.min(69,finalScore);
  else if (recommendation !== "approve") finalScore = Math.min(89,finalScore);
  return {baseScore,finalScore,components,deductions,blockers:conflicts.filter((item)=>item.severity!=="minor"),recommendation};
}

export function scoreReadiness(source: JudgmentSourceV2, results: SpecialistResultsV2, map: SectionMapV2, conflicts: PipelineConflictV2[], recommendation: string): number {
  return readinessAssessment(source,results,map,conflicts,recommendation).finalScore;
}

function extractionConfidence(results: SpecialistResultsV2): number {
  const fields = [
    results.identity.caseName,results.identity.decisionDate,results.identity.court,results.identity.judges,
    results.facts.summary,results.procedure.proceduralHistory,results.analysis.legalIssues,results.analysis.holding,
    results.analysis.legalPrincipleSummary,results.analysis.ratioDecidendi,results.authorities.legislation,
    results.authorities.authorities,results.outcome.overallOutcome,results.outcome.dispositionText,results.outcome.costs,
  ].filter(available);
  if (!fields.length) return 0;
  return Math.round(fields.reduce((sum,field)=>sum+Math.max(0,Math.min(1,Number(field.confidence)||0)),0)/fields.length*100);
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

function falseCumulativeOrderConflict(
  conflict: PipelineConflictV2,
  source: JudgmentSourceV2,
  specialists: SpecialistResultsV2,
): boolean {
  if (conflict.fieldPath !== "procedure.lowerCourtDecision.value") return false;
  if (!/(?:αντικρου|αντίφα|same object|ίδιο αντικείμενο|δεν μπορούν να συνυπάρχουν)/iu.test(conflict.message)) return false;
  if (!available(specialists.procedure.lowerCourtDecision)) return false;
  const value = specialists.procedure.lowerCourtDecision.value;
  if (!/1\s*\/\s*3|ενός\s+τρίτου/iu.test(value) || !/\b\d{2,5}\s*(?:τ\.?\s*μ\.?|m2|m²)/iu.test(value)) return false;
  const shareOrder = source.paragraphs.some((paragraph) =>
    /(?:ακύρω|μεταβίβ|εγγραφ)/iu.test(paragraph.text) && /1\s*\/\s*3|ενός\s+τρίτου/iu.test(paragraph.text)
  );
  const measuredOrder = source.paragraphs.some((paragraph) =>
    /(?:διατάχ|εγγραφ)/iu.test(paragraph.text) && /\b\d{2,5}\s*(?:τ\.?\s*μ\.?|m2|m²)/iu.test(paragraph.text)
  );
  return shareOrder && measuredOrder;
}

export async function finalizeNomologiesRecordV2(
  source: JudgmentSourceV2,
  sectionMap: SectionMapV2,
  specialists: SpecialistResultsV2,
  options: FinalizeOptions,
): Promise<{ record: NomologiesCaseRecordV2; reviewer: JsonRecord; audit: PipelineStageAuditV2 }> {
  const taxonomy = buildTaxonomy(specialists);
  const principleArchitecture = buildPrincipleArchitecture(specialists.analysis);
  const deterministic = deterministicConflicts(source,specialists,sectionMap);
  const evidence = collectEvidence({
    identity:specialists.identity,classification:specialists.classification,facts:specialists.facts,
    procedure:specialists.procedure,analysis:specialists.analysis,authorities:specialists.authorities,outcome:specialists.outcome,
  }) as EvidenceAnchorV2[];
  const required = new Set<string>();
  const completeReviewSource = source.characterCount <= 240_000;
  (completeReviewSource ? source.paragraphs : source.paragraphs.slice(0,45)).forEach((p) => required.add(p.id));
  source.paragraphs.slice(-90).forEach((p) => required.add(p.id));
  evidence.forEach((anchor) => anchor.paragraphIds.forEach((id) => required.add(id)));
  const reviewUser = JSON.stringify({
    contract:`nomologies.review.${options.reviewPass || "final"}.v2`,
    source:{sourceTitle:source.sourceTitle,sourceUrl:source.sourceUrl,sourceHash:source.sourceHash},
    sourceCoverage:{complete:completeReviewSource,includedParagraphs:required.size,totalParagraphs:source.paragraphs.length},
    sectionMap,
    extracted:{identity:specialists.identity,classification:specialists.classification,facts:specialists.facts,procedure:specialists.procedure,analysis:specialists.analysis,authorities:specialists.authorities,outcome:specialists.outcome,taxonomy},
    deterministicConflicts:deterministic,
    sourceParagraphs:source.paragraphs.filter((p) => required.has(p.id)).map((p) => ({id:p.id,ordinal:p.ordinal,text:p.text})),
  });
  const startedAt = new Date().toISOString();
  const reviewStage = options.reviewPass === "initial" ? "independent-verification" : "final-legal-review";
  const reviewSystem = options.reviewPass === "final"
    ? `${REVIEW_SYSTEM_PROMPT}\n\nFINAL PASS\nThis record has already completed an initial verification and any targeted repair. Re-check the repaired fields, identify every remaining material omission, and approve only if the complete record is evidence-grounded.`
    : REVIEW_SYSTEM_PROMPT;
  const response = await createStructuredResponseWithRetry({
    stage:reviewStage,schemaName:NOMOLOGIES_SCHEMAS.review.name,schema:NOMOLOGIES_SCHEMAS.review.schema,
    system:reviewSystem,user:reviewUser,effort:"low",
    model:options.model || (nomologiesProfile() === "economy" ? nomologiesMiniModel() : undefined),
    fallbackModel:nomologiesMiniModel(),timeoutMs:110_000,signal:options.signal,
  });
  const audit: PipelineStageAuditV2 = {
    stage:reviewStage,status:"completed",model:response.model,responseId:response.responseId,
    startedAt,completedAt:new Date().toISOString(),elapsedMs:response.elapsedMs,inputCharacters:reviewUser.length,
    outputCharacters:JSON.stringify(response.data).length,errorCode:"",
  };
  const validIds = new Set([...evidence.map((item) => item.id),...source.paragraphs.map((p) => p.id)]);
  const conflictMap = new Map<string,PipelineConflictV2>();
  const reviewedConflicts = reviewerConflicts(response.data,validIds)
    .filter((conflict) => !falseCumulativeOrderConflict(conflict, source, specialists));
  for (const conflict of [...deterministic,...reviewedConflicts]) {
    const key = conflict.code === "SOURCE_DATE_CONFLICT" ? conflict.code : `${conflict.code}|${conflict.fieldPath}|${conflict.message}`;
    const current = conflictMap.get(key);
    if (!current) conflictMap.set(key,conflict);
    else current.evidenceIds = [...new Set([...current.evidenceIds,...conflict.evidenceIds])];
  }
  const conflicts = collapseCircularConflicts([...conflictMap.values()]);
  const rawRecommendation = text(response.data.publishRecommendation) || "review";
  const critical = conflicts.some((item) => item.severity === "critical");
  const recommendation = rawRecommendation === "reject" && !critical ? "review" : rawRecommendation;
  const readinessBreakdown = readinessAssessment(source,specialists,sectionMap,conflicts,recommendation);
  const readinessScore = readinessBreakdown.finalScore;
  // A record is strict-ready when its core legal skeleton is evidence-grounded
  // and nothing critical remains. Material caveats and a cautious "review"
  // recommendation flag the record for attention without disqualifying it;
  // only an explicit reject blocks.
  const strictReady = readinessScore >= 75 && !critical && recommendation !== "reject" &&
    available(specialists.identity.caseName) && available(specialists.analysis.holding) &&
    (available(specialists.analysis.legalPrincipleSummary) || available(specialists.analysis.ratioDecidendi)) &&
    available(specialists.outcome.dispositionText) && available(specialists.outcome.overallOutcome) &&
    (OUTCOME_CODES as readonly string[]).includes(String(specialists.outcome.overallOutcome.value));
  const now = new Date().toISOString();
  const finalRecord: NomologiesCaseRecordV2 = {
    schemaVersion:NOMOLOGIES_V2_VERSION,runId:options.runId,source,sectionMap,
    identity:specialists.identity,classification:specialists.classification,facts:specialists.facts,
    procedure:specialists.procedure,analysis:specialists.analysis,authorities:specialists.authorities,outcome:specialists.outcome,
    taxonomy,principleArchitecture,allEvidence:evidence,conflicts,
    reviewFlags:unique([...specialists.reviewFlags,...sectionMap.reviewFlags,...conflicts.map((item) => item.code)]),
    extractionConfidenceScore:extractionConfidence(specialists),readinessScore,readinessBreakdown,
    precedentialWeight:basePrecedentialWeight(String(specialists.classification.courtLevel.value || "unknown")),strictReady,humanReviewRequired:true,
    stages:[...(options.priorStages || []),...specialists.audits,audit],createdAt:options.createdAt,updatedAt:now,
  };
  dedupeRecordPresentation(finalRecord as unknown as Record<string, unknown>);
  return {
    record:finalRecord,
    reviewer:{...response.data,effectivePublishRecommendation:recommendation,rawPublishRecommendation:rawRecommendation},
    audit,
  };
}
