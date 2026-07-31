// Nomologies Pipeline V2 — canonical, evidence-first case-law contract.
//
// This contract is intentionally richer than the legacy CaseProfile. It keeps
// every useful legacy field while separating identity, procedure, facts,
// submissions, judicial analysis, legislation, authorities and disposition.
// No material field is publishable without paragraph-linked evidence.

export const NOMOLOGIES_V2_VERSION = "nomologies-v2.1.0" as const;

export const SECTION_TYPES = [
  "caption",
  "court_header",
  "case_metadata",
  "appearances",
  "procedural_history",
  "facts",
  "witness_evidence",
  "documentary_evidence",
  "appellant_submissions",
  "respondent_submissions",
  "applicant_submissions",
  "respondent_public_body_submissions",
  "prosecution_submissions",
  "defence_submissions",
  "other_party_submissions",
  "legal_framework",
  "quoted_legislation",
  "quoted_authority",
  "adopted_authority",
  "court_analysis",
  "findings_of_fact",
  "legal_findings",
  "holding",
  "ratio_decidendi",
  "obiter_dictum",
  "dissent",
  "concurrence",
  "disposition",
  "remedy",
  "sentence",
  "damages",
  "costs",
  "signature",
  "appendix",
  "other",
] as const;
export type SectionType = typeof SECTION_TYPES[number];

export const SPEAKER_ROLES = [
  "court",
  "authoring_judge",
  "concurring_judge",
  "dissenting_judge",
  "appellant",
  "respondent",
  "applicant",
  "public_body",
  "prosecution",
  "defence",
  "witness",
  "expert_witness",
  "registrar",
  "legislature",
  "quoted_court",
  "quoted_author",
  "unknown",
] as const;
export type SpeakerRole = typeof SPEAKER_ROLES[number];

export const CASE_FAMILIES = [
  "criminal_law",
  "private_law",
  "public_law",
  "constitutional_law",
  "family_law",
  "employment_law",
  "admiralty",
  "disciplinary",
  "mixed",
  "unknown",
] as const;
export type CaseFamilyV2 = typeof CASE_FAMILIES[number];

export const LEGAL_AREAS = [
  "criminal",
  "criminal_procedure",
  "evidence",
  "sentencing",
  "extradition",
  "european_arrest_warrant",
  "civil_procedure",
  "contract",
  "tort",
  "negligence",
  "personal_injury",
  "medical_negligence",
  "damages",
  "property",
  "land_registry",
  "rent_control",
  "banking",
  "security_and_mortgages",
  "insurance",
  "company",
  "insolvency",
  "liquidation",
  "construction",
  "commercial",
  "probate",
  "succession",
  "trusts",
  "family",
  "employment",
  "immigration",
  "asylum",
  "habeas_corpus",
  "prerogative_writs",
  "administrative",
  "constitutional",
  "human_rights",
  "tax",
  "customs",
  "vat",
  "public_service",
  "public_procurement",
  "planning",
  "competition",
  "social_insurance",
  "professional_regulation",
  "education",
  "electoral",
  "disciplinary",
  "admiralty",
  "other",
  "unknown",
] as const;
export type LegalAreaV2 = typeof LEGAL_AREAS[number];

export const PROCEEDING_TYPES = [
  "criminal_appeal",
  "sentence_appeal",
  "prosecution_appeal",
  "civil_appeal",
  "administrative_appeal",
  "constitutional_appeal",
  "family_appeal",
  "employment_appeal",
  "land_registry_appeal",
  "eaw_appeal",
  "trial",
  "recourse_article_146",
  "constitutional_reference",
  "election_petition",
  "company_petition",
  "insolvency_petition",
  "interim_application",
  "expedition_application",
  "leave_application",
  "extension_of_time_application",
  "legal_aid_application",
  "certiorari",
  "prohibition",
  "mandamus",
  "habeas_corpus",
  "extradition_proceeding",
  "eaw_proceeding",
  "disciplinary_objection",
  "application",
  "appeal",
  "other",
  "unknown",
] as const;
export type ProceedingTypeV2 = typeof PROCEEDING_TYPES[number];

export const PROCEDURAL_POSTURES = [
  "first_instance",
  "appeal",
  "cross_appeal",
  "leave_stage",
  "permission_stage",
  "substantive_writ_hearing",
  "interim_stage",
  "rehearing",
  "remittal",
  "consolidated_proceedings",
  "reference",
  "unknown",
] as const;
export type ProceduralPosture = typeof PROCEDURAL_POSTURES[number];

export const COURT_LEVELS = [
  "district_court",
  "assize_court",
  "family_court",
  "industrial_disputes_court",
  "administrative_court",
  "administrative_court_of_international_protection",
  "administrative_court_of_appeal",
  "court_of_appeal",
  "supreme_court",
  "supreme_constitutional_court",
  "supreme_full_bench",
  "specialist_tribunal",
  "other",
  "unknown",
] as const;
export type CourtLevelV2 = typeof COURT_LEVELS[number];

