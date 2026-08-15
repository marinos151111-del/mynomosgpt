export const CORE_V3_VERSION = "elite-core-v3.0.0" as const;
export const CORE_V3_MODEL = "gpt-5.4-mini" as const;

export type CoreStatus = "available" | "unavailable" | "indeterminate";
export type CorePrecedentialWeight = "high" | "medium" | "low";
export type CoreRepairGroup = "none" | "identity" | "legal" | "outcome";

export interface CoreEvidenceRef {
  paragraphIds: string[];
  quote: string;
  exactMatch?: boolean;
}

export interface CoreField<T> {
  status: CoreStatus;
  value: T;
  confidence: number;
  evidence: CoreEvidenceRef[];
}

export interface CoreJudge {
  name: string;
  role: "presiding" | "authoring" | "panel" | "concurring" | "dissenting" | "unknown";
}

export interface CoreIdentityAgentRecord {
  caseName: CoreField<string>;
  caseNumber: CoreField<string>;
  citation: CoreField<string>;
  court: CoreField<string>;
  decisionDate: CoreField<string>;
  caseFamily: CoreField<"criminal_law" | "private_law" | "public_law" | "constitutional_law" | "family_law" | "employment_law" | "admiralty" | "disciplinary" | "mixed" | "unknown">;
  primaryLegalArea: CoreField<string>;
  proceedingType: CoreField<string>;
  judges: CoreField<CoreJudge[]>;
  authoringJudges: CoreField<string[]>;
}

export interface CoreMaterialFact {
  fact: string;
  significance: string;
}

export interface CoreLegalIssue {
  question: string;
  ruling: string;
}

export interface CoreObiter {
  observation: string;
  whyNonEssential: string;
}

export interface CoreLegalAgentRecord {
  factsSummary: CoreField<string>;
  materialFacts: CoreField<CoreMaterialFact[]>;
  dominantLegalPrinciple: CoreField<string>;
  legalIssues: CoreField<CoreLegalIssue[]>;
  obiterDicta: CoreField<CoreObiter[]>;
}

export interface CoreProvision {
  display: string;
  article: string;
  paragraph: string;
  subparagraph: string;
  part: string;
  application: "applied" | "interpreted" | "considered" | "mentioned" | "not_applied" | "unknown";
}

export interface CoreInstrument {
  lawId: string;
  instrumentName: string;
  instrumentType: "law" | "chapter" | "constitution" | "regulation" | "rule" | "directive" | "treaty" | "other";
  role: "substantive" | "procedural" | "jurisdictional" | "evidential" | "remedial" | "constitutional" | "interpretive" | "background" | "unknown";
  primary: boolean;
  provisions: CoreProvision[];
  proposition: string;
}

export interface CoreAuthority {
  name: string;
  citation: string;
  ecli: string;
  court: string;
  year: number;
  treatment: "followed" | "applied" | "adopted" | "approved" | "distinguished" | "doubted" | "disapproved" | "overruled" | "not_followed" | "considered" | "cited" | "mentioned" | "unknown";
  citationContext: "direct" | "adopted_quotation" | "nested_quotation" | "unknown";
  legalPoint: string;
}

export interface CoreMoneyEntry {
  kind: "damages" | "compensation" | "costs" | "fine" | "interest" | "other";
  stage: "first_instance" | "appellate" | "retrial" | "other";
  amount: string | null;
  currency: string;
  status: "fixed" | "to_be_assessed" | "open" | "not_stated";
  payer: string;
  payee: string;
  scale: string;
  interest: string;
}

export interface CoreOutcomeAgentRecord {
  overallOutcome: CoreField<string>;
  dispositionText: CoreField<string>;
  orders: CoreField<string[]>;
  money: CoreField<CoreMoneyEntry[]>;
  remittalInstructions: CoreField<string[]>;
  legislation: CoreField<CoreInstrument[]>;
  authorities: CoreField<CoreAuthority[]>;
}

export interface CoreMergedRecord {
  version: typeof CORE_V3_VERSION;
  model: typeof CORE_V3_MODEL;
  source: Record<string, unknown>;
  identity: CoreIdentityAgentRecord;
  legal: CoreLegalAgentRecord;
  outcome: CoreOutcomeAgentRecord;
  precedentialWeight: CorePrecedentialWeight;
  evidenceValidation: {
    exactAnchors: number;
    rejectedAnchors: number;
    flags: string[];
  };
  createdAt: string;
}

export interface CoreVerifierCheck {
  fieldPath: string;
  status: "pass" | "fail" | "indeterminate";
  severity: "critical" | "material" | "minor";
  code: string;
  message: string;
  evidenceParagraphIds: string[];
}

export interface CoreVerifierRecord {
  overallStatus: "pass" | "review";
  checks: CoreVerifierCheck[];
  repairGroup: CoreRepairGroup;
  summary: string;
}
