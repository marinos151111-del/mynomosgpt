import type { SpecialistResultsV2 } from "./agents.ts";
import type {
  EvidenceAnchorV2,
  ExtractedFieldV2,
  GroundOrIssueV2,
  JudgmentParagraphV2,
  JudgmentSourceV2,
  LegalInstrumentV2,
  MoneyAwardV2,
  OutcomeComponentV2,
  PipelineConflictV2,
  SectionMapV2,
} from "./types.ts";

export interface DeterministicFindingV2 {
  kind: "identity" | "date" | "legislation" | "ground_result" | "final_order" | "costs" | "procedure_event";
  value: string;
  paragraphId: string;
  quote: string;
}

function fold(value: string): string {
  return value.toLocaleLowerCase("el").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ς/g, "σ");
}

function unique<T>(values: T[], key: (value: T) => string): T[] {
  const output = new Map<string, T>();
  for (const value of values) if (!output.has(key(value))) output.set(key(value), value);
  return [...output.values()];
}

function available<T>(field: ExtractedFieldV2<T>): boolean {
  if (field.status !== "available") return false;
  if (typeof field.value === "string") return field.value.trim().length > 0;
  if (Array.isArray(field.value)) return field.value.length > 0;
  return field.value !== null && field.value !== undefined;
}

function spanFor(paragraph: JudgmentParagraphV2, source: JudgmentSourceV2, map: SectionMapV2) {
  const ordinalById = new Map(source.paragraphs.map((item) => [item.id, item.ordinal]));
  return map.spans.find((span) => {
    const start = ordinalById.get(span.startParagraphId);
    const end = ordinalById.get(span.endParagraphId);
    return start !== undefined && end !== undefined && paragraph.ordinal >= start && paragraph.ordinal <= end;
  });
}

function anchor(
  paragraph: JudgmentParagraphV2,
  source: JudgmentSourceV2,
  map: SectionMapV2,
  supports: string[],
): EvidenceAnchorV2 {
  const span = spanFor(paragraph, source, map);
  const quote = paragraph.text.trim();
  return {
    id: `det_${paragraph.id}_${supports[0].replace(/[^a-z0-9]+/gi, "_")}`.slice(0, 150),
    paragraphIds: [paragraph.id],
    quote,
    sectionType: span?.sectionType || "other",
    speakerRole: span?.speakerRole || "unknown",
    supports,
    exactMatch: true,
  };
}

function mergeAnchors(current: EvidenceAnchorV2[], additions: EvidenceAnchorV2[]): EvidenceAnchorV2[] {
  return unique([...current, ...additions], (item) => `${item.paragraphIds.join(",")}|${fold(item.quote)}`);
}

function setStringIfMissing(
  field: ExtractedFieldV2<string>,
  value: string,
  evidence: EvidenceAnchorV2,
): void {
  if (available(field) && field.value !== "—") return;
  field.status = "available";
  field.value = value;
  field.confidence = 0.99;
  field.evidence = mergeAnchors(field.evidence || [], [evidence]);
  field.conflicts = [];
}

function setAvailable<T>(
  field: ExtractedFieldV2<T>,
  value: T,
  evidence: EvidenceAnchorV2[],
  confidence = 0.99,
): void {
  field.status = "available";
  field.value = value;
  field.confidence = Math.max(field.confidence || 0, confidence);
  field.evidence = mergeAnchors(field.evidence || [], evidence);
  field.conflicts = [];
}

function nonQuotedCourtParagraph(
  paragraph: JudgmentParagraphV2,
  source: JudgmentSourceV2,
  map: SectionMapV2,
): boolean {
  const span = spanFor(paragraph, source, map);
  if (!span) return true;
  return !span.isQuotedMaterial && !["quoted_authority", "quoted_legislation"].includes(span.sectionType);
}

function partyFromOrder(text: string, marker: "υπέρ" | "εναντίον"): string {
  const rx = marker === "υπέρ"
    ? /υπέρ\s+(.+?)(?=\s+(?:και\s+εναντίον|για\s+το\s+ποσό|έξοδ|costs?|ύψους)|[,.€·;]|$)/iu
    : /εναντίον\s+(.+?)(?=\s+(?:για\s+το\s+ποσό|έξοδ|costs?|ύψους)|[,.€·;]|$)/iu;
  return text.match(rx)?.[1]?.trim() || "";
}

function costStage(text: string): MoneyAwardV2["stage"] {
  if (/(?:πρωτόδικ|πρώτου\s+βαθμού|first[ -]?instance|trial costs?)/iu.test(text)) return "first_instance";
  if (/(?:επανεκδίκ|retrial)/iu.test(text)) return "retrial";
  if (/(?:έφεσ|appellate|appeal costs?)/iu.test(text)) return "appellate";
  return "other";
}

