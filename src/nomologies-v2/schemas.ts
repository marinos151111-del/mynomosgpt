import {
  AUTHORITY_CITATION_CONTEXTS,
  AUTHORITY_TREATMENTS,
  CASE_FAMILIES,
  COURT_LEVELS,
  FIELD_STATUSES,
  INSTRUMENT_ROLES,
  LEGAL_AREAS,
  OUTCOME_CODES,
  PROCEDURAL_POSTURES,
  PROCEEDING_TYPES,
  SECTION_TYPES,
  SPEAKER_ROLES,
} from "./types.ts";

type JsonSchema = Record<string, unknown>;

function object(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}
function array(items: JsonSchema): JsonSchema {
  return { type: "array", items };
}
function string(): JsonSchema {
  return { type: "string" };
}
function number(): JsonSchema {
  return { type: "number", minimum: 0, maximum: 1 };
}
function integer(): JsonSchema {
  return { type: "integer" };
}
function boolean(): JsonSchema {
  return { type: "boolean" };
}
function enumeration(values: readonly string[]): JsonSchema {
  return { type: "string", enum: [...values] };
}

const EVIDENCE = object({
  paragraphIds: array(string()),
  quote: string(),
  supports: array(string()),
});

function field(value: JsonSchema): JsonSchema {
  return object({
    status: enumeration(FIELD_STATUSES),
    value,
    confidence: number(),
    evidence: array(EVIDENCE),
    conflicts: array(string()),
  });
}

const JUDGE = object({
  name: string(),
  role: enumeration(["presiding", "authoring", "panel", "concurring", "dissenting", "unknown"]),
  honorific: string(),
});
const PARTY = object({
  name: string(),
  role: enumeration(["appellant", "respondent", "applicant", "defendant", "claimant", "accused", "prosecution", "public_body", "interested_party", "other"]),
  ordinal: string(),
  representedBy: array(string()),
});
const APPEARANCE = object({ advocate: string(), partyRole: string(), partyName: string() });

export const SECTION_MAP_SCHEMA = object({
  language: string(),
  era: enumeration(["modern", "greek_reports", "english_clr", "unknown"]),
  spans: array(object({
    id: string(),
    startParagraphId: string(),
    endParagraphId: string(),
    sectionType: enumeration(SECTION_TYPES),
    speakerRole: enumeration(SPEAKER_ROLES),
    heading: string(),
    isQuotedMaterial: boolean(),
    quotedSourceType: enumeration(["legislation", "case", "academic", "other", "none"]),
    confidence: number(),
    boundaryEvidenceParagraphIds: array(string()),
    rationale: string(),
  })),
});

export const IDENTITY_CLASSIFICATION_SCHEMA = object({
  identity: object({
    caseName: field(string()),
    shortName: field(string()),
    citation: field(string()),
    ecli: field(string()),
    docket: field(string()),
    caseNumber: field(string()),
    joinedCaseNumbers: field(array(string())),
    decisionDate: field(string()),
    court: field(string()),
    courtLevel: field(enumeration(COURT_LEVELS)),
    jurisdiction: field(string()),
    language: field(string()),
    era: field(enumeration(["modern", "greek_reports", "english_clr", "unknown"])),
    judges: field(array(JUDGE)),
    authoringJudges: field(array(string())),
    parties: field(array(PARTY)),
    appearances: field(array(APPEARANCE)),
  }),
  classification: object({
    caseFamily: field(enumeration(CASE_FAMILIES)),
    legalAreas: field(array(enumeration(LEGAL_AREAS))),
    primaryLegalArea: field(enumeration(LEGAL_AREAS)),
    proceedingType: field(enumeration(PROCEEDING_TYPES)),
    proceduralPosture: field(enumeration(PROCEDURAL_POSTURES)),
    courtLevel: field(enumeration(COURT_LEVELS)),
    caseTypeLabels: field(array(string())),
    applicationTypes: field(array(string())),
    writsRequested: field(array(string())),
    subjectMatter: field(array(string())),
  }),
});

