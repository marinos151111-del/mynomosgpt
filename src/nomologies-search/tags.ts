import type {
  EvidenceAnchorV2,
  ExtractedFieldV2,
  NomologiesCaseRecordV2,
} from "../nomologies-v2/types.ts";
import { detectConcepts } from "./synonyms.ts";
import { bounded, compactKey, normalizeLegalText } from "./normalize.ts";
import type { SmartTagKindV1, SmartTagV1 } from "./types.ts";

type AnyField = ExtractedFieldV2<unknown>;

const CONTROLLED_ENUM_TAGS: Record<string, string> = {
  criminal_law: "ποινικό",
  private_law: "ιδιωτικό",
  public_law: "δημόσιο",
  constitutional_law: "συνταγματικότητα",
  family_law: "οικογένεια",
  employment_law: "εργασία",
  admiralty: "ναυτοδικείο",
  disciplinary: "πειθαρχικό",
  criminal: "έγκλημα",
  criminal_procedure: "ποινικοδικονομία",
  evidence: "απόδειξη",
  sentencing: "ποινή",
  extradition: "έκδοση",
  european_arrest_warrant: "ευρωένταλμα",
  civil_procedure: "πολιτικοδικονομία",
  contract: "σύμβαση",
  tort: "αδικοπραξία",
  negligence: "αμέλεια",
  personal_injury: "τραυματισμός",
  medical_negligence: "αμέλεια",
  damages: "αποζημίωση",
  property: "ακίνητη ιδιοκτησία",
  land_registry: "κτηματολόγιο",
  rent_control: "ενοικιοστάσιο",
  banking: "τραπεζικό",
  security_and_mortgages: "υποθήκη",
  insurance: "ασφάλιση",
  company: "εταιρείες",
  insolvency: "αφερεγγυότητα",
  liquidation: "εκκαθάριση",
  construction: "κατασκευές",
  commercial: "εμπορικό",
  probate: "διαθήκη",
  succession: "κληρονομία",
  trusts: "εμπίστευμα",
  family: "οικογένεια",
  employment: "εργασία",
  immigration: "μετανάστευση",
  asylum: "άσυλο",
  habeas_corpus: "κράτηση",
  prerogative_writs: "προνομιακό",
  administrative: "διοικητικό",
  constitutional: "συνταγματικότητα",
  human_rights: "δικαιώματα",
  tax: "φορολογία",
  customs: "τελωνεία",
  vat: "φορολογία",
  public_service: "υπαλληλικό",
  public_procurement: "προσφορές",
  planning: "πολεοδομία",
  competition: "ανταγωνισμός",
  social_insurance: "ασφάλιση",
  professional_regulation: "επαγγελματικό",
  education: "εκπαίδευση",
  electoral: "εκλογές",
  civil_appeal: "έφεση",
  criminal_appeal: "έφεση",
  sentence_appeal: "έφεση",
  prosecution_appeal: "έφεση",
  administrative_appeal: "έφεση",
  constitutional_appeal: "έφεση",
  family_appeal: "έφεση",
  employment_appeal: "έφεση",
  land_registry_appeal: "έφεση",
  eaw_appeal: "έφεση",
  trial: "δίκη",
  recourse_article_146: "προσφυγή",
  constitutional_reference: "αναφορά",
  election_petition: "εκλογές",
  company_petition: "εταιρείες",
  insolvency_petition: "αφερεγγυότητα",
  interim_application: "ενδιάμεση",
  expedition_application: "επίσπευση",
  leave_application: "άδεια",
  extension_of_time_application: "παράταση",
  legal_aid_application: "αρωγή",
  certiorari: "ακυρωτικό",
  prohibition: "απαγορευτικό",
  mandamus: "εντολή",
  extradition_proceeding: "έκδοση",
  eaw_proceeding: "ευρωένταλμα",
  disciplinary_objection: "πειθαρχικό",
  application: "αίτηση",
  appeal: "έφεση",
  first_instance: "πρωτόδικη",
  cross_appeal: "αντέφεση",
  leave_stage: "άδεια",
  permission_stage: "άδεια",
  substantive_writ_hearing: "ένταλμα",
  interim_stage: "ενδιάμεση",
  rehearing: "επανεκδίκαση",
  remittal: "παραπομπή",
  consolidated_proceedings: "συνεκδίκαση",
  reference: "αναφορά",
  allowed: "επιτυχία",
  partly_allowed: "μερική",
  dismissed: "απόρριψη",
  appeal_allowed: "επιτυχία",
  appeal_partly_allowed: "μερική",
  appeal_dismissed: "απόρριψη",
  application_allowed: "επιτυχία",
  application_partly_allowed: "μερική",
  application_dismissed: "απόρριψη",
  leave_granted: "άδεια",
  leave_refused: "απόρριψη",
  convicted: "καταδίκη",
  conviction_upheld: "καταδίκη",
  conviction_quashed: "ακύρωση",
  acquitted: "αθώωση",
  sentence_upheld: "ποινή",
  sentence_reduced: "μείωση",
  sentence_increased: "αύξηση",
};

