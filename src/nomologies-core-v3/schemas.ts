type Schema = Record<string, unknown>;

const str = (): Schema => ({ type: "string" });
const num = (): Schema => ({ type: "number", minimum: 0, maximum: 1 });
const int = (): Schema => ({ type: "integer" });
const bool = (): Schema => ({ type: "boolean" });
const enumeration = (values: readonly string[]): Schema => ({ type: "string", enum: [...values] });
const arr = (items: Schema): Schema => ({ type: "array", items });
const obj = (properties: Record<string, Schema>): Schema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const nullableString = (): Schema => ({ anyOf: [{ type: "string" }, { type: "null" }] });

const EVIDENCE = obj({ paragraphIds: arr(str()), quote: str() });
const field = (value: Schema): Schema => obj({
  status: enumeration(["available", "unavailable", "indeterminate"]),
  value,
  confidence: num(),
  evidence: arr(EVIDENCE),
});

const JUDGE = obj({
  name: str(),
  role: enumeration(["presiding", "authoring", "panel", "concurring", "dissenting", "unknown"]),
});

export const CORE_V3_IDENTITY_SCHEMA = obj({
  caseName: field(str()),
  caseNumber: field(str()),
  citation: field(str()),
  court: field(str()),
  decisionDate: field(str()),
  caseFamily: field(enumeration(["criminal_law", "private_law", "public_law", "constitutional_law", "family_law", "employment_law", "admiralty", "disciplinary", "mixed", "unknown"])),
  primaryLegalArea: field(str()),
  proceedingType: field(str()),
  judges: field(arr(JUDGE)),
  authoringJudges: field(arr(str())),
});

const MATERIAL_FACT = obj({ fact: str(), significance: str() });
const LEGAL_ISSUE = obj({ question: str(), ruling: str() });
const OBITER = obj({ observation: str(), whyNonEssential: str() });

export const CORE_V3_LEGAL_SCHEMA = obj({
  factsSummary: field(str()),
  materialFacts: field(arr(MATERIAL_FACT)),
  dominantLegalPrinciple: field(str()),
  legalIssues: field(arr(LEGAL_ISSUE)),
  obiterDicta: field(arr(OBITER)),
});

const PROVISION = obj({
  display: str(),
  article: str(),
  paragraph: str(),
  subparagraph: str(),
  part: str(),
  application: enumeration(["applied", "interpreted", "considered", "mentioned", "not_applied", "unknown"]),
});
const INSTRUMENT = obj({
  lawId: str(),
  instrumentName: str(),
  instrumentType: enumeration(["law", "chapter", "constitution", "regulation", "rule", "directive", "treaty", "other"]),
  role: enumeration(["substantive", "procedural", "jurisdictional", "evidential", "remedial", "constitutional", "interpretive", "background", "unknown"]),
  primary: bool(),
  provisions: arr(PROVISION),
  proposition: str(),
});
const AUTHORITY = obj({
  name: str(),
  citation: str(),
  ecli: str(),
  court: str(),
  year: int(),
  treatment: enumeration(["followed", "applied", "adopted", "approved", "distinguished", "doubted", "disapproved", "overruled", "not_followed", "considered", "cited", "mentioned", "unknown"]),
  citationContext: enumeration(["direct", "adopted_quotation", "nested_quotation", "unknown"]),
  legalPoint: str(),
});
const MONEY = obj({
  kind: enumeration(["damages", "compensation", "costs", "fine", "interest", "other"]),
  stage: enumeration(["first_instance", "appellate", "retrial", "other"]),
  amount: nullableString(),
  currency: str(),
  status: enumeration(["fixed", "to_be_assessed", "open", "not_stated"]),
  payer: str(),
  payee: str(),
  scale: str(),
  interest: str(),
});

export const CORE_V3_OUTCOME_SCHEMA = obj({
  overallOutcome: field(str()),
  dispositionText: field(str()),
  orders: field(arr(str())),
  money: field(arr(MONEY)),
  remittalInstructions: field(arr(str())),
  legislation: field(arr(INSTRUMENT)),
  authorities: field(arr(AUTHORITY)),
});

const CHECK = obj({
  fieldPath: str(),
  status: enumeration(["pass", "fail", "indeterminate"]),
  severity: enumeration(["critical", "material", "minor"]),
  code: str(),
  message: str(),
  evidenceParagraphIds: arr(str()),
});

export const CORE_V3_VERIFIER_SCHEMA = obj({
  overallStatus: enumeration(["pass", "review"]),
  checks: arr(CHECK),
  repairGroup: enumeration(["none", "identity", "legal", "outcome"]),
  summary: str(),
});

export const CORE_V3_SCHEMAS = {
  identity: { name: "elite_core_v3_identity", schema: CORE_V3_IDENTITY_SCHEMA },
  legal: { name: "elite_core_v3_legal", schema: CORE_V3_LEGAL_SCHEMA },
  outcome: { name: "elite_core_v3_outcome", schema: CORE_V3_OUTCOME_SCHEMA },
  verifier: { name: "elite_core_v3_verifier", schema: CORE_V3_VERIFIER_SCHEMA },
} as const;