const MATERIAL_FACT = object({ fact: string(), significance: string() });
const TIMELINE_EVENT = object({ date: string(), event: string(), actors: array(string()) });
const EVIDENCE_OR_WITNESS = object({
  name: string(),
  type: enumeration(["witness", "expert", "document", "admission", "forensic", "other"]),
  summary: string(),
  treatmentByCourt: string(),
});
const GROUND_OR_ISSUE = object({
  number: string(),
  title: string(),
  description: string(),
  raisedBy: string(),
  result: enumeration(["succeeded", "failed", "partly_succeeded", "not_determined", "unknown"]),
});
const RELIEF_REQUEST = object({
  requestedBy: string(),
  relief: string(),
  status: enumeration(["granted", "refused", "partly_granted", "not_determined", "unknown"]),
});

export const FACTS_SCHEMA = object({
  facts: object({
    summary: field(string()),
    materialFacts: field(array(MATERIAL_FACT)),
    undisputedFacts: field(array(string())),
    disputedFacts: field(array(string())),
  }),
});

export const DEFERRED_CHRONOLOGY_SCHEMA = object({
  chronology: field(array(TIMELINE_EVENT)),
});

export const DEFERRED_WITNESSES_SCHEMA = object({
  witnessesAndEvidence: field(array(EVIDENCE_OR_WITNESS)),
});

export const PROCEDURE_SCHEMA = object({
  procedure: object({
    proceduralHistory: field(string()),
    originatingProceeding: field(string()),
    lowerCourtDecision: field(string()),
    groundsOrIssues: field(array(GROUND_OR_ISSUE)),
    reliefSought: field(array(RELIEF_REQUEST)),
    submissionsByParty: field(array(object({ party: string(), summary: string() }))),
  }),
});

export const FACTS_PROCEDURE_SCHEMA = object({
  facts: (FACTS_SCHEMA as { properties: Record<string, JsonSchema> }).properties.facts,
  procedure: (PROCEDURE_SCHEMA as { properties: Record<string, JsonSchema> }).properties.procedure,
});

const LEGAL_ISSUE = object({
  issue: string(),
  centrality: enumeration(["primary", "secondary", "ancillary"]),
  determination: string(),
});
const LEGAL_PRINCIPLE = object({
  principle: string(),
  type: enumeration(["ratio", "holding", "test", "standard", "interpretation", "procedure", "evidence", "remedy", "sentencing", "other"]),
  conditions: array(string()),
  exceptions: array(string()),
  applicationToFacts: string(),
});
const JUDICIAL_FINDING = object({
  finding: string(),
  type: enumeration(["fact", "law", "credibility", "procedure", "jurisdiction", "other"]),
});

export const ANALYSIS_SCHEMA = object({
  analysis: object({
    legalIssues: field(array(LEGAL_ISSUE)),
    dominantIssue: field(string()),
    findings: field(array(JUDICIAL_FINDING)),
    holding: field(string()),
    ratioDecidendi: field(array(LEGAL_PRINCIPLE)),
    legalPrincipleSummary: field(string()),
    secondaryPrinciples: field(array(LEGAL_PRINCIPLE)),
    obiterDicta: field(array(string())),
    legalTestsAndStandards: field(array(string())),
    burdenAndStandardOfProof: field(array(string())),
    credibilityFindings: field(array(string())),
    dissentOrConcurrence: field(array(object({
      judge: string(),
      type: enumeration(["dissent", "concurrence"]),
      summary: string(),
    }))),
  }),
});

const PROVISION = object({
  display: string(),
  article: string(),
  paragraph: string(),
  subparagraph: string(),
  part: string(),
  normalized: string(),
  application: enumeration(["applied", "interpreted", "considered", "mentioned", "not_applied", "unknown"]),
});
const INSTRUMENT = object({
  lawId: string(),
  lawLabel: string(),
  instrumentName: string(),
  instrumentType: enumeration(["law", "chapter", "constitution", "regulation", "rule", "directive", "treaty", "other"]),
  role: enumeration(INSTRUMENT_ROLES),
  primary: boolean(),
  provisions: array(PROVISION),
  proposition: string(),
});
const AUTHORITY = object({
  name: string(),
  citation: string(),
  ecli: string(),
  court: string(),
  year: integer(),
  sourceType: enumeration(["decision", "secondary_literature", "other"]),
  treatment: enumeration(AUTHORITY_TREATMENTS),
  citationContext: enumeration(AUTHORITY_CITATION_CONTEXTS),
  legalPoint: string(),
  quoted: boolean(),
});

export const AUTHORITIES_SCHEMA = object({
  authorities: object({
    legislation: field(array(INSTRUMENT)),
    primaryLegislation: field(array(INSTRUMENT)),
    secondaryLegislation: field(array(INSTRUMENT)),
    authorities: field(array(AUTHORITY)),
  }),
});