function available(field: AnyField): boolean {
  if (field.status !== "available") return false;
  if (typeof field.value === "string") return field.value.trim().length > 0;
  if (Array.isArray(field.value)) return field.value.length > 0;
  return field.value !== null && field.value !== undefined;
}

function values(field: AnyField): string[] {
  if (!available(field)) return [];
  return (Array.isArray(field.value) ? field.value : [field.value])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function fieldValue(field: AnyField): unknown {
  return available(field) ? field.value : "";
}

function paragraphIds(evidence: EvidenceAnchorV2[] = []): string[] {
  return [...new Set(evidence.flatMap((anchor) => anchor.paragraphIds).filter((id) => id && id !== "TITLE"))];
}

function tagBoost(kind: SmartTagKindV1): number {
  return {
    identity: 0,
    provision: 0,
    principle: 13,
    issue: 12,
    outcome: 11,
    procedure: 10,
    authority: 0,
    legal_area: 9,
    remedy: 10,
    evidence: 9,
    fact: 0,
  }[kind];
}

function kindForConcept(type: string): SmartTagKindV1 {
  if (type === "area") return "legal_area";
  if (type === "outcome") return "outcome";
  if (type === "evidence") return "evidence";
  if (type === "remedy") return "remedy";
  if (type === "procedure" || type === "institution") return "procedure";
  return "principle";
}

const NON_SEMANTIC_TAG_LABELS = new Set([
  "έφεση",
  "αίτηση",
  "απόρριψη",
  "επιτυχία",
  "μερική",
  "γνώση",
  "δικαίωμα",
  "ευχέρεια",
  "παράλειψη",
  "πρωτόδικη",
  "διάκριση",
  "διάταγμα",
]);

/**
 * Smart tags are a controlled semantic layer, not tokenized judgment text.
 * Every stored tag has one canonical Greek keyword. Fuller Greek phrases,
 * English terms and transliterations live only in aliases for global search.
 */
export function buildSmartTags(record: NomologiesCaseRecordV2): SmartTagV1[] {
  const byKey = new Map<string, SmartTagV1>();

  const add = (input: {
    label: string;
    kind: SmartTagKindV1;
    aliases?: string[];
    confidence?: number;
    evidence?: EvidenceAnchorV2[];
    sourceField: string;
    boost?: number;
  }) => {
    const label = String(input.label || "").normalize("NFC").trim();
    if (!/^[Α-Ωα-ωΆ-Ώά-ώΐΰϊϋ][Α-Ωα-ωΆ-Ώά-ώΐΰϊϋ\s‑-]{2,64}$/u.test(label)) return;
    if (label.trim().split(/\s+/u).length > 5) return;
    if (NON_SEMANTIC_TAG_LABELS.has(label.toLocaleLowerCase("el"))) return;
    const normalized = normalizeLegalText(label);
    if (!normalized) return;
    const key = compactKey(normalized);
    const aliases = [...new Set([
      label,
      ...(input.aliases || []),
    ].map((item) => String(item || "").trim()).filter(Boolean))];
    const ids = paragraphIds(input.evidence);
    const existing = byKey.get(key);
    if (existing) {
      existing.confidence = Math.max(existing.confidence, bounded(input.confidence ?? 0.9));
      existing.boost = Math.max(existing.boost, input.boost ?? tagBoost(input.kind));
      existing.aliases = [...new Set([...existing.aliases, ...aliases])];
      existing.evidenceParagraphIds = [...new Set([...existing.evidenceParagraphIds, ...ids])];
      return;
    }
    byKey.set(key, {
      id: `tag_semantic_${compactKey(`${input.kind}_${normalized}`)}`.slice(0, 120),
      label,
      normalized,
      kind: input.kind,
      confidence: bounded(input.confidence ?? 0.9),
      aliases,
      evidenceParagraphIds: ids,
      boost: input.boost ?? tagBoost(input.kind),
      sourceField: input.sourceField,
    });
  };

  const enumFields: Array<{ field: AnyField; kind: SmartTagKindV1 }> = [
    { field: record.classification.caseFamily, kind: "legal_area" },
    { field: record.classification.primaryLegalArea, kind: "legal_area" },
    { field: record.classification.legalAreas, kind: "legal_area" },
  ];
  for (const { field, kind } of enumFields) {
    for (const raw of values(field)) {
      const label = CONTROLLED_ENUM_TAGS[raw];
      if (!label) continue;
      add({
        label,
        kind,
        aliases: [raw],
        confidence: field.confidence,
        evidence: field.evidence,
        sourceField: `concept.enum.${raw}`,
        boost: tagBoost(kind) + 2,
      });
    }
  }

  // Visible smart tags come from the central legal analysis. Facts and the
  // procedural narrative remain fully searchable in weighted fields, but they
  // must not promote incidental words into headline legal tags.
  const conceptText = JSON.stringify({
    classification: {
      caseFamily: fieldValue(record.classification.caseFamily),
      primaryLegalArea: fieldValue(record.classification.primaryLegalArea),
      legalAreas: fieldValue(record.classification.legalAreas),
      proceedingType: fieldValue(record.classification.proceedingType),
      proceduralPosture: fieldValue(record.classification.proceduralPosture),
      subjectMatter: fieldValue(record.classification.subjectMatter),
    },
    procedure: {
      groundsOrIssues: fieldValue(record.procedure.groundsOrIssues),
    },
    analysis: {
      dominantIssue: fieldValue(record.analysis.dominantIssue),
      legalIssues: fieldValue(record.analysis.legalIssues),
      legalPrincipleSummary: fieldValue(record.analysis.legalPrincipleSummary),
      legalTestsAndStandards: fieldValue(record.analysis.legalTestsAndStandards),
      ratioDecidendi: fieldValue(record.analysis.ratioDecidendi),
      holding: fieldValue(record.analysis.holding),
    },
    issueTags: record.taxonomy?.issueTags || [],
  });
  for (const concept of detectConcepts(conceptText)) {
    if (concept.type === "outcome") continue;
    const kind = kindForConcept(concept.type);
    add({
      label: concept.label,
      kind,
      aliases: concept.aliases,
      confidence: 0.96,
      sourceField: `concept.${concept.id}`,
      boost: tagBoost(kind) + 1,
    });
  }

  return [...byKey.values()]
    .sort((left, right) =>
      right.boost - left.boost ||
      right.confidence - left.confidence ||
      left.label.localeCompare(right.label, "el")
    )
    .slice(0, 24);
}
