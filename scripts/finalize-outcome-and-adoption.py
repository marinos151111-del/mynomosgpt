from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def patch(path: str, old: str, new: str) -> None:
    file = ROOT / path
    content = file.read_text(encoding="utf-8")
    if old not in content:
        raise SystemExit(f"Anchor not found in {path}: {old[:140]!r}")
    file.write_text(content.replace(old, new, 1), encoding="utf-8")


patch(
    "src/nomologies-v2/quality-core.ts",
    '''function reconcileRelief(
  procedure: CaseProcedureV2,
  outcome: CaseOutcomeV2,
  flags: Set<string>,
): void {''',
    '''function normalizeApplicationOutcome(
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
): void {''',
)
patch(
    "src/nomologies-v2/quality-core.ts",
    '''  const expedition = reconcileExpeditionClassification(input);
  clearInventedGroundNumbers(input.procedure, input.context, input.flags);
  reconcileRelief(input.procedure, input.outcome, input.flags);''',
    '''  const expedition = reconcileExpeditionClassification(input);
  normalizeApplicationOutcome(expedition, input.outcome, input.flags);
  clearInventedGroundNumbers(input.procedure, input.context, input.flags);
  reconcileRelief(input.procedure, input.outcome, input.flags);''',
)

patch(
    "src/nomologies-v2/quality-authorities.ts",
    '''  const span = context.sectionByParagraphId.get(sourceMatch.id);
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
  if (span.sectionType === "adopted_authority") return sourceAnchor;''',
    '''  const span = context.sectionByParagraphId.get(sourceMatch.id);
  if (!span) return extracted;
  const explicitAdoption = /(?:αναπαράγ(?:ουμε|εται|ονται)(?:\\s+πιο\\s+κάτω)?\\s+(?:τα\\s+εκεί\\s+λεγόμενα|τις\\s+αρχές)|υιοθετ(?:ούμε|είται|ούνται)|επαναλαμβάν(?:ουμε|εται|ονται)(?:\\s+ως\\s+δικές?\\s+μας)?|expressly\\s+adopt)/iu.test(sourceMatch.text);
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
  if (explicitAdoption || span.sectionType === "adopted_authority") return sourceAnchor;''',
)

print("Finalized application outcome normalization and explicit adoption provenance.")
