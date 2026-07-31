from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def patch(path: str, old: str, new: str) -> None:
    file = ROOT / path
    content = file.read_text(encoding="utf-8")
    if old not in content:
        raise SystemExit(f"Anchor not found in {path}: {old[:100]!r}")
    file.write_text(content.replace(old, new, 1), encoding="utf-8")


old_function = '''function correctAdoptedAuthorities(
  source: JudgmentSourceV2,
  spans: SectionSpanV2[],
  reviewFlags: Set<string>,
): SectionSpanV2[] {
  const ordinal = new Map(source.paragraphs.map((paragraph) => [paragraph.id, paragraph.ordinal]));
  return spans.map((span) => {
    if (span.sectionType !== "quoted_authority") return span;
    const start = ordinal.get(span.startParagraphId) || 0;
    const end = ordinal.get(span.endParagraphId) || start;
    if (!start || !end) return span;
    const lead = source.paragraphs
      .slice(Math.max(0, start - 2), Math.min(source.paragraphs.length, end))
      .map((paragraph) => paragraph.text)
      .join(" ");
    if (!ADOPTED_AUTHORITY_RE.test(lead)) return span;
    reviewFlags.add(`section_deterministic_adopted_authority_${span.startParagraphId}`);
    return {
      ...span,
      sectionType: "adopted_authority",
      isQuotedMaterial: true,
      quotedSourceType: "case",
      confidence: Math.max(span.confidence, 0.97),
      heading: span.heading || "Ρητώς υιοθετημένη νομολογιακή αρχή",
      rationale: "Το παρόν Δικαστήριο δηλώνει ρητά ότι αναπαράγει ή υιοθετεί το παρατιθέμενο νομολογιακό πλαίσιο.",
    };
  });
}'''
new_function = '''function correctAdoptedAuthorities(
  source: JudgmentSourceV2,
  spans: SectionSpanV2[],
  reviewFlags: Set<string>,
): SectionSpanV2[] {
  const ordinal = new Map(source.paragraphs.map((paragraph) => [paragraph.id, paragraph.ordinal]));
  const output: SectionSpanV2[] = [];

  for (const span of spans) {
    if (!["quoted_authority", "adopted_authority"].includes(span.sectionType)) {
      output.push(span);
      continue;
    }
    const start = ordinal.get(span.startParagraphId) || 0;
    const end = ordinal.get(span.endParagraphId) || start;
    if (!start || !end) {
      output.push(span);
      continue;
    }
    const paragraphs = source.paragraphs.slice(start - 1, end);
    const adoptionIndex = paragraphs.findIndex((paragraph) => ADOPTED_AUTHORITY_RE.test(paragraph.text));
    if (adoptionIndex < 0) {
      output.push(span);
      continue;
    }

    reviewFlags.add(`section_deterministic_adopted_authority_${paragraphs[adoptionIndex].id}`);
    if (adoptionIndex > 0) {
      output.push({
        ...span,
        endParagraphId: paragraphs[adoptionIndex - 1].id,
        sectionType: "quoted_authority",
        speakerRole: "quoted_court",
        isQuotedMaterial: true,
        quotedSourceType: "case",
      });
    }

    const bridge = paragraphs[adoptionIndex];
    output.push({
      ...span,
      startParagraphId: bridge.id,
      endParagraphId: bridge.id,
      sectionType: "adopted_authority",
      speakerRole: "authoring_judge",
      isQuotedMaterial: false,
      quotedSourceType: "case",
      confidence: Math.max(span.confidence, 0.98),
      heading: "Ρητή υιοθέτηση νομολογιακού πλαισίου",
      rationale: "Το παρόν Δικαστήριο δηλώνει ότι αναπαράγει, επαναλαμβάνει ή υιοθετεί το νομολογιακό πλαίσιο που ακολουθεί.",
      boundaryEvidenceParagraphIds: [bridge.id],
    });

    if (adoptionIndex < paragraphs.length - 1) {
      output.push({
        ...span,
        startParagraphId: paragraphs[adoptionIndex + 1].id,
        sectionType: "quoted_authority",
        speakerRole: "quoted_court",
        isQuotedMaterial: true,
        quotedSourceType: "case",
        heading: span.heading || "Παρατιθέμενη νομολογία",
        rationale: "Το σώμα της παραπομπής παραμένει υλικό άλλης απόφασης· η ρητή υιοθέτηση καταγράφεται χωριστά.",
      });
    }
  }

  return output.map((span, index) => ({
    ...span,
    id: `S${String(index + 1).padStart(5, "0")}`,
  }));
}'''
patch("src/nomologies-v2/sections.ts", old_function, new_function)

patch(
    "src/nomologies-v2/prompts.ts",
    '''- adopted_authority: quoted reasoning from another judgment that the present court
  expressly adopts, repeats, endorses, reproduces as its own governing framework,
  or introduces with language such as «αναπαράγουμε τα εκεί λεγόμενά μας».
  Keep isQuotedMaterial=true, speakerRole=quoted_court and quotedSourceType=case.''',
    '''- adopted_authority: the present court's short adoption bridge, or a narrowly
  bounded quotation it expressly adopts. Mark only the sentence(s) carrying the
  adoption. The nested quotation that follows remains quoted_authority. An adoption
  bridge uses speakerRole=authoring_judge and isQuotedMaterial=false; verbatim
  adopted text uses speakerRole=quoted_court and isQuotedMaterial=true.''',
)

patch(
    "src/nomologies-v2/pipeline.ts",
    '''  const conflictMap = new Map<string, PipelineConflictV2>();
  for (const conflict of [...deterministic, ...reviewerConflicts(review.payload, validEvidenceRefs, specialists)]) {
    const key = `${conflict.code}|${conflict.fieldPath}|${conflict.message}`;
    if (!conflictMap.has(key)) conflictMap.set(key, conflict);
  }''',
    '''  const conflictMap = new Map<string, PipelineConflictV2>();
  for (const conflict of [...deterministic, ...reviewerConflicts(review.payload, validEvidenceRefs, specialists)]) {
    const key = conflict.code === "SOURCE_DATE_CONFLICT"
      ? `${conflict.code}|${conflict.fieldPath}`
      : `${conflict.code}|${conflict.fieldPath}|${conflict.message}`;
    const existing = conflictMap.get(key);
    if (!existing) {
      conflictMap.set(key, conflict);
      continue;
    }
    existing.evidenceIds = [...new Set([...existing.evidenceIds, ...conflict.evidenceIds])];
  }''',
)

print("Refined adopted-authority boundaries and conflict deduplication.")
