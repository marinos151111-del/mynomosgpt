import type { EvidenceValidationContext } from "./evidence.ts";
import type {
  CaseAnalysisV2,
  CaseClassificationV2,
  CaseOutcomeV2,
  CaseProcedureV2,
  EvidenceAnchorV2,
  ExtractedFieldV2,
  JudgmentParagraphV2,
  JudgmentSourceV2,
  LegalAreaV2,
  ProceedingTypeV2,
  SectionType,
  SpeakerRole,
} from "./types.ts";

const PRESENT_COURT_SPEAKERS = new Set<SpeakerRole>([
  "court",
  "authoring_judge",
  "concurring_judge",
  "dissenting_judge",
]);

const HOLDING_SECTIONS = new Set<SectionType>([
  "holding",
  "legal_findings",
  "court_analysis",
  "ratio_decidendi",
]);

const EXPLICIT_DETERMINATION_RE = /(?:απορρίπ|γίνεται\s+δεκτ|έγινε\s+δεκτ|επιτρέπ|δεν\s+(?:ευσταθ|δικαιολογ|δημιουργ(?:εί|ούν)\s+υπόβαθρο|πληροί)|είναι\s+(?:εγγενώς\s+)?απορριπτέ|κρίν(?:εται|ουμε)|καταλήγ(?:ουμε|ει)|dismiss|allow|reject|refus)/iu;

const EXPEDITION_RE = /(?:αίτηση|application)[^\n]{0,120}(?:επίσπευσ|κατά\s+προτεραιότητα|expedit)[^\n]{0,160}(?:έφεσ|appeal)|(?:επίσπευσ|expedit)[^\n]{0,100}(?:έφεσ|appeal)/iu;

export function clearQualityFlags(flags: Set<string>, paths: string[]): void {
  for (const flag of [...flags]) {
    if (paths.some((path) => flag.startsWith(`${path}:`))) flags.delete(flag);
  }
}

export function evidenceKey(anchor: EvidenceAnchorV2): string {
  return `${anchor.paragraphIds.join(",")}|${anchor.quote}`;
}

export function uniqueEvidence(anchors: EvidenceAnchorV2[]): EvidenceAnchorV2[] {
  return [...new Map(anchors.map((anchor) => [evidenceKey(anchor), anchor])).values()];
}

export function groundedField<T>(
  value: T,
  evidence: EvidenceAnchorV2[],
  confidence = 0.98,
): ExtractedFieldV2<T> {
  const anchors = uniqueEvidence(evidence);
  return {
    status: anchors.length ? "available" : "indeterminate",
    value,
    confidence: anchors.length ? confidence : 0,
    evidence: anchors,
    conflicts: [],
  };
}

export function sourceEvidence(
  context: EvidenceValidationContext,
  paragraph: JudgmentParagraphV2,
  fieldPath: string,
  supports: string[],
  quote = paragraph.text,
): EvidenceAnchorV2 | null {
  const span = context.sectionByParagraphId.get(paragraph.id);
  if (!span) return null;
  return {
    id: `EV_${fieldPath.replace(/[^a-zA-Z0-9]+/g, "_")}_det_${paragraph.ordinal}`,
    paragraphIds: [paragraph.id],
    quote,
    sectionType: span.sectionType,
    speakerRole: span.speakerRole,
    supports,
    exactMatch: true,
  };
}

export function findSourceEvidence(
  context: EvidenceValidationContext,
  pattern: RegExp,
  fieldPath: string,
  supports: string[],
  allowedSections?: ReadonlySet<SectionType>,
): EvidenceAnchorV2 | null {
  for (const paragraph of context.source.paragraphs) {
    pattern.lastIndex = 0;
    if (!pattern.test(paragraph.text)) continue;
    const span = context.sectionByParagraphId.get(paragraph.id);
    if (!span || (allowedSections && !allowedSections.has(span.sectionType))) continue;
    return sourceEvidence(context, paragraph, fieldPath, supports);
  }
  return null;
}

