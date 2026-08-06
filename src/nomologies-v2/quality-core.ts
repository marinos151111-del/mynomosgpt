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
  OutcomeComponentV2,
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

const EXPLICIT_DETERMINATION_RE = /(?:απορρίπ|γίνεται\s+δεκτ|έγινε\s+δεκτ|επιτρέπ|δεν\s+(?:ευσταθ|δικαιολογ|δημιουργ(?:εί|ούν)\s+υπόβαθρο|πληροί)|ούτε[^.]{0,80}ευσταθ|είναι\s+(?:εγγενώς\s+)?απορριπτέ|κρίν(?:εται|ουμε)|καταλήγ(?:ουμε|ει)|dismiss|allow|reject|refus)/iu;

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

function explicitGroundNumbers(evidence: EvidenceAnchorV2[]): string[] {
  const numbers: string[] = [];
  for (const anchor of evidence) {
    for (const match of anchor.quote.matchAll(/λόγ(?:ος|ο|οι)\s+(?:έφεσης\s+)?(\d{1,3})/giu)) {
      if (!numbers.includes(match[1])) numbers.push(match[1]);
    }
  }
  return numbers;
}

function reconcileGroundNumbers(
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
  const printed = explicitGroundNumbers(procedure.groundsOrIssues.evidence);
  const grounds = procedure.groundsOrIssues.value;
  if (printed.length === grounds.length && grounds.some((ground) => !ground.number)) {
    procedure.groundsOrIssues.value = grounds.map((ground, index) => ({
      ...ground,
      number: ground.number || printed[index],
    }));
    changed = true;
  }
  if (changed) clearQualityFlags(flags, ["procedure.groundsOrIssues"]);
}

function titleEvidence(source: JudgmentSourceV2, fieldPath: string, quote: string): EvidenceAnchorV2 {
  return {
    id: `EV_${fieldPath.replace(/[^a-zA-Z0-9]+/g, "_")}_title`,
    paragraphIds: ["TITLE"],
    quote,
    sectionType: "caption",
    speakerRole: "court",
    supports: [fieldPath],
    exactMatch: true,
  };
}

function reconcileObviousAppealClassification(input: {
  source: JudgmentSourceV2;
  context: EvidenceValidationContext;
  classification: CaseClassificationV2;
  flags: Set<string>;
}): void {
  const { source, context, classification, flags } = input;
  const civilAppeal = source.sourceTitle.match(/(?:ΠΟΛΙΤΙΚΗ\s+ΕΦΕΣΗ|CIVIL\s+APPEAL)/iu)?.[0] || "";
  if (!civilAppeal) return;

  const appealAnchor = titleEvidence(source, "classification.proceedingType", civilAppeal);
  classification.proceedingType = groundedField("civil_appeal", [appealAnchor], 0.99);
  classification.proceduralPosture = groundedField("appeal", [appealAnchor], 0.99);
  clearQualityFlags(flags, ["classification.proceedingType", "classification.proceduralPosture"]);

  const propertyAnchor = findSourceEvidence(
    context,
    /(?:κυριότητ[^.]{0,100}(?:τεμαχ|ακινήτ)|χρησικτησ|κτηματολογ)/iu,
    "classification.primaryLegalArea",
    ["property subject matter"],
    new Set<SectionType>(["facts", "case_metadata", "procedural_history", "court_analysis", "legal_findings"]),
  );
  if (!propertyAnchor) return;

  classification.caseFamily = groundedField("private_law", [propertyAnchor], 0.99);
  classification.primaryLegalArea = groundedField("property", [propertyAnchor], 0.99);
  const existingAreas = classification.legalAreas.status === "available"
    ? classification.legalAreas.value.filter((area) => area !== "unknown" && area !== "property")
    : [];
  classification.legalAreas = groundedField(["property", ...existingAreas], [propertyAnchor], 0.98);
  clearQualityFlags(flags, [
    "classification.caseFamily",
    "classification.primaryLegalArea",
    "classification.legalAreas",
  ]);
}

