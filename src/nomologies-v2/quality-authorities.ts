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
  if (!instruments.some(isCprInstrument)) {
    const cprParagraph = context.source.paragraphs.find((paragraph) =>
      /Μέρ(?:ους|ος)\s*41\.4(?:\(2\)\(δ\)|\(4\))/u.test(paragraph.text)
    );
    if (cprParagraph) instruments.push(cprInstrument());
  }

  const normalized = instruments.map((instrument) => {
    if (isCprInstrument(instrument)) {
      return { ...instrument, primary: true, role: "procedural" as const };
    }
    if (isArticle32Instrument(instrument)) {
      return { ...instrument, primary: false, role: "background" as const };
    }
    return instrument;
  });

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
    /άρθρ(?:ο|ου)\s*32[^\n]{0,100}(?:14\/60|περί\s+Δικαστηρίων)/iu,
    "authorities.legislation",
    ["contextual law governing underlying interim order"],
    new Set<SectionType>(["legal_framework", "court_analysis", "legal_findings"]),
  );
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

function supportingAnchor(
  authority: AuthorityV2,
  evidence: EvidenceAnchorV2[],
): EvidenceAnchorV2 | undefined {
  const name = authority.name.toLocaleLowerCase("el");
  const token = name
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .slice(0, 4)
    .join(" ");

  return evidence.find((anchor) => {
    const supports = anchor.supports.join(" ").toLocaleLowerCase("el");
    const quote = anchor.quote.toLocaleLowerCase("el").replace(/[^\p{L}\p{N}]+/gu, " ");
    return supports.includes(name) || (token.length > 6 && quote.includes(token));
  });
}

function citationContextFor(
  authority: AuthorityV2,
  anchor: EvidenceAnchorV2 | undefined,
): AuthorityCitationContextV2 {
  if (!anchor) return authority.citationContext || "unknown";
  if (anchor.sectionType === "adopted_authority") {
    if (/(?:αναπαράγ|παραθέτουμε\s+απόσπασμα|υιοθετ|adopt|reproduc)/iu.test(anchor.quote)) {
      return "adopted_quotation";
    }
    return "nested_quotation";
  }
  if (anchor.sectionType === "quoted_authority") return "nested_quotation";
  return "direct";
}

function reconcileAuthorityContexts(authorities: CaseAuthoritiesV2): void {
  if (authorities.authorities.status !== "available") return;
  authorities.authorities.value = authorities.authorities.value.map((authority) => {
    const anchor = supportingAnchor(authority, authorities.authorities.evidence);
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
  reconcileAuthorityContexts(input.authorities);
}
