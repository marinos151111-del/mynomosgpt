import type {
  AuthorityCitationContextV2,
  AuthorityTreatmentV2,
  CourtLevelV2,
  PrecedentialWeightV2,
} from "./types.ts";

export const AUTHORITY_MODEL_VERSION = "authority-weight-v1.0.0" as const;

export interface IncomingAuthoritySignalV2 {
  citingCaseId: string;
  treatment: AuthorityTreatmentV2;
  citationContext: AuthorityCitationContextV2;
  legalPoint: string;
  citingDecisionYear?: number | null;
}

export interface AuthorityCorpusSignalsV2 {
  incoming?: IncomingAuthoritySignalV2[];
  independentlyVerifiedNovelty?: boolean;
}

const COURT_BASE: Partial<Record<CourtLevelV2, number>> = {
  supreme_full_bench: 82,
  supreme_constitutional_court: 78,
  supreme_court: 72,
  court_of_appeal: 68,
  administrative_court_of_appeal: 62,
  administrative_court: 48,
  district_court: 38,
  assize_court: 38,
  family_court: 36,
  industrial_disputes_court: 36,
  administrative_court_of_international_protection: 44,
  specialist_tribunal: 32,
  other: 30,
  unknown: 30,
};

const TREATMENT_VALUE: Record<AuthorityTreatmentV2, number> = {
  followed: 2.5,
  applied: 2,
  adopted: 2.25,
  approved: 2.75,
  distinguished: -0.5,
  doubted: -2,
  disapproved: -3,
  overruled: -12,
  not_followed: -4,
  considered: 0.25,
  cited: 0,
  mentioned: 0,
  unknown: 0,
};

function bounded(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function tierFor(score: number): PrecedentialWeightV2["tier"] {
  if (score >= 90) return "Landmark";
  if (score >= 80) return "Leading Authority";
  if (score >= 65) return "High";
  if (score >= 45) return "Medium";
  return "Low";
}

function strongestSignals(incoming: IncomingAuthoritySignalV2[]): IncomingAuthoritySignalV2[] {
  const byCase = new Map<string, IncomingAuthoritySignalV2>();
  for (const signal of incoming) {
    const key = signal.citingCaseId.trim();
    if (!key) continue;
    const current = byCase.get(key);
    if (!current || Math.abs(TREATMENT_VALUE[signal.treatment]) > Math.abs(TREATMENT_VALUE[current.treatment])) byCase.set(key, signal);
  }
  return [...byCase.values()];
}

/**
 * Precedential weight is intentionally independent from extraction confidence
 * and publication readiness. Corpus factors remain zero until a resolved,
 * independently indexed incoming citation establishes them.
 */
export function calculatePrecedentialWeight(
  courtLevel: CourtLevelV2 | string,
  signals: AuthorityCorpusSignalsV2 = {},
): PrecedentialWeightV2 {
  const incoming = strongestSignals(signals.incoming || []);
  const courtLevelFactor = COURT_BASE[courtLevel as CourtLevelV2] ?? COURT_BASE.unknown!;
  const treatment = Number(bounded(
    incoming.reduce((sum, signal) => sum + TREATMENT_VALUE[signal.treatment], 0),
    -12,
    8,
  ).toFixed(2));
  const subsequentCitation = Number(bounded(
    incoming.length ? Math.log2(1 + incoming.length) * 2.25 : 0,
    0,
    8,
  ).toFixed(2));
  const directDoctrinalCitations = incoming.filter((signal) =>
    signal.citationContext === "direct" && signal.legalPoint.trim().length >= 24
  ).length;
  const adoptedDoctrinalCitations = incoming.filter((signal) => signal.citationContext === "adopted_quotation").length;
  const doctrinalSignificance = Number(bounded(
    directDoctrinalCitations * 1.5 + adoptedDoctrinalCitations,
    0,
    9,
  ).toFixed(2));
  const novelty = signals.independentlyVerifiedNovelty ? 3 : 0;
  const factors = {
    courtLevel: courtLevelFactor,
    treatment,
    novelty,
    subsequentCitation,
    doctrinalSignificance,
  };
  const score = Math.round(bounded(Object.values(factors).reduce((sum, value) => sum + value, 0), 0, 100));
  return { score, tier: tierFor(score), factors };
}

export function basePrecedentialWeight(courtLevel: CourtLevelV2 | string): PrecedentialWeightV2 {
  return calculatePrecedentialWeight(courtLevel);
}