function reconcileProceduralHistory(
  procedure: CaseProcedureV2,
  context: EvidenceValidationContext,
  flags: Set<string>,
): void {
  if (procedure.proceduralHistory.status === "available" && procedure.proceduralHistory.value.trim()) return;
  const anchors: EvidenceAnchorV2[] = [];
  for (const paragraph of context.source.paragraphs) {
    const span = context.sectionByParagraphId.get(paragraph.id);
    if (!span || span.isQuotedMaterial || !["caption", "case_metadata", "procedural_history"].includes(span.sectionType)) continue;
    if (!/(?:τροποποι|αντικαταστ|υποκαταστ|διάταγμα|amend|substitut)/iu.test(paragraph.text)) continue;
    const anchor = sourceEvidence(context, paragraph, "procedure.proceduralHistory", ["express procedural amendment"]);
    if (anchor) anchors.push(anchor);
  }
  if (!anchors.length) return;
  procedure.proceduralHistory = groundedField(
    anchors.slice(0, 3).map((anchor) => anchor.quote.trim()).join(" "),
    anchors.slice(0, 3),
    0.98,
  );
  clearQualityFlags(flags, ["procedure.proceduralHistory"]);
}

function outcomeCodeFromDecision(text: string): OutcomeComponentV2["result"] | "" {
  if (/(?:απορρίπ|δεν\s+ευσταθ|ούτε[^.]{0,80}ευσταθ|dismiss|reject)/iu.test(text)) return "dismissed";
  if (/(?:εν\s+μέρει|μερικώς|partly)/iu.test(text) && /(?:δεκτ|επιτρέπ|allow)/iu.test(text)) return "partly_allowed";
  if (/(?:γίνεται\s+δεκτ|έγινε\s+δεκτ|επιτρέπ|allow)/iu.test(text)) return "allowed";
  return "";
}

function reconcileNumberedOutcomeComponents(
  procedure: CaseProcedureV2,
  outcome: CaseOutcomeV2,
  context: EvidenceValidationContext,
  flags: Set<string>,
): void {
  if (procedure.groundsOrIssues.status !== "available") return;
  const grounds = new Map(procedure.groundsOrIssues.value
    .filter((ground) => ground.number.trim())
    .map((ground) => [ground.number.trim(), ground]));
  if (!grounds.size) return;

  const existing = outcome.components.status === "available" ? [...outcome.components.value] : [];
  const evidence = outcome.components.status === "available" ? [...outcome.components.evidence] : [];
  const existingNumbers = new Set(existing.flatMap((component) =>
    [...`${component.target} ${component.groundOrIssue}`.matchAll(/λόγ(?:ος|ο|οι)\s+(?:έφεσης\s+)?(\d{1,3})/giu)].map((match) => match[1])
  ));

  for (const paragraph of context.source.paragraphs) {
    const span = context.sectionByParagraphId.get(paragraph.id);
    if (!span || span.isQuotedMaterial || !PRESENT_COURT_SPEAKERS.has(span.speakerRole)) continue;
    if (!HOLDING_SECTIONS.has(span.sectionType) || !EXPLICIT_DETERMINATION_RE.test(paragraph.text)) continue;
    const result = outcomeCodeFromDecision(paragraph.text);
    if (!result) continue;
    for (const match of paragraph.text.matchAll(/λόγ(?:ος|ο|οι)\s+(?:έφεσης\s+)?(\d{1,3})/giu)) {
      const number = match[1];
      const ground = grounds.get(number);
      if (!ground || existingNumbers.has(number)) continue;
      const anchor = sourceEvidence(context, paragraph, "outcome.components", [`disposition of ground ${number}`]);
      if (!anchor) continue;
      existing.push({
        target: `Λόγος έφεσης ${number}`,
        groundOrIssue: ground.title || `Λόγος έφεσης ${number}`,
        result,
        remedy: result === "dismissed" ? "απόρριψη" : "",
        orderText: paragraph.text,
      });
      evidence.push(anchor);
      existingNumbers.add(number);
    }
  }

  if (!existingNumbers.size) return;
  const unnumbered: OutcomeComponentV2[] = [];
  const numbered = new Map<string, OutcomeComponentV2>();
  const componentScore = (component: OutcomeComponentV2, number: string): number => {
    const generic = new RegExp(`^λόγος\\s+(?:έφεσης\\s+)?${number}$`, "iu");
    return (generic.test(component.groundOrIssue.trim()) ? 0 : 4) +
      (component.orderText.trim() ? 2 : 0) +
      (component.remedy.trim() && component.remedy.toLocaleLowerCase("el") !== "none" ? 1 : 0);
  };
  for (const component of existing) {
    const number = `${component.target} ${component.groundOrIssue}`
      .match(/λόγ(?:ος|ο|οι)\s+(?:έφεσης\s+)?(\d{1,3})/iu)?.[1];
    const normalized = {
      ...component,
      remedy: component.remedy.toLocaleLowerCase("el") === "none" ? "" : component.remedy,
    };
    if (!number) {
      unnumbered.push(normalized);
      continue;
    }
    const current = numbered.get(number);
    if (!current || componentScore(normalized, number) > componentScore(current, number)) {
      numbered.set(number, normalized);
    }
  }
  const reconciled = [
    ...unnumbered,
    ...[...numbered.entries()]
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([, component]) => component),
  ];
  outcome.components = groundedField(
    reconciled,
    evidence,
    0.98,
  );
  clearQualityFlags(flags, ["outcome.components"]);
}