export const OUTCOME_CODES = [
  "allowed",
  "partly_allowed",
  "dismissed",
  "appeal_allowed",
  "appeal_partly_allowed",
  "appeal_dismissed",
  "application_allowed",
  "application_partly_allowed",
  "application_dismissed",
  "leave_granted",
  "leave_refused",
  "convicted",
  "conviction_upheld",
  "conviction_quashed",
  "acquitted",
  "sentence_upheld",
  "sentence_varied",
  "sentence_reduced",
  "sentence_increased",
  "retrial_ordered",
  "retrial_refused",
  "remitted",
  "order_quashed",
  "act_annulled",
  "act_confirmed",
  "detention_upheld",
  "released",
  "surrender_ordered",
  "surrender_refused",
  "writ_issued",
  "writ_refused",
  "decree_granted",
  "judgment_for_claimant",
  "judgment_for_defendant",
  "settled",
  "withdrawn",
  "struck_out",
  "other",
  "unknown",
] as const;
export type OutcomeCodeV2 = typeof OUTCOME_CODES[number];

export const AUTHORITY_TREATMENTS = [
  "followed",
  "applied",
  "adopted",
  "approved",
  "distinguished",
  "doubted",
  "disapproved",
  "overruled",
  "not_followed",
  "considered",
  "cited",
  "mentioned",
  "unknown",
] as const;
export type AuthorityTreatmentV2 = typeof AUTHORITY_TREATMENTS[number];

export const AUTHORITY_CITATION_CONTEXTS = [
  "direct",
  "adopted_quotation",
  "nested_quotation",
  "unknown",
] as const;
export type AuthorityCitationContextV2 = typeof AUTHORITY_CITATION_CONTEXTS[number];

export const INSTRUMENT_ROLES = [
  "substantive",
  "procedural",
  "jurisdictional",
  "evidential",
  "remedial",
  "constitutional",
  "interpretive",
  "background",
  "unknown",
] as const;
export type InstrumentRoleV2 = typeof INSTRUMENT_ROLES[number];

export const FIELD_STATUSES = [
  "available",
  "unavailable",
  "indeterminate",
  "conflicted",
] as const;
export type FieldStatus = typeof FIELD_STATUSES[number];

export interface SourceFormattingHints {
  bold: boolean;
  italic: boolean;
  centered: boolean;
  uppercaseRatio: number;
  headingCandidate: boolean;
  listCandidate: boolean;
  paragraphNumber: string;
  htmlPath: string;
}

export interface JudgmentParagraphV2 {
  id: string;
  ordinal: number;
  text: string;
  startOffset: number;
  endOffset: number;
  relativePosition: number;
  parentBlockId: string;
  sourceLineStart: number;
  sourceLineEnd: number;
  formatting: SourceFormattingHints;
}

export interface JudgmentSourceV2 {
  sourceId: string;
  sourceHash: string;
  sourceUrl: string;
  sourceTitle: string;
  sourceDatabase: string;
  retrievedAt: string;
  charset: string;
  languageHint: string;
  originalHtml: string;
  cleanText: string;
  characterCount: number;
  paragraphs: JudgmentParagraphV2[];
}

export interface SectionSpanV2 {
  id: string;
  startParagraphId: string;
  endParagraphId: string;
  sectionType: SectionType;
  speakerRole: SpeakerRole;
  heading: string;
  isQuotedMaterial: boolean;
  quotedSourceType: "legislation" | "case" | "academic" | "other" | "none";
  confidence: number;
  boundaryEvidenceParagraphIds: string[];
  rationale: string;
}

export interface SectionMapV2 {
  version: string;
  paragraphCount: number;
  spans: SectionSpanV2[];
  coverageComplete: boolean;
  overlapFree: boolean;
  reviewFlags: string[];
}

export interface EvidenceAnchorV2 {
  id: string;
  paragraphIds: string[];
  quote: string;
  sectionType: SectionType;
  speakerRole: SpeakerRole;
  supports: string[];
  exactMatch: boolean;
}

export interface ExtractedFieldV2<T> {
  status: FieldStatus;
  value: T;
  confidence: number;
  evidence: EvidenceAnchorV2[];
  conflicts: string[];
}

export interface JudgeV2 {
  name: string;
  role: "presiding" | "authoring" | "panel" | "concurring" | "dissenting" | "unknown";
  honorific: string;
}

export interface PartyV2 {
  name: string;
  role: "appellant" | "respondent" | "applicant" | "defendant" | "claimant" | "accused" | "prosecution" | "public_body" | "interested_party" | "other";
  ordinal: string;
  representedBy: string[];
}