function reconcileExpeditionClassification(input: {
  source: JudgmentSourceV2;
  context: EvidenceValidationContext;
  classification: CaseClassificationV2;
  flags: Set<string>;
}): boolean {
  const { source, context, classification, flags } = input;
  const text = `${source.sourceTitle}\n${source.paragraphs.slice(0, 45).map((paragraph) => paragraph.text).join("\n")}`;
  EXPEDITION_RE.lastIndex = 0;
  if (!EXPEDITION_RE.test(text)) return false;

  const anchor = findSourceEvidence(
    context,
    EXPEDITION_RE,
    "classification.expedition",
    ["application for expedition of appeal"],
    new Set<SectionType>([
      "case_metadata",
      "caption",
      "procedural_history",
      "applicant_submissions",
      "appellant_submissions",
    ]),
  );
  if (!anchor) return false;

  const criminal = classification.caseFamily.value === "criminal_law" ||
    /ποινικ(?:ή|ης)?\s+έφεση|criminal\s+appeal/iu.test(text);
  const primaryArea: LegalAreaV2 = criminal ? "criminal_procedure" : "civil_procedure";
  const proceedingType: ProceedingTypeV2 = "expedition_application";
  const existingAreas: LegalAreaV2[] = classification.legalAreas.status === "available"
    ? classification.legalAreas.value
    : [];

  classification.primaryLegalArea = groundedField(primaryArea, [anchor], 0.99);
  classification.proceedingType = groundedField(proceedingType, [anchor], 0.99);
  classification.proceduralPosture = groundedField("interim_stage", [anchor], 0.99);
  classification.legalAreas = groundedField(
    [primaryArea, ...existingAreas.filter((area) => area !== primaryArea)],
    uniqueEvidence([anchor, ...classification.legalAreas.evidence]),
    0.98,
  );
  clearQualityFlags(flags, [
    "classification.primaryLegalArea",
    "classification.proceedingType",
    "classification.proceduralPosture",
    "classification.legalAreas",
  ]);
  return true;
}

