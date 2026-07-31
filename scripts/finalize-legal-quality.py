from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def patch(path: str, old: str, new: str) -> None:
    file = ROOT / path
    content = file.read_text(encoding="utf-8")
    if old not in content:
        raise SystemExit(f"Anchor not found in {path}: {old[:140]!r}")
    file.write_text(content.replace(old, new, 1), encoding="utf-8")


patch(
    "src/nomologies-v2/quality-authorities.ts",
    '''function reconcileLegislationHierarchy(input: {
  expedition: boolean;
  context: EvidenceValidationContext;
  authorities: CaseAuthoritiesV2;
  flags: Set<string>;
}): void {''',
    '''function article32Instrument(): LegalInstrumentV2 {
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
}): void {''',
)

old_hierarchy = '''  const instruments = authorities.legislation.status === "available"
    ? [...authorities.legislation.value]
    : [];
  if (!instruments.some(isCprInstrument)) {
    const cprParagraph = context.source.paragraphs.find((paragraph) =>
      /Μέρ(?:ους|ος)\\s*41\\.4(?:\\(2\\)\\(δ\\)|\\(4\\))/u.test(paragraph.text)
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
    /Μέρ(?:ους|ος)\\s*41\\.4(?:\\(2\\)\\(δ\\)|\\(4\\))/u,
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
    /άρθρ(?:ο|ου)\\s*32[^\\n]{0,100}(?:14\\/60|περί\\s+Δικαστηρίων)/iu,
    "authorities.legislation",
    ["contextual law governing underlying interim order"],
    new Set<SectionType>(["legal_framework", "court_analysis", "legal_findings"]),
  );'''
new_hierarchy = '''  const instruments = authorities.legislation.status === "available"
    ? [...authorities.legislation.value]
    : [];

  const cprAnchor = findSourceEvidence(
    context,
    /Μέρ(?:ους|ος)\\s*41\\.4(?:\\(2\\)\\(δ\\)|\\(4\\))/u,
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
    /άρθρ(?:ο|ου)\\s*32[^\\n]{0,140}(?:14\\/60|περί\\s+Δικαστηρίων)/iu,
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
  });'''
patch("src/nomologies-v2/quality-authorities.ts", old_hierarchy, new_hierarchy)

old_context = '''function supportingAnchor(
  authority: AuthorityV2,
  evidence: EvidenceAnchorV2[],
): EvidenceAnchorV2 | undefined {
  const name = authority.name.toLocaleLowerCase("el");
  const token = name
    .replace(/[^\\p{L}\\p{N}]+/gu, " ")
    .trim()
    .split(/\\s+/u)
    .slice(0, 4)
    .join(" ");

  return evidence.find((anchor) => {
    const supports = anchor.supports.join(" ").toLocaleLowerCase("el");
    const quote = anchor.quote.toLocaleLowerCase("el").replace(/[^\\p{L}\\p{N}]+/gu, " ");
    return supports.includes(name) || (token.length > 6 && quote.includes(token));
  });
}

function citationContextFor(
  authority: AuthorityV2,
  anchor: EvidenceAnchorV2 | undefined,
): AuthorityCitationContextV2 {
  if (!anchor) return authority.citationContext || "unknown";
  if (anchor.sectionType === "adopted_authority") {
    if (/(?:αναπαράγ|παραθέτουμε\\s+απόσπασμα|υιοθετ|adopt|reproduc)/iu.test(anchor.quote)) {
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
}'''
new_context = '''function normalizedAuthorityToken(value: string): string {
  return value
    .toLocaleLowerCase("el")
    .replace(/[^\\p{L}\\p{N}]+/gu, " ")
    .trim()
    .split(/\\s+/u)
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
  const sourceAnchor: EvidenceAnchorV2 = {
    id: `EV_authorities_context_det_${sourceMatch.ordinal}`,
    paragraphIds: [sourceMatch.id],
    quote: sourceMatch.text,
    sectionType: span.sectionType,
    speakerRole: span.speakerRole,
    supports: [authority.name, "citation provenance"],
    exactMatch: true,
  };

  // A deterministic adoption bridge takes precedence over model-selected nested
  // evidence because it records what the present court did with the authority.
  if (span.sectionType === "adopted_authority") return sourceAnchor;
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
}'''
patch("src/nomologies-v2/quality-authorities.ts", old_context, new_context)
patch(
    "src/nomologies-v2/quality-authorities.ts",
    '''  reconcileAuthorityContexts(input.authorities);''',
    '''  reconcileAuthorityContexts(input.context, input.authorities);''',
)

patch(
    "src/nomologies-v2/pipeline.ts",
    '''    const key = conflict.code === "SOURCE_DATE_CONFLICT"
      ? `${conflict.code}|${conflict.fieldPath}`
      : `${conflict.code}|${conflict.fieldPath}|${conflict.message}`;''',
    '''    const key = conflict.code === "SOURCE_DATE_CONFLICT"
      ? conflict.code
      : `${conflict.code}|${conflict.fieldPath}|${conflict.message}`;''',
)

print("Finalized deterministic legislation recovery, authority provenance and conflict deduplication.")