function vatStatus(text: string): MoneyAwardV2["vatStatus"] {
  if (/(?:Φ\.?\s*Π\.?\s*Α\.?|ΦΠΑ|VAT)[^!;]{0,35}(?:αν\s+υπάρχει|if\s+applicable)/iu.test(text)) return "plus_vat_if_applicable";
  if (/(?:πλέον|plus)\s+(?:του\s+)?(?:Φ\.?\s*Π\.?\s*Α\.?|ΦΠΑ|VAT)/iu.test(text)) return "plus_vat";
  if (/(?:περιλαμβάν|included)[^!;]{0,30}(?:Φ\.?\s*Π\.?\s*Α\.?|ΦΠΑ|VAT)/iu.test(text)) return "included";
  return "not_stated";
}

function outcomeCode(text: string): OutcomeComponentV2["result"] | null {
  if (/(?:αποσύρ|withdrawn|abandon)/iu.test(text)) return "withdrawn";
  if (/(?:απορρίπ|δεν\s+ευσταθ|dismissed|failed)/iu.test(text)) return "appeal_dismissed";
  if (/(?:επιτυγχ|γίνεται\s+δεκτ|επιτρέπ|allowed|succeeds?)/iu.test(text)) return "appeal_allowed";
  return null;
}

function overallFromComponents(components: OutcomeComponentV2[]): OutcomeComponentV2["result"] | null {
  const results = new Set(components.map((item) => item.result));
  const allowed = results.has("appeal_allowed") || results.has("allowed");
  const dismissed = results.has("appeal_dismissed") || results.has("dismissed");
  if (allowed && dismissed) return "appeal_partly_allowed";
  if (allowed) return "appeal_allowed";
  if (dismissed && !allowed) return "appeal_dismissed";
  if (results.size === 1 && results.has("withdrawn")) return "withdrawn";
  return null;
}

function footnoteAntecedent(source: JudgmentSourceV2, paragraph: JudgmentParagraphV2): string {
  const marker = paragraph.text.match(/^\s*\[(\d{1,3})\]/u)?.[1];
  if (!marker) return "";
  const reference = [...source.paragraphs]
    .filter((item) => item.ordinal < paragraph.ordinal && item.text.includes(`[${marker}]`))
    .sort((left, right) => right.ordinal - left.ordinal)[0];
  if (!reference) return "";
  const before = reference.text.slice(0, reference.text.lastIndexOf(`[${marker}]`)).replace(/[\s,;:]+$/u, "");
  const candidate = before.split(/[,;:]/u).pop()?.trim() || "";
  return candidate.replace(/^(?:η|ο|το|της|του|των)\s+/iu, "").slice(-100).trim();
}

function instrumentKey(value: LegalInstrumentV2): string {
  const text = fold(`${value.lawId} ${value.lawLabel} ${value.instrumentName}`);
  const chapter = text.match(/(?:cap|κεφ(?:αλαιο)?)\s*[_ .-]?(\d+[a-zα-ω]*)/u);
  if (chapter) return `cap_${chapter[1]}`;
  if (/συνταγμα|constitution/u.test(text)) return "constitution_cyprus";
  if (/(?:14\s*[\/_-]\s*(?:19)?60|δικαστηριων\s+νομ)/u.test(text)) return "law_14_1960";
  if (/κανονισμ.*πολιτικ.*δικονομ|civil\s+procedure\s+rules|\bcpr\b/u.test(text)) {
    return /2023/u.test(text) ? "cpr_2023" : "cpr_former";
  }
  return fold(value.lawId || value.lawLabel || value.instrumentName).replace(/[^a-zα-ω0-9]+/gu, "_");
}

function mergeLegislation(
  field: ExtractedFieldV2<LegalInstrumentV2[]>,
  additions: LegalInstrumentV2[],
  evidence: EvidenceAnchorV2[],
): void {
  if (!additions.length) return;
  const byKey = new Map<string, LegalInstrumentV2>();
  for (const instrument of available(field) ? field.value : []) byKey.set(instrumentKey(instrument), structuredClone(instrument));
  for (const instrument of additions) {
    const key = instrumentKey(instrument);
    const current = byKey.get(key);
    if (!current) byKey.set(key, instrument);
    else {
      current.provisions = unique([...current.provisions, ...instrument.provisions], (item) =>
        fold(item.article || item.display || item.normalized).replace(/[^a-zα-ω0-9]+/gu, "")
      );
      if (!current.proposition && instrument.proposition) current.proposition = instrument.proposition;
    }
  }
  field.status = "available";
  field.value = [...byKey.values()];
  field.confidence = Math.max(field.confidence || 0, 0.99);
  field.evidence = mergeAnchors(field.evidence || [], evidence);
  field.conflicts = [];
}

type NamedInstrument = { lawId: string; lawLabel: string; instrumentName: string; instrumentType: LegalInstrumentV2["instrumentType"] };