function greekList(values: string[]): string {
  if (values.length < 2) return values[0] || "";
  return `${values.slice(0,-1).join(", ")} και ${values.at(-1)}`;
}

function normalizedProse(value: string): string {
  return value
    .toLocaleLowerCase("el")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ς/g, "σ")
    .replace(/[^a-zα-ω0-9]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A disposition or list of ground results is not, by itself, a legal holding. */
export function isBareHoldingResult(value: string): boolean {
  const prose = normalizedProse(value);
  if (!prose || prose.length > 220) return false;
  return /^(?:οι )?λογοι(?: εφεσησ)?[ 0-9και,]+(?:απορριφθηκαν|δεν ευσταθουν|απετυχαν)$/u.test(prose) ||
    /^(?:ο )?λογοσ(?: εφεσησ)? \d+(?: απορριφθηκε| δεν ευσταθει| απετυχε)$/u.test(prose) ||
    /^(?:(?:ο )?λογοσ(?: εφεσησ)? \d+ (?:απορριφθηκε|δεν ευσταθει|απετυχε|εγινε δεκτοσ|εγινε δεκτη)\s*){2,}$/u.test(prose) ||
    /^(?:η )?(?:εφεση|αιτηση) (?:απορριφθηκε|εγινε δεκτη)$/u.test(prose) ||
    /^(?:the )?(?:appeal|application|grounds?(?: [0-9, and]+)?) (?:was |were )?(?:dismissed|allowed|rejected|refused)$/u.test(prose);
}

function holdingCoverage(base: string, candidate: string): number {
  const baseTokens = new Set(normalizedProse(base).split(" ").filter((token) => token.length >= 4));
  const candidateTokens = new Set(normalizedProse(candidate).split(" ").filter((token) => token.length >= 4));
  if (!candidateTokens.size) return 1;
  let covered = 0;
  for (const token of candidateTokens) if (baseTokens.has(token)) covered += 1;
  return covered / candidateTokens.size;
}

export function chooseLawyerHolding(
  current: string,
  determinations: string[],
  numberedGrounds: string[],
  allNumberedDismissed: boolean,
): string {
  const present = current.trim();
  const detailed = [...new Map(determinations
    .map((value) => value.trim())
    .filter((value) => value.length >= 30 && !isBareHoldingResult(value))
    .map((value) => [normalizedProse(value), value])).values()].slice(0, 4);

  // The whole-judgment synthesis is the lawyer-written product. Preserve it
  // whenever it contains legal reasoning; deterministic ground detection is a
  // verification aid, not authority to replace the analysis with a docket note.
  if (present && !isBareHoldingResult(present)) {
    const missing = detailed.filter((value) => holdingCoverage(present, value) < 0.52);
    return missing.length ? [present, ...missing].join(" ") : present;
  }
  if (detailed.length) return detailed.join(" ");
  if (allNumberedDismissed && numberedGrounds.length) {
    return `Οι λόγοι έφεσης ${greekList(numberedGrounds)} απορρίφθηκαν.`;
  }
  return present;
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

  const numberedDecisionAnchors = evidence.filter((anchor) =>
    /λόγ(?:ος|ο|οι)\s+(?:έφεσης\s+)?\d{1,3}/iu.test(anchor.quote) &&
    /(απορρίπ|δεν\s+ευσταθ|δεν\s+ευστατεί|ούτε[^.]{0,80}ευσταθ|γίνεται\s+δεκτ|έγινε\s+δεκτ|επιτρέπ)/iu.test(anchor.quote)
  );
  const numberedGrounds = [...new Set(numberedDecisionAnchors.flatMap((anchor) =>
    [...anchor.quote.matchAll(/λόγ(?:ος|ο|οι)\s+(?:έφεσης\s+)?(\d{1,3})/giu)].map((match) => match[1])
  ))].sort((left,right) => Number(left)-Number(right));
  const allNumberedDismissed = numberedGrounds.length >= 2 && numberedDecisionAnchors.every((anchor) =>
    /(απορρίπ|δεν\s+ευσταθ|δεν\s+ευστατεί|ούτε[^.]{0,80}ευσταθ)/iu.test(anchor.quote)
  );
  const resolvedIssues = analysis.legalIssues.status === "available"
    ? analysis.legalIssues.value.filter((item) => item.issue.trim() && item.determination.trim())
    : [];
  const determinations = resolvedIssues.map((item) => item.determination.trim()).filter(Boolean);
  const value = chooseLawyerHolding(
    analysis.holding.value,
    determinations,
    numberedGrounds,
    allNumberedDismissed,
  );

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
  reconcileObviousAppealClassification(input);
  const expedition = reconcileExpeditionClassification(input);
  normalizeApplicationOutcome(expedition, input.outcome, input.flags);
  reconcileGroundNumbers(input.procedure, input.context, input.flags);
  reconcileProceduralHistory(input.procedure, input.context, input.flags);
  reconcileNumberedOutcomeComponents(input.procedure, input.outcome, input.context, input.flags);
  reconcileRelief(input.procedure, input.outcome, input.flags);
  reconcileHolding(input.analysis, input.context, input.flags);
  removeUnsupportedExceptionLanguage(input.analysis, input.source);
  removeReasonComponents(input.procedure, input.outcome, input.flags);
  return { expedition };
}


// ---------------------------------------------------------------------------
// Presentation dedup: legal records legitimately reference the same
// instrument, principle or order in several fields, but a reading interface
// must never show the same card twice. This pass removes exact duplicates
// (after Unicode/whitespace normalisation) without touching evidence anchors:
// primaryLegislation/secondaryLegislation become strict subsets of the
// deduplicated legislation list, secondary principles drop entries already in
// the ratio, and operative orders drop lines repeated from the disposition or
// component orders. It never invents content and never fuzzy-matches.
// ---------------------------------------------------------------------------

type LooseRecord = Record<string, unknown>;

function presRecord(value: unknown): LooseRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as LooseRecord : null;
}