function explicitNumberSupported(
  number: string,
  evidence: EvidenceAnchorV2[],
  context: EvidenceValidationContext,
): boolean {
  const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(?:λόγ(?:ος|οι)|ground|issue)\\s*(?:έφεσης\\s+)?(?:αρ\\.?\\s*)?${escaped}(?:\\b|\\D)`,
    "iu",
  );
  for (const anchor of evidence) {
    if (pattern.test(anchor.quote)) return true;
    for (const id of anchor.paragraphIds) {
      const paragraph = context.paragraphById.get(id);
      const span = context.sectionByParagraphId.get(id);
      if (!paragraph || span?.isQuotedMaterial) continue;
      if (paragraph.formatting.paragraphNumber === number && pattern.test(paragraph.text)) return true;
    }
  }
  return false;
}

function clearInventedGroundNumbers(
  procedure: CaseProcedureV2,
  context: EvidenceValidationContext,
  flags: Set<string>,
): void {
  if (procedure.groundsOrIssues.status !== "available") return;
  let changed = false;
  procedure.groundsOrIssues.value = procedure.groundsOrIssues.value.map((ground) => {
    if (!ground.number || explicitNumberSupported(ground.number, procedure.groundsOrIssues.evidence, context)) {
      return ground;
    }
    changed = true;
    return {
      ...ground,
      number: "",
      title: ground.title.replace(
        /^(?:Ground|Issue|Λόγος|Ζήτημα)\s+\d+\s*[:.\-–—]?\s*/iu,
        "",
      ).trim(),
    };
  });
  if (changed) clearQualityFlags(flags, ["procedure.groundsOrIssues"]);
}

function normalizeApplicationOutcome(
  expedition: boolean,
  outcome: CaseOutcomeV2,
  flags: Set<string>,
): void {
  if (!expedition || outcome.overallOutcome.status !== "available") return;
  const current = outcome.overallOutcome.value;
  const normalized = current === "dismissed"
    ? "application_dismissed" as const
    : current === "allowed"
    ? "application_allowed" as const
    : current === "partly_allowed"
    ? "application_partly_allowed" as const
    : null;
  if (!normalized) return;
  outcome.overallOutcome = {
    ...outcome.overallOutcome,
    value: normalized,
    confidence: Math.max(0.99, outcome.overallOutcome.confidence),
  };
  clearQualityFlags(flags, ["outcome.overallOutcome"]);
}

function reconcileRelief(
  procedure: CaseProcedureV2,
  outcome: CaseOutcomeV2,
  flags: Set<string>,
): void {
  if (procedure.reliefSought.status !== "available" || outcome.overallOutcome.status !== "available") return;
  const decision = outcome.overallOutcome.value;
  const status: "refused" | "granted" | "" =
    decision === "application_dismissed" || decision === "leave_refused"
      ? "refused"
      : decision === "application_allowed" || decision === "leave_granted"
      ? "granted"
      : "";
  if (!status) return;

  const changed = procedure.reliefSought.value.some((item) =>
    item.status === "not_determined" || item.status === "unknown"
  );
  if (!changed) return;

  procedure.reliefSought = {
    ...procedure.reliefSought,
    value: procedure.reliefSought.value.map((item) => ({
      ...item,
      status: item.status === "not_determined" || item.status === "unknown"
        ? status
        : item.status,
    })),
    confidence: Math.max(0.98, procedure.reliefSought.confidence),
    evidence: uniqueEvidence([
      ...procedure.reliefSought.evidence,
      ...outcome.overallOutcome.evidence,
      ...outcome.dispositionText.evidence,
    ]),
  };
  clearQualityFlags(flags, ["procedure.reliefSought"]);
}

function reconcileHolding(
  analysis: CaseAnalysisV2,
  context: EvidenceValidationContext,
  flags: Set<string>,
): void {
  if (analysis.holding.status !== "available") return;

  const originalEvidence = analysis.holding.evidence;
  const valid = originalEvidence.filter((anchor) => {
    const span = context.sectionByParagraphId.get(anchor.paragraphIds[0]);
    if (!span || span.isQuotedMaterial || !PRESENT_COURT_SPEAKERS.has(span.speakerRole)) return false;
    if (!HOLDING_SECTIONS.has(span.sectionType)) return false;
    return span.sectionType !== "court_analysis" || EXPLICIT_DETERMINATION_RE.test(anchor.quote);
  });
  const issueAnchors = analysis.legalIssues.status === "available"
    ? analysis.legalIssues.evidence.filter((anchor) => EXPLICIT_DETERMINATION_RE.test(anchor.quote))
    : [];
  const discovered: EvidenceAnchorV2[] = [];
  for (const paragraph of context.source.paragraphs) {
    const span = context.sectionByParagraphId.get(paragraph.id);
    if (!span || span.isQuotedMaterial || !PRESENT_COURT_SPEAKERS.has(span.speakerRole)) continue;
    if (!HOLDING_SECTIONS.has(span.sectionType) || !EXPLICIT_DETERMINATION_RE.test(paragraph.text)) continue;
    const anchor = sourceEvidence(
      context,
      paragraph,
      "analysis.holding",
      ["explicit judicial determination"],
    );
    if (anchor) discovered.push(anchor);
  }

  const evidence = uniqueEvidence([...valid, ...issueAnchors, ...discovered]).slice(0, 8);
  if (!evidence.length) return;

  const removedInvalidEvidence = valid.length !== originalEvidence.length;
  const resolvedIssues = analysis.legalIssues.status === "available"
    ? analysis.legalIssues.value.filter((item) => item.issue.trim() && item.determination.trim())
    : [];
  const value = removedInvalidEvidence && resolvedIssues.length
    ? resolvedIssues.map((item) => `${item.issue} ${item.determination}`).join(" ")
    : analysis.holding.value;

  analysis.holding = groundedField(value, evidence, Math.max(0.95, analysis.holding.confidence));
  clearQualityFlags(flags, ["analysis.holding"]);
}

function removeUnsupportedExceptionLanguage(
  analysis: CaseAnalysisV2,
  source: JudgmentSourceV2,
): void {
  if (analysis.legalPrincipleSummary.status !== "available") return;
  if (!/κατ['’]?\s*εξαίρεση/iu.test(analysis.legalPrincipleSummary.value)) return;
  if (/κατ['’]?\s*εξαίρεση/iu.test(source.cleanText)) return;

  const value = analysis.legalPrincipleSummary.value
    .replace(
      /η\s+επίσπευση\s+έφεσης\s+χορηγείται\s+κατ['’]?\s*εξαίρεση\s+και\s+με\s+βάση/iu,
      "Η επίσπευση έφεσης κρίνεται με βάση",
    )
    .replace(/\s+κατ['’]?\s*εξαίρεση\b/iu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  analysis.legalPrincipleSummary = { ...analysis.legalPrincipleSummary, value };
}

function removeReasonComponents(
  procedure: CaseProcedureV2,
  outcome: CaseOutcomeV2,
  flags: Set<string>,
): void {
  if (procedure.groundsOrIssues.status !== "available") return;
  const hasNumberedGround = procedure.groundsOrIssues.value.some((ground) => ground.number.trim().length > 0);
  if (hasNumberedGround || outcome.overallOutcome.status !== "available") return;
  if (!["application_allowed", "application_partly_allowed", "application_dismissed"].includes(outcome.overallOutcome.value)) {
    return;
  }
  outcome.components = {
    status: "unavailable",
    value: [],
    confidence: 0.99,
    evidence: [],
    conflicts: [],
  };
  clearQualityFlags(flags, ["outcome.components"]);
}

export function reconcileCoreQuality(input: {
  source: JudgmentSourceV2;
  context: EvidenceValidationContext;
  classification: CaseClassificationV2;
  procedure: CaseProcedureV2;
  analysis: CaseAnalysisV2;
  outcome: CaseOutcomeV2;
  flags: Set<string>;
}): { expedition: boolean } {
  const expedition = reconcileExpeditionClassification(input);
  normalizeApplicationOutcome(expedition, input.outcome, input.flags);
  clearInventedGroundNumbers(input.procedure, input.context, input.flags);
  reconcileRelief(input.procedure, input.outcome, input.flags);
  reconcileHolding(input.analysis, input.context, input.flags);
  removeUnsupportedExceptionLanguage(input.analysis, input.source);
  removeReasonComponents(input.procedure, input.outcome, input.flags);
  return { expedition };
}
