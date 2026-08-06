// Deterministic post-extraction reconciliation for evidence-grounded legal quality.
// Final E5/2025 regression marker: classification, provenance, scoring, boundaries and source conflicts.
import type { EvidenceValidationContext } from "./evidence.ts";
import { reconcileAuthorityQuality } from "./quality-authorities.ts";
import { reconcileCoreQuality } from "./quality-core.ts";
import type {
  CaseAnalysisV2,
  CaseAuthoritiesV2,
  CaseClassificationV2,
  CaseOutcomeV2,
  CaseProcedureV2,
  JudgmentSourceV2,
  PipelineConflictV2,
} from "./types.ts";

export function reconcileNomologiesQuality(input: {
  source: JudgmentSourceV2;
  context: EvidenceValidationContext;
  classification: CaseClassificationV2;
  procedure: CaseProcedureV2;
  analysis: CaseAnalysisV2;
  authorities: CaseAuthoritiesV2;
  outcome: CaseOutcomeV2;
  flags: Set<string>;
}): void {
  const { expedition } = reconcileCoreQuality({
    source: input.source,
    context: input.context,
    classification: input.classification,
    procedure: input.procedure,
    analysis: input.analysis,
    outcome: input.outcome,
    flags: input.flags,
  });
  reconcileAuthorityQuality({
    expedition,
    context: input.context,
    authorities: input.authorities,
    flags: input.flags,
  });
}

function normalizedDate(value: string): string {
  const [day, month, year] = value.replace(/-/g, ".").split(".");
  const fullYear = year.length === 2 ? `20${year}` : year;
  return `${day.padStart(2, "0")}.${month.padStart(2, "0")}.${fullYear}`;
}

export function detectSourceDateConflicts(
  source: JudgmentSourceV2,
): PipelineConflictV2[] {
  const labelPattern = /(?:εκκαλούμεν(?:η|ης)\s+απόφαση|πρωτόδικ(?:η|ης)\s+απόφαση|appealed\s+decision|lower[-\s]court\s+decision)/iu;
  const datePattern = /\b([0-3]?\d[.\/-][01]?\d[.\/-](?:19|20)?\d{2})\b/u;
  const found = new Map<string, Set<string>>();

  for (const paragraph of source.paragraphs) {
    const label = labelPattern.exec(paragraph.text);
    labelPattern.lastIndex = 0;
    if (!label || label.index === undefined) continue;
    const nearby = paragraph.text.slice(label.index, label.index + 260);
    const match = nearby.match(datePattern);
    if (!match) continue;
    const key = normalizedDate(match[1]);
    const ids = found.get(key) || new Set<string>();
    ids.add(paragraph.id);
    found.set(key, ids);
  }

  if (found.size <= 1) return [];
  const dates = [...found.keys()].sort();
  const evidenceIds = [...found.values()].flatMap((ids) => [...ids]);
  return [{
    code: "SOURCE_DATE_CONFLICT",
    severity: "material",
    fieldPath: "source.lowerCourtDecisionDate",
    message: `Η πηγή αναφέρει διαφορετικές ημερομηνίες για την ίδια εκκαλούμενη ή πρωτόδικη απόφαση: ${dates.join(" και ")}. Απαιτείται ανθρώπινη επιβεβαίωση.`,
    evidenceIds,
  }];
}