function namedInstrument(text: string): NamedInstrument | null {
  const chapter = text.match(/(?:Κεφ(?:άλαιο)?\.?|Cap\.?)\s*(\d+[A-Za-zΑ-Ωα-ω]*)/iu);
  if (chapter) return { lawId: `cap_${fold(chapter[1])}`, lawLabel: `Κεφ. ${chapter[1]}`, instrumentName: `Κεφ. ${chapter[1]}`, instrumentType: "chapter" };
  const law = text.match(/(?:Ν(?:όμος|όμου)?|Ν\.)\s*(\d+(?:\([ΙIVX]+\))?\s*\/\s*\d{2,4})/iu);
  if (law) {
    const number = law[1].replace(/\s+/g, "");
    return { lawId: `law_${fold(number).replace(/[^a-zα-ω0-9]+/gu, "_")}`, lawLabel: `Ν. ${number}`, instrumentName: `Ν. ${number}`, instrumentType: "law" };
  }
  if (/Συντάγμα(?:τος|τικ)/iu.test(text)) return { lawId: "constitution_cyprus", lawLabel: "Σύνταγμα", instrumentName: "Σύνταγμα της Κυπριακής Δημοκρατίας", instrumentType: "constitution" };
  return null;
}

function ownerTextForArticle(paragraph: string, matchIndex: number, matchLength: number): string {
  const after = paragraph.slice(matchIndex + matchLength, matchIndex + matchLength + 260);
  // Ownership normally follows the provision: «άρθρο 25(3) του ... Νόμου».
  // Stop before a second independent provision so a later law cannot steal the
  // first article in a multi-instrument paragraph.
  const boundedAfter = after.split(/(?:\s+και\s+της?\s+Δ\.?\s*\d+|[.;]\s*(?:το|η|ο|άρθρ))/iu)[0];
  const direct = namedInstrument(boundedAfter);
  if (direct) return boundedAfter;
  return paragraph.slice(Math.max(0, matchIndex - 160), Math.min(paragraph.length, matchIndex + matchLength + 220));
}

export function extractDeterministicLegislation(
  source: JudgmentSourceV2,
  map: SectionMapV2,
): { instruments: LegalInstrumentV2[]; evidence: EvidenceAnchorV2[]; findings: DeterministicFindingV2[] } {
  const instruments = new Map<string, LegalInstrumentV2>();
  const evidence: EvidenceAnchorV2[] = [];
  const findings: DeterministicFindingV2[] = [];
  const articleRx = /(?:άρθρ(?:ο|α|ου|ων)|article(?:s)?|section(?:s)?)\s+((?:\d+[Α-Ωα-ω]?(?:\([^)]{1,18}\))?)(?:\s*(?:,|και|έως|ως|-)\s*\d+[Α-Ωα-ω]?(?:\([^)]{1,18}\))?)*)/giu;
  for (const paragraph of source.paragraphs) {
    articleRx.lastIndex = 0;
    let contextualOwner: NamedInstrument | null = null;
    let match: RegExpExecArray | null;
    while ((match = articleRx.exec(paragraph.text)) !== null) {
      const window = ownerTextForArticle(paragraph.text, match.index, match[0].length);
      const explicitOwner = namedInstrument(window);
      const refersToPriorLaw = /(?:του|of\s+the)\s+(?:ίδιου\s+)?(?:Νόμου|Law)(?=\s|[.,;:)])/iu.test(
        paragraph.text.slice(match.index + match[0].length, match.index + match[0].length + 100),
      );
      const owner: NamedInstrument | null = explicitOwner || (refersToPriorLaw ? contextualOwner : null);
      if (!owner) continue;
      contextualOwner = owner;
      let articles = [...match[1].matchAll(/\d+[Α-Ωα-ω]?(?:\([^)]{1,18}\))?/gu)].map((item) => item[0]);
      const prefix = paragraph.text.slice(Math.max(0, match.index - 55), match.index);
      const externalParagraph = prefix.match(/(?:παράγραφ(?:ος|ο|ου)|subsection|paragraph)\s*(\d+[Α-Ωα-ω]?)[^.!;]{0,24}(?:του|of)\s*$/iu)?.[1];
      if (externalParagraph && articles.length === 1 && !articles[0].includes("(")) {
        articles = [`${articles[0]}(${externalParagraph})`];
      }
      if (!articles.length) continue;
      const key = owner.lawId;
      const current = instruments.get(key) || {
        ...owner,
        role: owner.instrumentType === "constitution" ? "constitutional" : "unknown",
        primary: false,
        provisions: [],
        proposition: paragraph.text.trim(),
      };
      current.provisions = unique([
        ...current.provisions,
        ...articles.map((article) => ({
          display: `Άρθρο ${article}`,
          article,
          paragraph: "",
          subparagraph: "",
          part: "",
          normalized: `${key}:article:${fold(article).replace(/[^a-zα-ω0-9]+/gu, "_")}`,
          application: "mentioned" as const,
        })),
      ], (item) => item.normalized);
      instruments.set(key, current);
      const itemAnchor = anchor(paragraph, source, map, ["authorities.legislation"]);
      evidence.push(itemAnchor);
      findings.push({ kind: "legislation", value: `${owner.lawLabel}: ${articles.join(", ")}`, paragraphId: paragraph.id, quote: paragraph.text.trim() });
    }

    const formerRules = [
      ...paragraph.text.matchAll(/(?:Δ(?:ιάταξη)?\.?|Order)\s*(\d+)\s*[,·;]?\s*(?:Κ(?:αν(?:όνας|ονισμός))?\.?|rule)\s*(\d+)/giu),
    ];
    for (const match of formerRules) {
      const surrounding = paragraph.text.slice(Math.max(0, (match.index || 0) - 80), Math.min(paragraph.text.length, (match.index || 0) + match[0].length + 220));
      if (!/(?:Κανονισμ(?:οί|ών)\s+Πολιτικής\s+Δικονομίας|Civil\s+Procedure\s+Rules)/iu.test(surrounding)) continue;
      const former = /(?:ίσχυαν\s+κατά\s+τον\s+ουσιώδη\s+χρόνο|πρώην|former|old)/iu.test(surrounding) || !/2023/u.test(surrounding);
      const lawId = former ? "cpr_former" : "cpr_2023";
      const current = instruments.get(lawId) || {
        lawId,
        lawLabel: former ? "πρώην Κανονισμοί Πολιτικής Δικονομίας" : "Κανονισμοί Πολιτικής Δικονομίας του 2023",
        instrumentName: former ? "Κανονισμοί Πολιτικής Δικονομίας που ίσχυαν κατά τον ουσιώδη χρόνο" : "Κανονισμοί Πολιτικής Δικονομίας του 2023",
        instrumentType: "rule" as const,
        role: "procedural" as const,
        primary: false,
        provisions: [],
        proposition: paragraph.text.trim(),
      };
      current.provisions = unique([...current.provisions, {
        display: `Διάταξη ${match[1]}, Κανονισμός ${match[2]}`,
        article: "",
        paragraph: match[2],
        subparagraph: "",
        part: match[1],
        normalized: `${lawId}:order:${match[1]}:rule:${match[2]}`,
        application: "mentioned" as const,
      }], (item) => item.normalized);
      instruments.set(lawId, current);
      const itemAnchor = anchor(paragraph, source, map, ["authorities.legislation"]);
      evidence.push(itemAnchor);
      findings.push({ kind: "legislation", value: `${current.lawLabel}: Δ.${match[1]}, Κ.${match[2]}`, paragraphId: paragraph.id, quote: paragraph.text.trim() });
    }
  }
  return { instruments: [...instruments.values()], evidence: mergeAnchors([], evidence), findings };
}