export interface AppearanceV2 {
  advocate: string;
  partyRole: string;
  partyName: string;
}

export interface CaseIdentityV2 {
  caseName: ExtractedFieldV2<string>;
  shortName: ExtractedFieldV2<string>;
  citation: ExtractedFieldV2<string>;
  ecli: ExtractedFieldV2<string>;
  docket: ExtractedFieldV2<string>;
  caseNumber: ExtractedFieldV2<string>;
  joinedCaseNumbers: ExtractedFieldV2<string[]>;
  decisionDate: ExtractedFieldV2<string>;
  court: ExtractedFieldV2<string>;
  courtLevel: ExtractedFieldV2<CourtLevelV2>;
  jurisdiction: ExtractedFieldV2<string>;
  language: ExtractedFieldV2<string>;
  era: ExtractedFieldV2<"modern" | "greek_reports" | "english_clr" | "unknown">;
  judges: ExtractedFieldV2<JudgeV2[]>;
  authoringJudges: ExtractedFieldV2<string[]>;
  parties: ExtractedFieldV2<PartyV2[]>;
  appearances: ExtractedFieldV2<AppearanceV2[]>;
}

export interface CaseClassificationV2 {
  caseFamily: ExtractedFieldV2<CaseFamilyV2>;
  legalAreas: ExtractedFieldV2<LegalAreaV2[]>;
  primaryLegalArea: ExtractedFieldV2<LegalAreaV2>;
  proceedingType: ExtractedFieldV2<ProceedingTypeV2>;
  proceduralPosture: ExtractedFieldV2<ProceduralPosture>;
  courtLevel: ExtractedFieldV2<CourtLevelV2>;
  caseTypeLabels: ExtractedFieldV2<string[]>;
  applicationTypes: ExtractedFieldV2<string[]>;
  writsRequested: ExtractedFieldV2<string[]>;
  subjectMatter: ExtractedFieldV2<string[]>;
}

export interface TimelineEventV2 {
  date: string;
  event: string;
  actors: string[];
}

export interface MaterialFactV2 {
  fact: string;
  significance: string;
}

export interface EvidenceOrWitnessV2 {
  name: string;
  type: "witness" | "expert" | "document" | "admission" | "forensic" | "other";
  summary: string;
  treatmentByCourt: string;
}

export interface CaseFactsV2 {
  summary: ExtractedFieldV2<string>;
  materialFacts: ExtractedFieldV2<MaterialFactV2[]>;
  chronology: ExtractedFieldV2<TimelineEventV2[]>;
  witnessesAndEvidence: ExtractedFieldV2<EvidenceOrWitnessV2[]>;
  undisputedFacts: ExtractedFieldV2<string[]>;
  disputedFacts: ExtractedFieldV2<string[]>;
}

export interface GroundOrIssueV2 {
  number: string;
  title: string;
  description: string;
  raisedBy: string;
  result: "succeeded" | "failed" | "partly_succeeded" | "not_determined" | "unknown";
}

export interface ReliefRequestV2 {
  requestedBy: string;
  relief: string;
  status: "granted" | "refused" | "partly_granted" | "not_determined" | "unknown";
}

export interface CaseProcedureV2 {
  proceduralHistory: ExtractedFieldV2<string>;
  originatingProceeding: ExtractedFieldV2<string>;
  lowerCourtDecision: ExtractedFieldV2<string>;
  groundsOrIssues: ExtractedFieldV2<GroundOrIssueV2[]>;
  reliefSought: ExtractedFieldV2<ReliefRequestV2[]>;
  submissionsByParty: ExtractedFieldV2<Array<{ party: string; summary: string }>>;
}

export interface LegalIssueV2 {
  issue: string;
  centrality: "primary" | "secondary" | "ancillary";
  determination: string;
}

export interface LegalPrincipleV2 {
  principle: string;
  type: "ratio" | "holding" | "test" | "standard" | "interpretation" | "procedure" | "evidence" | "remedy" | "sentencing" | "other";
  conditions: string[];
  exceptions: string[];
  applicationToFacts: string;
}

export interface JudicialFindingV2 {
  finding: string;
  type: "fact" | "law" | "credibility" | "procedure" | "jurisdiction" | "other";
}

