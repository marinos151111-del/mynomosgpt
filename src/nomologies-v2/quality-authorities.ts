import type { EvidenceValidationContext } from "./evidence.ts";
import {
  clearQualityFlags,
  findSourceEvidence,
  groundedField,
  uniqueEvidence,
} from "./quality-core.ts";
import type {
  AuthorityCitationContextV2,
  AuthorityTreatmentV2,
  AuthorityV2,
  CaseAuthoritiesV2,
  EvidenceAnchorV2,
  LegalInstrumentV2,
  SectionType,
} from "./types.ts";

function isCprInstrument(instrument: LegalInstrumentV2): boolean {
  const text = `${instrument.lawId} ${instrument.lawLabel} ${instrument.instrumentName} ${
    instrument.provisions.map((provision) => `${provision.part} ${provision.display}`).join(" ")
  }`;
  return /(?:Κανονισμ(?:οί|ών)\s+Πολιτικής\s+Δικονομίας|CPR).*2023|41\.4/iu.test(text);
}

function isArticle32Instrument(instrument: LegalInstrumentV2): boolean {
  const text = `${instrument.lawId} ${instrument.lawLabel} ${instrument.instrumentName} ${
    instrument.provisions.map((provision) => `${provision.article} ${provision.display}`).join(" ")
  }`;
  return /(?:14\/60|περί\s+Δικαστηρίων)[\s\S]*?(?:άρθρο|article)?\s*32|(?:άρθρο|article)\s*32[\s\S]*?(?:14\/60|περί\s+Δικαστηρίων)/iu.test(text);
}

function cprInstrument(): LegalInstrumentV2 {
  return {
    lawId: "CPR-2023",
    lawLabel: "Κανονισμοί Πολιτικής Δικονομίας του 2023",
    instrumentName: "Κανονισμοί Πολιτικής Δικονομίας του 2023",
    instrumentType: "rule",
    role: "procedural",
    primary: true,
    provisions: [
      {
        display: "Μέρος 41.4(2)(δ)",
        article: "",
        paragraph: "2",
        subparagraph: "δ",
        part: "41.4",
        normalized: "Part 41.4(2)(d)",
        application: "considered",
      },
      {
        display: "Μέρος 41.4(4)",
        article: "",
        paragraph: "4",
        subparagraph: "",
        part: "41.4",
        normalized: "Part 41.4(4)",
        application: "considered",
      },
    ],
    proposition: "Οι Κανονισμοί Πολιτικής Δικονομίας 2023 αποτελούν την άμεση διαδικαστική βάση για την επίσπευση και κατά προτεραιότητα εκδίκαση έφεσης.",
  };
}

function article32Instrument(): LegalInstrumentV2 {
  return {
    lawId: "14/60",
    lawLabel: "περί Δικαστηρίων Νόμου 14/60",
    instrumentName: "περί Δικαστηρίων Νόμου 14/60",
    instrumentType: "law",
    role: "background",
    primary: false,
    provisions: [{
      display: "άρθρο 32",
      article: "32",
      paragraph: "",
      subparagraph: "",
      part: "",
      normalized: "article 32",
      application: "considered",
    }],
    proposition: "Το άρθρο 32 αφορά το περιορισμένο πλαίσιο της υποκείμενης ενδιάμεσης διαδικασίας και δεν αποτελεί την άμεση βάση του αιτήματος επίσπευσης.",
  };
}

function reconcileLegislationHierarchy(input: {
  expedition: boolean;
  context: EvidenceValidationContext;
  authorities: CaseAuthoritiesV2;
  flags: Set<string>;
}): void {
  const { expedition, context, authorities, flags } = input;
  if (!expedition) return;

  const instruments = authorities.legislation.status === "available"
    ? [...authorities.legislation.value]
    : [];

  const cprAnchor = findSourceEvidence(
    context,
    /Μέρ(?:ους|ος)\s*41\.4(?:\(2\)\(δ\)|\(4\))/u,
    "authorities.legislation",
    ["immediate procedural basis for expedition"],
    new Set<SectionType>([
      "adopted_authority",
      "quoted_authority",
      "legal_framework",
      "court_analysis",
    ]),
  );
  const article32Anchor = findSourceEvidence(
    context,
    /άρθρ(?:ο|ου)\s*32[^\n]{0,140}(?:14\/60|περί\s+Δικαστηρίων)/iu,
    "authorities.legislation",
    ["contextual law governing underlying interim order"],
    new Set<SectionType>(["legal_framework", "court_analysis", "legal_findings"]),
  );

  if (!instruments.some(isCprInstrument) && cprAnchor) instruments.push(cprInstrument());
  if (!instruments.some(isArticle32Instrument) && article32Anchor) instruments.push(article32Instrument());

  const normalized = instruments.map((instrument) => {
    if (isCprInstrument(instrument)) {
      return { ...instrument, primary: true, role: "procedural" as const };
    }
    if (isArticle32Instrument(instrument)) {
      return { ...instrument, primary: false, role: "background" as const };
    }
    return instrument;
  });
  const allEvidence = uniqueEvidence([
    ...authorities.legislation.evidence,
    ...(cprAnchor ? [cprAnchor] : []),
    ...(article32Anchor ? [article32Anchor] : []),
  ]);
  if (!normalized.length || !allEvidence.length) return;

  const primary = normalized.filter((instrument) => instrument.primary);
  const contextual = normalized.filter((instrument) => !instrument.primary);
  authorities.legislation = groundedField(normalized, allEvidence, 0.98);
  authorities.primaryLegislation = primary.length
    ? groundedField(primary, cprAnchor ? [cprAnchor] : allEvidence, 0.98)
    : { status: "unavailable", value: [], confidence: 0, evidence: [], conflicts: [] };
  authorities.secondaryLegislation = contextual.length
    ? groundedField(contextual, article32Anchor ? [article32Anchor] : allEvidence, 0.95)
    : { status: "unavailable", value: [], confidence: 0, evidence: [], conflicts: [] };

  clearQualityFlags(flags, [
    "authorities.legislation",
    "authorities.primaryLegislation",
    "authorities.secondaryLegislation",
  ]);
}