function provisionIdentity(value: LegalInstrumentV2["provisions"][number]): string {
  const structural = value.part || value.paragraph ? `${value.part}:${value.paragraph}` : "";
  return fold(value.article || structural || value.display || value.normalized)
    .replace(/[^a-zα-ω0-9]+/gu, "");
}

export function provisionOwnershipConflicts(
  source: JudgmentSourceV2,
  map: SectionMapV2,
  legislation: ExtractedFieldV2<LegalInstrumentV2[]>,
): PipelineConflictV2[] {
  if (!available(legislation)) return [];
  const detected = extractDeterministicLegislation(source, map).instruments;
  const owners = new Map<string, Set<string>>();
  for (const instrument of detected) {
    const key = instrumentKey(instrument);
    const provisions = owners.get(key) || new Set<string>();
    instrument.provisions.forEach((provision) => provisions.add(provisionIdentity(provision)));
    owners.set(key, provisions);
  }
  const conflicts: PipelineConflictV2[] = [];
  for (const instrument of legislation.value) {
    const owner = instrumentKey(instrument);
    for (const provision of instrument.provisions || []) {
      const identity = provisionIdentity(provision);
      if (!identity || owners.get(owner)?.has(identity)) continue;
      const otherOwner = [...owners.entries()].find(([, provisions]) => provisions.has(identity))?.[0];
      conflicts.push({
        code: otherOwner ? "PROVISION_WRONG_STATUTE" : "PROVISION_OWNERSHIP_UNVERIFIED",
        severity: "critical",
        fieldPath: "authorities.legislation",
        message: otherOwner
          ? `Η διάταξη ${provision.display || provision.article} αποδόθηκε στο ${instrument.lawLabel}, ενώ η πηγή τη συνδέει με διαφορετικό νομοθέτημα (${otherOwner}).`
          : `Δεν τεκμηριώνεται από την πηγή η σύνδεση της διάταξης ${provision.display || provision.article} με το ${instrument.lawLabel}.`,
        evidenceIds: legislation.evidence.flatMap((item) => item.paragraphIds),
      });
    }
  }
  return conflicts;
}