export interface CaseAnalysisV2 {
  legalIssues: ExtractedFieldV2<LegalIssueV2[]>;
  dominantIssue: ExtractedFieldV2<string>;
  findings: ExtractedFieldV2<JudicialFindingV2[]>;
  holding: ExtractedFieldV2<string>;
  ratioDecidendi: ExtractedFieldV2<LegalPrincipleV2[]>;
  legalPrincipleSummary: ExtractedFieldV2<string>;
  secondaryPrinciples: ExtractedFieldV2<LegalPrincipleV2[]>;
  obiterDicta: ExtractedFieldV2<string[]>;
  legalTestsAndStandards: ExtractedFieldV2<string[]>;
  burdenAndStandardOfProof: ExtractedFieldV2<string[]>;
  credibilityFindings: ExtractedFieldV2<string[]>;
  dissentOrConcurrence: ExtractedFieldV2<Array<{ judge: string; type: "dissent" | "concurrence"; summary: string }>>;
}

export interface ProvisionV2 {
  display: string;
  article: string;
  paragraph: string;
  subparagraph: string;
  part: string;
  normalized: string;
  application: "applied" | "interpreted" | "considered" | "mentioned" | "not_applied" | "unknown";
}

export interface LegalInstrumentV2 {
  lawId: string;
  lawLabel: string;
  instrumentName: string;
  instrumentType: "law" | "chapter" | "constitution" | "regulation" | "rule" | "directive" | "treaty" | "other";
  role: InstrumentRoleV2;
  primary: boolean;
  provisions: ProvisionV2[];
  proposition: string;
}

export interface AuthorityV2 {
  name: string;
  citation: string;
  ecli: string;
  court: string;
  year: number | null;
  treatment: AuthorityTreatmentV2;
  citationContext: AuthorityCitationContextV2;
  legalPoint: string;
  quoted: boolean;
}

export interface CaseAuthoritiesV2 {
  legislation: ExtractedFieldV2<LegalInstrumentV2[]>;
  primaryLegislation: ExtractedFieldV2<LegalInstrumentV2[]>;
  secondaryLegislation: ExtractedFieldV2<LegalInstrumentV2[]>;
  authorities: ExtractedFieldV2<AuthorityV2[]>;
}

export interface OutcomeComponentV2 {
  target: string;
  groundOrIssue: string;
  result: OutcomeCodeV2;
  remedy: string;
  orderText: string;
}

export interface MoneyAwardV2 {
  type: "damages" | "costs" | "fine" | "compensation" | "other";
  amount: string;
  currency: string;
  payer: string;
  payee: string;
  vatIncluded: boolean;
  interest: string;
}

export interface SentenceV2 {
  offence: string;
  sentence: string;
  duration: string;
  concurrentOrConsecutive: string;
  suspended: boolean;
}

export interface CaseOutcomeV2 {
  overallOutcome: ExtractedFieldV2<OutcomeCodeV2>;
  scope: ExtractedFieldV2<string>;
  dispositionText: ExtractedFieldV2<string>;
  components: ExtractedFieldV2<OutcomeComponentV2[]>;
  orders: ExtractedFieldV2<string[]>;
  remedies: ExtractedFieldV2<string[]>;
  sentence: ExtractedFieldV2<SentenceV2[]>;
  monetaryAwards: ExtractedFieldV2<MoneyAwardV2[]>;
  costs: ExtractedFieldV2<MoneyAwardV2[]>;
  remittalInstructions: ExtractedFieldV2<string[]>;
}

export interface SearchTaxonomyV2 {
  issueTags: string[];
  offenceTags: string[];
  keywords: string[];
  aliases: string[];
  topicGroups: string[];
  principleGroups: string[];
  evidenceGroups: string[];
  procedureGroups: string[];
  publicLawGroups: string[];
}

export interface PipelineConflictV2 {
  code: string;
  severity: "critical" | "material" | "minor";
  fieldPath: string;
  message: string;
  evidenceIds: string[];
}

export interface PipelineStageAuditV2 {
  stage: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  model: string;
  responseId: string;
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  inputCharacters: number;
  outputCharacters: number;
  errorCode: string;
}

export interface NomologiesCaseRecordV2 {
  schemaVersion: typeof NOMOLOGIES_V2_VERSION;
  runId: string;
  source: JudgmentSourceV2;
  sectionMap: SectionMapV2;
  identity: CaseIdentityV2;
  classification: CaseClassificationV2;
  facts: CaseFactsV2;
  procedure: CaseProcedureV2;
  analysis: CaseAnalysisV2;
  authorities: CaseAuthoritiesV2;
  outcome: CaseOutcomeV2;
  taxonomy: SearchTaxonomyV2;
  allEvidence: EvidenceAnchorV2[];
  conflicts: PipelineConflictV2[];
  reviewFlags: string[];
  readinessScore: number;
  strictReady: boolean;
  humanReviewRequired: boolean;
  stages: PipelineStageAuditV2[];
  createdAt: string;
  updatedAt: string;
}

export interface NomologiesPipelineInputV2 {
  text: string;
  html?: string;
  sourceTitle?: string;
  sourceUrl?: string;
  sourceDatabase?: string;
  charset?: string;
  mode?: "sections" | "full";
}