function presNormalize(value: unknown): string {
  return String(value ?? "").normalize("NFC").toLowerCase().replace(/\s+/gu, " ").replace(/[.,·;:]+$/gu, "").trim();
}

function emptyUnavailable(field: LooseRecord): void {
  field.value = [];
  field.status = "unavailable";
  field.confidence = 0;
  field.evidence = [];
}

function dedupeListField(field: unknown, keyOf: (item: LooseRecord) => string, merge?: (kept: LooseRecord, next: LooseRecord) => void): void {
  const row = presRecord(field);
  if (!row || !Array.isArray(row.value)) return;
  const seen = new Map<string, LooseRecord>();
  const output: unknown[] = [];
  for (const raw of row.value) {
    const item = presRecord(raw);
    if (!item) { output.push(raw); continue; }
    const key = keyOf(item);
    if (!key) { output.push(item); continue; }
    const kept = seen.get(key);
    if (kept) { merge?.(kept, item); continue; }
    seen.set(key, item);
    output.push(item);
  }
  if (output.length !== row.value.length) row.value = output;
}

export function dedupeRecordPresentation(record: LooseRecord): LooseRecord {
  const authorities = presRecord(record.authorities);
  if (authorities) {
    const instrumentKey = (item: LooseRecord) => presNormalize(item.instrumentName || item.lawLabel || item.lawId);
    const mergeInstrument = (kept: LooseRecord, next: LooseRecord) => {
      if (next.primary === true) kept.primary = true;
      if (Array.isArray(kept.provisions) && Array.isArray(next.provisions)) {
        const have = new Set(kept.provisions.map((p) => presNormalize(presRecord(p)?.display ?? presRecord(p)?.article)));
        for (const p of next.provisions) {
          const key = presNormalize(presRecord(p)?.display ?? presRecord(p)?.article);
          if (!have.has(key)) { have.add(key); kept.provisions.push(p); }
        }
      }
      if (!presNormalize(kept.proposition) && presNormalize(next.proposition)) kept.proposition = next.proposition;
    };
    dedupeListField(authorities.legislation, instrumentKey, mergeInstrument);
    const legislation = presRecord(authorities.legislation);
    if (legislation && Array.isArray(legislation.value)) {
      const items = legislation.value.map(presRecord).filter((item): item is LooseRecord => !!item);
      const primary = presRecord(authorities.primaryLegislation);
      if (primary && Array.isArray(primary.value)) {
        const subset = items.filter((item) => item.primary === true);
        if (subset.length) { primary.value = subset; }
        else emptyUnavailable(primary);
      }
      const secondary = presRecord(authorities.secondaryLegislation);
      if (secondary && Array.isArray(secondary.value)) {
        const subset = items.filter((item) => item.primary !== true);
        if (subset.length) { secondary.value = subset; }
        else emptyUnavailable(secondary);
      }
    }
    dedupeListField(authorities.authorities, (item) => `${presNormalize(item.name)}|${presNormalize(item.citation)}`);
  }

  const analysis = presRecord(record.analysis);
  if (analysis) {
    const ratio = presRecord(analysis.ratioDecidendi);
    const ratioKeys = new Set(
      (Array.isArray(ratio?.value) ? ratio!.value : [])
        .map((item) => presNormalize(presRecord(item)?.principle))
        .filter(Boolean),
    );
    dedupeListField(analysis.ratioDecidendi, (item) => presNormalize(item.principle));
    const secondary = presRecord(analysis.secondaryPrinciples);
    if (secondary && Array.isArray(secondary.value)) {
      const filtered = secondary.value.filter((item) => {
        const key = presNormalize(presRecord(item)?.principle);
        return key && !ratioKeys.has(key);
      });
      if (filtered.length !== secondary.value.length) {
        if (filtered.length) secondary.value = filtered;
        else emptyUnavailable(secondary);
      }
    }
    dedupeListField(analysis.legalIssues, (item) => presNormalize(item.issue));
    dedupeListField(analysis.findings, (item) => presNormalize(item.finding));
  }

  const outcome = presRecord(record.outcome);
  if (outcome) {
    dedupeListField(outcome.components, (item) => `${presNormalize(item.groundOrIssue || item.target)}|${presNormalize(item.result)}`);
    const taken = new Set<string>([presNormalize(presRecord(outcome.dispositionText)?.value)]);
    for (const raw of (Array.isArray(presRecord(outcome.components)?.value) ? presRecord(outcome.components)!.value as unknown[] : [])) {
      taken.add(presNormalize(presRecord(raw)?.orderText));
    }
    const orders = presRecord(outcome.orders);
    if (orders && Array.isArray(orders.value)) {
      const filtered = orders.value.filter((item) => {
        const key = presNormalize(item);
        return key && !taken.has(key);
      });
      if (filtered.length !== orders.value.length) {
        if (filtered.length) orders.value = filtered;
        else emptyUnavailable(orders);
      }
    }
  }
  return record;
}