export function applyDeterministicBaseline(
  input: SpecialistResultsV2,
  source: JudgmentSourceV2,
  map: SectionMapV2,
): { specialists: SpecialistResultsV2; findings: DeterministicFindingV2[] } {
  const specialists = structuredClone(input);
  const findings: DeterministicFindingV2[] = [];
  const emptyField = <T>(value: T): ExtractedFieldV2<T> => ({ status: "unavailable", value, confidence: 0, evidence: [], conflicts: [] });
  // Accept pre-v2.1 candidate records during legacy repair. New extraction
  // always supplies these fields through the schema.
  specialists.outcome.overallOutcome ||= emptyField("unknown");
  specialists.outcome.dispositionText ||= emptyField("");
  specialists.outcome.orders ||= emptyField([]);
  specialists.outcome.remedies ||= emptyField([]);
  specialists.outcome.monetaryAwards ||= emptyField([]);
  specialists.outcome.remittalInstructions ||= emptyField([]);
  specialists.outcome.withdrawnOrAbandoned ||= emptyField([]);

  for (const paragraph of source.paragraphs.slice(0, 70)) {
    const caseNumber = fold(paragraph.text).match(/(?:πολιτικη|ποινικη|αναθεωρητικη|εκλογικη)?\s*(?:εφεση|αιτηση|προσφυγη)\s*(?:αρ\.?|αριθμοσ)?\s*[:.]?\s*([a-zα-ω]?\d{1,7}\s*\/\s*\d{2,4})/u);
    if (caseNumber) {
      const value = caseNumber[1].replace(/\s+/g, "");
      const evidence = anchor(paragraph, source, map, ["identity.caseNumber", "identity.docket"]);
      setStringIfMissing(specialists.identity.caseNumber, value, evidence);
      setStringIfMissing(specialists.identity.docket, value, evidence);
      findings.push({ kind: "identity", value, paragraphId: paragraph.id, quote: paragraph.text.trim() });
      break;
    }
  }

  for (const paragraph of [...source.paragraphs.slice(0, 70), ...source.paragraphs.slice(-25)]) {
    const decisionDate = paragraph.text.match(/\b(\d{1,2}\s+(?:Ιανουαρίου|Φεβρουαρίου|Μαρτίου|Απριλίου|Μαΐου|Ιουνίου|Ιουλίου|Αυγούστου|Σεπτεμβρίου|Οκτωβρίου|Νοεμβρίου|Δεκεμβρίου)[,\s]+(?:19|20)\d{2})\b/iu);
    if (!decisionDate) continue;
    const evidence = anchor(paragraph, source, map, ["identity.decisionDate"]);
    setStringIfMissing(specialists.identity.decisionDate, decisionDate[1].replace(/\s+/g, " ").trim(), evidence);
    findings.push({ kind: "date", value: decisionDate[1], paragraphId: paragraph.id, quote: paragraph.text.trim() });
    break;
  }

  const legislation = extractDeterministicLegislation(source, map);
  mergeLegislation(specialists.authorities.legislation, legislation.instruments, legislation.evidence);
  findings.push(...legislation.findings);

  // Ground appellate classification directly in the formal caption/header.
  // This is a source fact, not a topic inference, and therefore should not be
  // left as an unexplained publication blocker when the caption is explicit.
  if (specialists.classification && (!available(specialists.classification.proceedingType) || !specialists.classification.proceedingType.evidence.length)) {
    const proceedingParagraph = source.paragraphs.slice(0, 80).find((paragraph) =>
      /(?:πολιτική\s+έφεση|civil\s+appeal|ποινική\s+έφεση|criminal\s+appeal|διοικητική\s+έφεση|administrative\s+appeal)/iu.test(paragraph.text)
    );
    if (proceedingParagraph) {
      const proceeding = /(?:ποινική\s+έφεση|criminal\s+appeal)/iu.test(proceedingParagraph.text)
        ? "criminal_appeal"
        : /(?:διοικητική\s+έφεση|administrative\s+appeal)/iu.test(proceedingParagraph.text)
          ? "administrative_appeal"
          : "civil_appeal";
      setAvailable(
        specialists.classification.proceedingType,
        proceeding,
        [anchor(proceedingParagraph, source, map, ["classification.proceedingType"])],
      );
    }
  }
  if (specialists.classification && (!available(specialists.classification.primaryLegalArea) || !specialists.classification.primaryLegalArea.evidence.length) &&
      available(specialists.classification.legalAreas)) {
    const primary = specialists.classification.legalAreas.value.find((value) => value !== "unknown");
    if (primary) setAvailable(
      specialists.classification.primaryLegalArea,
      primary,
      specialists.classification.legalAreas.evidence,
      specialists.classification.legalAreas.confidence,
    );
  }

  const resultByGround = new Map<string, { result: GroundOrIssueV2["result"]; paragraph: JudgmentParagraphV2 }>();
  const registerGround = (number: string, result: GroundOrIssueV2["result"], paragraph: JudgmentParagraphV2) => {
    resultByGround.set(number, { result, paragraph });
    findings.push({ kind: "ground_result", value: `Λόγος ${number}: ${result === "failed" ? "απορρίφθηκε" : "επιτεύχθηκε"}`, paragraphId: paragraph.id, quote: paragraph.text.trim() });
  };
  for (const paragraph of source.paragraphs) {
    const resultRx = /(?:Ούτε\s+)?(?:ο\s+)?λόγος\s+έφεσης\s*(\d+)(?:\s|[.:—-])[^.!;]{0,180}?(δεν\s+ευσταθεί|απορρίπτεται|αποτυγχάνει|ευσταθεί|επιτυγχάνει)/giu;
    for (const match of paragraph.text.matchAll(resultRx)) {
      const negative = /^Ούτε(?:\s|$)/iu.test(match[0].trim()) || /δεν\s+ευσταθεί|απορρίπτεται|αποτυγχάνει/iu.test(match[2]);
      registerGround(match[1], negative ? "failed" : "succeeded", paragraph);
    }
    const numberedListRx = /((?:\d{1,3}(?:ος|ο|η)?(?:\s*,\s*|\s+και\s+|\s+)){2,}\d{1,3}(?:ος|ο|η)?)\s+(?:συναφείς\s+)?λόγ(?:ος|οι|ους)\s+έφεσης[^.!;]{0,120}?(είναι\s+βάσιμοι\s+και\s+επιτυγχάνουν|επιτυγχάνουν|απορρίπτονται|αποτυγχάνουν)/giu;
    for (const match of paragraph.text.matchAll(numberedListRx)) {
      const negative = /απορρίπτονται|αποτυγχάνουν/iu.test(match[2]);
      for (const number of match[1].match(/\d{1,3}/gu) || []) registerGround(number, negative ? "failed" : "succeeded", paragraph);
    }
    const trailingListRx = /(επιτυγχάνει|επιτυγχάνουν|απορρίπτεται|απορρίπτονται|αποτυγχάνει|αποτυγχάνουν)[^.!;]{0,70}?(?:ο(?:ι)?\s+)?(?:συναφείς\s+)?λόγ(?:ος|οι|ους)\s+έφεσης\s+((?:\d{1,3}(?:ος|ο|η)?(?:\s*,\s*|\s+και\s+|\s*)){1,})/giu;
    for (const match of paragraph.text.matchAll(trailingListRx)) {
      const negative = /απορρίπτ|αποτυγχάν/iu.test(match[1]);
      for (const number of match[2].match(/\d{1,3}/gu) || []) registerGround(number, negative ? "failed" : "succeeded", paragraph);
    }
  }
  if (resultByGround.size && available(specialists.procedure.groundsOrIssues)) {
    const evidence: EvidenceAnchorV2[] = [];
    specialists.procedure.groundsOrIssues.value = specialists.procedure.groundsOrIssues.value.map((ground) => {
      const found = resultByGround.get(ground.number);
      if (!found) return ground;
      evidence.push(anchor(found.paragraph, source, map, ["procedure.groundsOrIssues", "outcome.components"]));
      return { ...ground, result: found.result };
    });
    specialists.procedure.groundsOrIssues.evidence = mergeAnchors(specialists.procedure.groundsOrIssues.evidence, evidence);
    const existing = available(specialists.outcome.components) ? specialists.outcome.components.value : [];
    const components: OutcomeComponentV2[] = [...existing];
    for (const [number, found] of resultByGround) {
      if (components.some((item) => fold(item.groundOrIssue || item.target).includes(`λογο εφεσησ ${number}`))) continue;
      components.push({
        target: `Λόγος έφεσης ${number}`,
        groundOrIssue: `λόγος έφεσης ${number}`,
        result: found.result === "failed" ? "appeal_dismissed" : "appeal_allowed",
        remedy: "",
        orderText: found.paragraph.text.trim(),
      });
    }
    specialists.outcome.components = {
      status: "available",
      value: components,
      confidence: Math.max(specialists.outcome.components.confidence || 0, 0.99),
      evidence: mergeAnchors(specialists.outcome.components.evidence || [], evidence),
      conflicts: [],
    };
  }

  // The disposition is reconstructed only from the present court's operative
  // language near the end of the judgment. Earlier party submissions and
  // quotations are deliberately excluded.
  const tailStart = Math.max(0, source.paragraphs.length - 45);
  const tail = source.paragraphs.slice(tailStart).filter((paragraph) => nonQuotedCourtParagraph(paragraph, source, map));
  const operative = tail.filter((paragraph) =>
    /(?:η\s+(?:παρούσα\s+)?έφεση|appeal)[^.!;]{0,180}(?:επιτυγχ|απορρίπ|γίνεται\s+δεκτ|επιτρέπ|allowed|dismissed|succeeds?)|(?:πρωτόδικη\s+απόφαση|judgment\s+below)[^.!;]{0,180}(?:παραμερίζ|επικυρών|παραμέν|set\s+aside|upheld)|(?:επανεκδίκ|retrial|remitt)|(?:επιδικάζ|award)[^.!;]{0,90}€|(?:έξοδ|costs?)/iu.test(paragraph.text)
  );
  const operativeEvidence = operative.map((paragraph) => anchor(paragraph, source, map, ["outcome.dispositionText"]));

  const partyComponents: OutcomeComponentV2[] = [];
  const withdrawn: string[] = [];
  for (const paragraph of source.paragraphs.filter((item) => nonQuotedCourtParagraph(item, source, map))) {
    const partyResultRx = /(?:η\s+)?έφεση\s+(?:εναντίον|κατά)\s+(?:του|της|των)\s+(.{1,120}?)(?=\s+(?:έχει\s+)?(?:αποσυρ|επιτυγχ|απορρίπ|δεν\s+ευσταθ|γίνεται\s+δεκτ|επιτρέπ)|[.;·]|$)[^.!;·]{0,100}/giu;
    for (const match of paragraph.text.matchAll(partyResultRx)) {
      const result = outcomeCode(match[0]);
      if (!result) continue;
      const target = match[1].replace(/\s+/g, " ").trim();
      if (/^(?:έχει|has)$/iu.test(target)) continue;
      partyComponents.push({ target, groundOrIssue: "", result, remedy: "", orderText: paragraph.text.trim() });
      if (result === "withdrawn") withdrawn.push(paragraph.text.trim());
    }
    if (/(?:έφεση|appeal)\s+(?:εναντίον|against)\s+(?:της|του|them|it)\s+(?:έχει\s+)?(?:αποσυρ|withdrawn|abandon)/iu.test(paragraph.text) && !partyComponents.some((item) => item.orderText === paragraph.text.trim())) {
      const target = footnoteAntecedent(source, paragraph) || "αναφερόμενος διάδικος";
      partyComponents.push({ target, groundOrIssue: "", result: "withdrawn", remedy: "", orderText: paragraph.text.trim() });
      withdrawn.push(paragraph.text.trim());
    }
  }

  const groundComponents = resultByGround.size
    ? [...resultByGround].map(([number, found]) => ({
      target: `Λόγος έφεσης ${number}`,
      groundOrIssue: `λόγος έφεσης ${number}`,
      result: found.result === "failed" ? "appeal_dismissed" as const : "appeal_allowed" as const,
      remedy: "",
      orderText: found.paragraph.text.trim(),
    }))
    : [];
  const deterministicComponents = unique([...partyComponents, ...groundComponents], (item) =>
    `${fold(item.target)}|${item.result}`
  );
  if (deterministicComponents.length) {
    const componentParagraphs = source.paragraphs.filter((paragraph) =>
      deterministicComponents.some((component) => component.orderText === paragraph.text.trim())
    );
    setAvailable(
      specialists.outcome.components,
      deterministicComponents,
      componentParagraphs.map((paragraph) => anchor(paragraph, source, map, ["outcome.components"])),
    );
  }

  const explicitOverall = [...operative].reverse().find((paragraph) =>
    /(?:η\s+(?:παρούσα\s+)?έφεση|appeal)[^.!;]{0,180}(?:επιτυγχ|απορρίπ|γίνεται\s+δεκτ|επιτρέπ|allowed|dismissed|succeeds?)/iu.test(paragraph.text) &&
    !/(?:η\s+(?:παρούσα\s+)?έφεση|appeal)\s+(?:εναντίον|κατά|against)\s+(?:του|της|των)?\s*(?:Εφεσίβλητ|Respondent)/iu.test(paragraph.text)
  );
  const explicitOverallCode = explicitOverall ? outcomeCode(explicitOverall.text) : null;
  const componentOverall = overallFromComponents(partyComponents);
  const finalOverall = componentOverall || explicitOverallCode || overallFromComponents(groundComponents);
  if (finalOverall) {
    const componentParagraphs = componentOverall
      ? source.paragraphs.filter((paragraph) => partyComponents.some((component) => component.orderText === paragraph.text.trim()))
      : [];
    const fallbackParagraph = explicitOverall || operative.find((paragraph) => outcomeCode(paragraph.text)) || operative[operative.length - 1];
    setAvailable(
      specialists.outcome.overallOutcome,
      finalOverall,
      componentParagraphs.length
        ? componentParagraphs.map((paragraph) => anchor(paragraph, source, map, ["outcome.overallOutcome"]))
        : fallbackParagraph ? [anchor(fallbackParagraph, source, map, ["outcome.overallOutcome"])] : operativeEvidence,
    );
  }

  if (operative.length) {
    const disposition = unique(operative.map((paragraph) => paragraph.text.trim()), fold).join(" ");
    setAvailable(specialists.outcome.dispositionText, disposition, operativeEvidence);
    setAvailable(specialists.outcome.orders, unique(operative.map((paragraph) => paragraph.text.trim()), fold), operativeEvidence);
    operative.forEach((paragraph) => findings.push({ kind: "final_order", value: paragraph.text.trim(), paragraphId: paragraph.id, quote: paragraph.text.trim() }));
  }

  if (withdrawn.length) {
    const withdrawnParagraphs = source.paragraphs.filter((paragraph) => withdrawn.includes(paragraph.text.trim()));
    setAvailable(
      specialists.outcome.withdrawnOrAbandoned,
      unique(withdrawn, fold),
      withdrawnParagraphs.map((paragraph) => anchor(paragraph, source, map, ["outcome.withdrawnOrAbandoned"])),
    );
  }

  const remittal = operative.filter((paragraph) => /(?:επανεκδίκ|retrial|remitt)/iu.test(paragraph.text));
  if (remittal.length) {
    const values = unique(remittal.map((paragraph) => paragraph.text.trim()), fold);
    const remittalEvidence = remittal.map((paragraph) => anchor(paragraph, source, map, ["outcome.remittalInstructions"]));
    setAvailable(specialists.outcome.remittalInstructions, values, remittalEvidence);
    setAvailable(specialists.outcome.remedies, values, remittalEvidence);
  }

  const damages: MoneyAwardV2[] = [];
  const damageEvidence: EvidenceAnchorV2[] = [];
  for (const paragraph of operative) {
    if (!/(?:ζημι|damages?|compensation|αποζημί|(?:απόφαση|judgment)[^.!;]{0,120}(?:ποσό|amount))/iu.test(paragraph.text)) continue;
    const amount = paragraph.text.match(/€\s*(\d+(?:[.,]\d+)*)|(\d+(?:[.,]\d+)*)\s*(?:ευρώ|EUR)/iu);
    if (!amount) continue;
    damages.push({
      type: "damages", stage: "appellate", amount: (amount[1] || amount[2]).trim(), currency: "EUR",
      payer: partyFromOrder(paragraph.text, "εναντίον"), payee: partyFromOrder(paragraph.text, "υπέρ"),
      vatIncluded: false, vatStatus: "not_stated", interest: "",
    });
    damageEvidence.push(anchor(paragraph, source, map, ["outcome.monetaryAwards"]));
  }
  if (damages.length) setAvailable(specialists.outcome.monetaryAwards, unique(damages, (item) => `${item.type}|${item.amount}|${item.currency}|${fold(item.payer)}|${fold(item.payee)}`), damageEvidence);

  const costs: MoneyAwardV2[] = [];
  const costEvidence: EvidenceAnchorV2[] = [];
  for (const paragraph of operative) {
    if (!/(?:έξοδ|costs?)/iu.test(paragraph.text)) continue;
    const costIndex = paragraph.text.search(/(?:έξοδ|costs?)/iu);
    const costOrderText = costIndex >= 0 ? paragraph.text.slice(costIndex) : paragraph.text;
    const leadingCostAmount = paragraph.text.match(/€\s*(\d+(?:[.,]\d+)*)\s+(?:έξοδ|costs?)/iu);
    const amount = leadingCostAmount || costOrderText.match(/€\s*(\d+(?:[.,]\d+)*)|(\d+(?:[.,]\d+)*)\s*(?:ευρώ|EUR)/iu);
    const status = vatStatus(paragraph.text);
    costs.push({
      type: "costs",
      stage: costStage(paragraph.text),
      amount: (amount?.[1] || amount?.[2] || "").trim(),
      currency: amount ? "EUR" : "",
      payer: partyFromOrder(paragraph.text, "εναντίον"),
      payee: partyFromOrder(paragraph.text, "υπέρ"),
      vatIncluded: status === "included",
      vatStatus: status,
      interest: "",
    });
    costEvidence.push(anchor(paragraph, source, map, ["outcome.costs"]));
    findings.push({ kind: "costs", value: amount ? `${amount[1] || amount[2]} EUR` : paragraph.text.trim(), paragraphId: paragraph.id, quote: paragraph.text.trim() });
  }
  if (costs.length) {
    setAvailable(
      specialists.outcome.costs,
      unique(costs, (item) => `${item.stage}|${item.amount}|${fold(item.payer)}|${fold(item.payee)}|${fold(item.interest)}`),
      costEvidence,
    );
  }

  for (const paragraph of source.paragraphs) {
    if (!/τροποποι|αντικαταστά|αντικαταστα|υποκαταστά|υποκαταστα/iu.test(paragraph.text)) continue;
    const dated = paragraph.text.match(/\b\d{1,2}[./-]\d{1,2}[./-](?:19|20)\d{2}\b|\b\d{1,2}\s+[Α-Ωα-ωΆ-ώΐΰϊϋ]+\s+(?:19|20)\d{2}\b/u);
    if (dated) findings.push({ kind: "procedure_event", value: dated[0], paragraphId: paragraph.id, quote: paragraph.text.trim() });
  }

  specialists.reviewFlags = specialists.reviewFlags.filter((flag) => !/caseNumber|docket|decisionDate|legislation|groundsOrIssues|components|costs/i.test(flag));
  return { specialists, findings: unique(findings, (item) => `${item.kind}|${item.paragraphId}|${fold(item.value)}`) };
}
