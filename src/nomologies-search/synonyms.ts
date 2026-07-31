import { normalizeLegalText, tokenizeLegalText } from "./normalize.ts";

export interface LegalConceptV1 {
  id: string;
  label: string;
  aliases: string[];
  type: "procedure" | "area" | "principle" | "outcome" | "evidence" | "remedy" | "institution";
}

export const LEGAL_CONCEPTS: LegalConceptV1[] = [
  {
    id: "expedition_of_appeal",
    label: "επίσπευση έφεσης",
    aliases: ["κατά προτεραιότητα εκδίκαση έφεσης", "ταχεία εκδίκαση έφεσης", "priority hearing", "expedited appeal", "expedition application", "epispefsi efesis"],
    type: "procedure",
  },
  {
    id: "judicial_discretion",
    label: "δικαστική διακριτική ευχέρεια",
    aliases: ["διακριτική ευχέρεια του δικαστηρίου", "judicial discretion", "discretion of the court"],
    type: "principle",
  },
  {
    id: "interlocutory_decision",
    label: "ενδιάμεση απόφαση",
    aliases: ["ενδιάμεσο διάταγμα", "παρεμπίπτουσα απόφαση", "interlocutory decision", "interim order"],
    type: "procedure",
  },
  {
    id: "non_binding_interpretation",
    label: "μη δεσμευτική ερμηνεία",
    aliases: ["μη οριστική ερμηνεία", "μη δεσμευτική κρίση", "non-binding interpretation", "not finally determined"],
    type: "principle",
  },
  {
    id: "parallel_proceedings",
    label: "παράλληλες διαδικασίες",
    aliases: ["παράλληλες δικαστικές διαδικασίες", "parallel proceedings", "multiple proceedings", "lis pendens"],
    type: "procedure",
  },
  {
    id: "conflicting_judgments",
    label: "κίνδυνος αντιφατικών αποφάσεων",
    aliases: ["αντιφατικές δικαστικές αποφάσεις", "conflicting judgments", "inconsistent decisions"],
    type: "principle",
  },
  {
    id: "preliminary_reference_cjeu",
    label: "προδικαστικό ερώτημα στο ΔΕΕ",
    aliases: ["παραπομπή στο ΔΕΕ", "προδικαστική παραπομπή", "preliminary reference", "CJEU reference", "ECJ reference"],
    type: "procedure",
  },
  {
    id: "delay_weakens_urgency",
    label: "καθυστέρηση που αποδυναμώνει το κατεπείγον",
    aliases: ["ολιγωρία αιτητή", "καθυστέρηση στην υποβολή αίτησης", "delay undermines urgency", "late application"],
    type: "principle",
  },
  {
    id: "interim_injunction",
    label: "προσωρινό απαγορευτικό διάταγμα",
    aliases: ["ενδιάμεσο απαγορευτικό διάταγμα", "interim injunction", "temporary injunction", "injunction"],
    type: "remedy",
  },
  {
    id: "bank_guarantee",
    label: "τραπεζική εγγυητική επιστολή",
    aliases: ["εγγυητική προκαταβολής", "εγγυητική πιστής εκτέλεσης", "performance guarantee", "advance payment guarantee", "bank guarantee"],
    type: "area",
  },
  {
    id: "civil_procedure",
    label: "πολιτική δικονομία",
    aliases: ["civil procedure", "civil procedural law", "κανονισμοί πολιτικής δικονομίας", "ΚΠΔ 2023", "CPR 2023"],
    type: "area",
  },
  {
    id: "criminal_procedure",
    label: "ποινική δικονομία",
    aliases: ["criminal procedure", "ποινική διαδικασία"],
    type: "area",
  },
  {
    id: "adverse_possession",
    label: "εχθρική κατοχή",
    aliases: ["adverse possession", "κτητική παραγραφή", "continuous adverse possession"],
    type: "area",
  },
  {
    id: "credibility_review",
    label: "εφετειακή παρέμβαση στην αξιοπιστία",
    aliases: ["αξιολόγηση αξιοπιστίας μαρτύρων", "appellate interference with credibility", "credibility findings"],
    type: "evidence",
  },
  {
    id: "hearsay",
    label: "εξ ακοής μαρτυρία",
    aliases: ["hearsay", "hearsay evidence"],
    type: "evidence",
  },
  {
    id: "burden_of_proof",
    label: "βάρος απόδειξης",
    aliases: ["burden of proof", "onus of proof"],
    type: "evidence",
  },
  {
    id: "standard_of_proof",
    label: "μέτρο απόδειξης",
    aliases: ["standard of proof", "beyond reasonable doubt", "balance of probabilities", "πέραν πάσης λογικής αμφιβολίας", "ισοζύγιο πιθανοτήτων"],
    type: "evidence",
  },
  {
    id: "certiorari",
    label: "προνομιακό ένταλμα certiorari",
    aliases: ["certiorari", "ένταλμα ακύρωσης", "prerogative writ"],
    type: "procedure",
  },
  {
    id: "habeas_corpus",
    label: "habeas corpus",
    aliases: ["ένταλμα habeas corpus", "παράνομη κράτηση", "unlawful detention"],
    type: "procedure",
  },
  {
    id: "article_146_recourse",
    label: "προσφυγή άρθρου 146",
    aliases: ["άρθρο 146 του Συντάγματος", "administrative recourse", "judicial review under article 146"],
    type: "procedure",
  },
  {
    id: "appeal_allowed",
    label: "έφεση επιτράπηκε",
    aliases: ["appeal allowed", "appeal succeeded", "η έφεση γίνεται δεκτή"],
    type: "outcome",
  },
  {
    id: "appeal_dismissed",
    label: "έφεση απορρίφθηκε",
    aliases: ["appeal dismissed", "appeal failed", "η έφεση απορρίπτεται"],
    type: "outcome",
  },
  {
    id: "application_dismissed",
    label: "αίτηση απορρίφθηκε",
    aliases: ["application dismissed", "application refused", "η αίτηση απορρίπτεται"],
    type: "outcome",
  },
  {
    id: "conviction_quashed",
    label: "καταδίκη ακυρώθηκε",
    aliases: ["conviction quashed", "conviction set aside", "ακύρωση καταδίκης"],
    type: "outcome",
  },
  {
    id: "sentence_reduced",
    label: "μείωση ποινής",
    aliases: ["sentence reduced", "reduction of sentence", "ποινή μειώθηκε"],
    type: "outcome",
  },
];