function normalizedAuthorityToken(value: string): string {
  return value
    .toLocaleLowerCase("el")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .slice(0, 5)
    .join(" ");
}

function anchorMentionsAuthority(anchor: EvidenceAnchorV2, authority: AuthorityV2): boolean {
  const fullName = authority.name.toLocaleLowerCase("el");
  const token = normalizedAuthorityToken(authority.name);
  const supports = anchor.supports.join(" ").toLocaleLowerCase("el");
  const quote = normalizedAuthorityToken(anchor.quote);
  return supports.includes(fullName) || (token.length > 6 && quote.includes(token));
}

function supportingAnchor(
  context: EvidenceValidationContext,
  authority: AuthorityV2,
  evidence: EvidenceAnchorV2[],
): EvidenceAnchorV2 | undefined {
  const extracted = evidence.find((anchor) => anchorMentionsAuthority(anchor, authority));
  const token = normalizedAuthorityToken(authority.name);
  const sourceMatch = context.source.paragraphs.find((paragraph) => {
    const normalized = normalizedAuthorityToken(paragraph.text);
    return token.length > 6 && normalized.includes(token);
  });
  if (!sourceMatch) return extracted;

  const span = context.sectionByParagraphId.get(sourceMatch.id);
  if (!span) return extracted;
  const explicitAdoption = /(?:αναπαράγ(?:ουμε|εται|ονται)(?:\s+πιο\s+κάτω)?\s+(?:τα\s+εκεί\s+λεγόμενα|τις\s+αρχές)|υιοθετ(?:ούμε|είται|ούνται)|επαναλαμβάν(?:ουμε|εται|ονται)(?:\s+ως\s+δικές?\s+μας)?|expressly\s+adopt)/iu.test(sourceMatch.text);
  const sourceAnchor: EvidenceAnchorV2 = {
    id: `EV_authorities_context_det_${sourceMatch.ordinal}`,
    paragraphIds: [sourceMatch.id],
    quote: sourceMatch.text,
    sectionType: explicitAdoption ? "adopted_authority" : span.sectionType,
    speakerRole: explicitAdoption ? "authoring_judge" : span.speakerRole,
    supports: [authority.name, "citation provenance"],
    exactMatch: true,
  };

  // Explicit adoption language takes precedence over model-selected nested
  // evidence because it records what the present court did with the authority.
  if (explicitAdoption || span.sectionType === "adopted_authority") return sourceAnchor;
  return extracted || sourceAnchor;
}

function citationContextFor(
  authority: AuthorityV2,
  anchor: EvidenceAnchorV2 | undefined,
): AuthorityCitationContextV2 {
  if (!anchor) return authority.citationContext || "unknown";
  if (anchor.sectionType === "adopted_authority") return "adopted_quotation";
  if (anchor.sectionType === "quoted_authority") return "nested_quotation";
  return "direct";
}

function reconcileAuthorityContexts(
  context: EvidenceValidationContext,
  authorities: CaseAuthoritiesV2,
): void {
  if (authorities.authorities.status !== "available") return;
  authorities.authorities.value = authorities.authorities.value.map((authority) => {
    const anchor = supportingAnchor(context, authority, authorities.authorities.evidence);
    const citationContext = citationContextFor(authority, anchor);
    const treatment: AuthorityTreatmentV2 =
      citationContext === "adopted_quotation" &&
        ["cited", "mentioned", "unknown"].includes(authority.treatment)
        ? "adopted"
        : authority.treatment;
    return {
      ...authority,
      treatment,
      citationContext,
      quoted: citationContext !== "direct",
    };
  });
}

export function reconcileAuthorityQuality(input: {
  expedition: boolean;
  context: EvidenceValidationContext;
  authorities: CaseAuthoritiesV2;
  flags: Set<string>;
}): void {
  reconcileLegislationHierarchy(input);
  reconcileAuthorityContexts(input.context, input.authorities);
}