const OUTCOME_COMPONENT = object({
  target: string(),
  groundOrIssue: string(),
  result: enumeration(OUTCOME_CODES),
  remedy: string(),
  orderText: string(),
});
const MONEY_AWARD = object({
  type: enumeration(["damages", "costs", "fine", "compensation", "other"]),
  stage: enumeration(["first_instance", "appellate", "retrial", "other"]),
  amount: string(),
  currency: string(),
  payer: string(),
  payee: string(),
  vatIncluded: boolean(),
  vatStatus: enumeration(["included", "plus_vat", "plus_vat_if_applicable", "not_stated"]),
  interest: string(),
});
const SENTENCE = object({
  offence: string(),
  sentence: string(),
  duration: string(),
  concurrentOrConsecutive: string(),
  suspended: boolean(),
});

export const OUTCOME_SCHEMA = object({
  outcome: object({
    overallOutcome: field(enumeration(OUTCOME_CODES)),
    scope: field(string()),
    dispositionText: field(string()),
    components: field(array(OUTCOME_COMPONENT)),
    orders: field(array(string())),
    remedies: field(array(string())),
    sentence: field(array(SENTENCE)),
    monetaryAwards: field(array(MONEY_AWARD)),
    costs: field(array(MONEY_AWARD)),
    remittalInstructions: field(array(string())),
    withdrawnOrAbandoned: field(array(string())),
  }),
});

export const WHOLE_JUDGMENT_SCHEMA = object({
  identity: (IDENTITY_CLASSIFICATION_SCHEMA as { properties: Record<string, JsonSchema> }).properties.identity,
  classification: (IDENTITY_CLASSIFICATION_SCHEMA as { properties: Record<string, JsonSchema> }).properties.classification,
  facts: (FACTS_SCHEMA as { properties: Record<string, JsonSchema> }).properties.facts,
  procedure: (PROCEDURE_SCHEMA as { properties: Record<string, JsonSchema> }).properties.procedure,
  analysis: (ANALYSIS_SCHEMA as { properties: Record<string, JsonSchema> }).properties.analysis,
  authorities: (AUTHORITIES_SCHEMA as { properties: Record<string, JsonSchema> }).properties.authorities,
  outcome: (OUTCOME_SCHEMA as { properties: Record<string, JsonSchema> }).properties.outcome,
});

export const REVIEW_SCHEMA = object({
  conflicts: array(object({
    code: string(),
    severity: enumeration(["critical", "material", "minor"]),
    fieldPath: string(),
    message: string(),
    evidenceIds: array(string()),
  })),
  sectionCorrections: array(object({
    spanId: string(),
    proposedSectionType: enumeration(SECTION_TYPES),
    reason: string(),
  })),
  publishRecommendation: enumeration(["approve", "review", "reject"]),
  qualitySummary: string(),
});

export const NOMOLOGIES_SCHEMAS = {
  sections: { name: "nomologies_v2_sections", schema: SECTION_MAP_SCHEMA },
  identity: { name: "nomologies_v2_identity", schema: IDENTITY_CLASSIFICATION_SCHEMA },
  facts: { name: "nomologies_v2_facts", schema: FACTS_SCHEMA },
  deferredChronology: { name: "nomologies_v2_deferred_chronology", schema: DEFERRED_CHRONOLOGY_SCHEMA },
  deferredWitnesses: { name: "nomologies_v2_deferred_witnesses", schema: DEFERRED_WITNESSES_SCHEMA },
  procedure: { name: "nomologies_v2_procedure", schema: PROCEDURE_SCHEMA },
  factsProcedure: { name: "nomologies_v2_facts_procedure", schema: FACTS_PROCEDURE_SCHEMA },
  analysis: { name: "nomologies_v2_analysis", schema: ANALYSIS_SCHEMA },
  authorities: { name: "nomologies_v2_authorities", schema: AUTHORITIES_SCHEMA },
  outcome: { name: "nomologies_v2_outcome", schema: OUTCOME_SCHEMA },
  wholeJudgment: { name: "nomologies_v2_whole_judgment", schema: WHOLE_JUDGMENT_SCHEMA },
  review: { name: "nomologies_v2_review", schema: REVIEW_SCHEMA },
} as const;