const ALIAS_TO_CONCEPT = new Map<string, LegalConceptV1>();
for (const concept of LEGAL_CONCEPTS) {
  for (const alias of [concept.label, ...concept.aliases]) {
    ALIAS_TO_CONCEPT.set(normalizeLegalText(alias), concept);
  }
}

export function conceptById(id: string): LegalConceptV1 | undefined {
  return LEGAL_CONCEPTS.find((concept) => concept.id === id);
}

export function detectConcepts(value: string): LegalConceptV1[] {
  const normalized = normalizeLegalText(value);
  if (!normalized) return [];
  const detected = new Map<string, LegalConceptV1>();
  for (const [alias, concept] of ALIAS_TO_CONCEPT) {
    if (alias && normalized.includes(alias)) detected.set(concept.id, concept);
  }
  return [...detected.values()];
}

export function expandWithLegalSynonyms(value: string): string[] {
  const terms = new Set<string>(tokenizeLegalText(value));
  for (const concept of detectConcepts(value)) {
    terms.add(normalizeLegalText(concept.label));
    terms.add(concept.id.replace(/_/g, " "));
    for (const alias of concept.aliases) terms.add(normalizeLegalText(alias));
  }
  return [...terms].filter(Boolean);
}

export function aliasesForConcept(value: string): string[] {
  const direct = ALIAS_TO_CONCEPT.get(normalizeLegalText(value));
  if (!direct) return [];
  return [direct.label, ...direct.aliases];
}
