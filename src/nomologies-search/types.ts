import type {
  AuthorityCitationContextV2,
  AuthorityTreatmentV2,
  CaseFamilyV2,
  CourtLevelV2,
  LegalAreaV2,
  OutcomeCodeV2,
  ProceedingTypeV2,
  ProceduralPosture,
} from "../nomologies-v2/types.ts";

export const NOMOLOGIES_SEARCH_VERSION = "nomologies-search-v1.2.0-principles" as const;

export const SMART_TAG_KINDS = [
  "identity",
  "legal_area",
  "procedure",
  "issue",
  "principle",
  "outcome",
  "provision",
  "authority",
  "evidence",
  "fact",
  "remedy",
] as const;
export type SmartTagKindV1 = typeof SMART_TAG_KINDS[number];

export interface SmartTagV1 {
  id: string;
  label: string;
  normalized: string;
  kind: SmartTagKindV1;
  confidence: number;
  aliases: string[];
  evidenceParagraphIds: string[];
  boost: number;
  sourceField: string;
}

export const SEARCH_FIELD_NAMES = [
  "identity",
  "principle",
  "ratio",
  "holding",
  "issues",
  "provisions",
  "authorities",
  "outcome",
  "procedure",
  "facts",
  "evidence",
  "chronology",
] as const;
export type SearchFieldNameV1 = typeof SEARCH_FIELD_NAMES[number];

export interface WeightedSearchFieldV1 {
  name: SearchFieldNameV1;
  text: string;
  normalized: string;
  weight: number;
  paragraphIds: string[];
}

export interface SearchFacetsV1 {
  caseFamily: CaseFamilyV2 | "";
  legalAreas: LegalAreaV2[];
  primaryLegalArea: LegalAreaV2 | "";
  proceedingType: ProceedingTypeV2 | "";
  proceduralPosture: ProceduralPosture | "";
  courtLevel: CourtLevelV2 | "";
  court: string;
  year: number | null;
  judges: string[];
  authoringJudges: string[];
  outcomes: OutcomeCodeV2[];
  lawIds: string[];
  provisionKeys: string[];
  authorityTreatments: AuthorityTreatmentV2[];
  authorityContexts: AuthorityCitationContextV2[];
  principleIds: string[];
}

export interface SearchAuthoritySignalsV1 {
  score: number;
  tier: "Landmark" | "Leading Authority" | "High" | "Medium" | "Low";
  factors: {
    courtLevel: number;
    treatment: number;
    novelty: number;
    subsequentCitation: number;
    doctrinalSignificance: number;
  };
}

export interface SearchQualitySignalsV1 {
  readinessScore: number;
  strictReady: boolean;
  humanReviewRequired: boolean;
  criticalConflicts: number;
  materialConflicts: number;
  evidenceCount: number;
}

export interface SearchDocumentV1 {
  schemaVersion: typeof NOMOLOGIES_SEARCH_VERSION;
  id: string;
  runId: string;
  sourceUrl: string;
  sourceHash: string;
  title: string;
  shortTitle: string;
  citation: string;
  caseNumber: string;
  decisionDate: string;
  year: number | null;
  court: string;
  judges: string[];
  authoringJudges: string[];
  outcome: OutcomeCodeV2 | "";
  aliases: string[];
  exactTerms: string[];
  smartTags: SmartTagV1[];
  facets: SearchFacetsV1;
  fields: WeightedSearchFieldV1[];
  authority: SearchAuthoritySignalsV1;
  quality: SearchQualitySignalsV1;
  createdAt: string;
  updatedAt: string;
}

export interface SearchFiltersV1 {
  caseFamily?: CaseFamilyV2;
  legalArea?: LegalAreaV2;
  proceedingType?: ProceedingTypeV2;
  proceduralPosture?: ProceduralPosture;
  courtLevel?: CourtLevelV2;
  court?: string;
  judge?: string;
  authoringJudge?: string;
  outcome?: OutcomeCodeV2;
  lawId?: string;
  provision?: string;
  authorityTreatment?: AuthorityTreatmentV2;
  authorityContext?: AuthorityCitationContextV2;
  yearFrom?: number;
  yearTo?: number;
}

export type SearchIntentV1 =
  | "identity"
  | "provision"
  | "principle"
  | "authority"
  | "outcome"
  | "procedure"
  | "facts"
  | "evidence"
  | "general";

export interface ParsedSearchQueryV1 {
  raw: string;
  normalized: string;
  intent: SearchIntentV1;
  terms: string[];
  expandedTerms: string[];
  exactPhrases: string[];
  excludedTerms: string[];
  detectedCaseNumbers: string[];
  detectedCitations: string[];
  detectedProvisions: string[];
  filters: SearchFiltersV1;
}

export interface SearchScoreBreakdownV1 {
  exactIdentity: number;
  phrase: number;
  lexical: number;
  smartTags: number;
  facets: number;
  semantic: number;
  authority: number;
  quality: number;
  total: number;
}

export interface SearchHitV1 {
  document: SearchDocumentV1;
  score: number;
  scoreBreakdown: SearchScoreBreakdownV1;
  matchedFields: SearchFieldNameV1[];
  matchedTags: SmartTagV1[];
  whyMatched: string[];
  snippet: string;
  snippetField: SearchFieldNameV1;
}

export interface SearchFacetBucketV1 {
  value: string;
  count: number;
}

export interface SearchFacetResponseV1 {
  caseFamilies: SearchFacetBucketV1[];
  legalAreas: SearchFacetBucketV1[];
  proceedingTypes: SearchFacetBucketV1[];
  courts: SearchFacetBucketV1[];
  judges: SearchFacetBucketV1[];
  outcomes: SearchFacetBucketV1[];
  lawIds: SearchFacetBucketV1[];
  years: SearchFacetBucketV1[];
}

export interface EliteSearchResponseV1 {
  query: ParsedSearchQueryV1;
  hits: SearchHitV1[];
  facets: SearchFacetResponseV1;
  semanticUsed: boolean;
  indexSize: number;
  elapsedMs: number;
}
