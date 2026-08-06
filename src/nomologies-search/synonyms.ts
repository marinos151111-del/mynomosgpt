import { normalizeLegalText, tokenizeLegalText } from "./normalize.ts";
import { ELITE_LEGAL_CONCEPTS } from "./elite-concepts.ts";

export interface LegalConceptV1 {
  id: string;
  label: string;
  aliases: string[];
  type: "procedure" | "area" | "principle" | "outcome" | "evidence" | "remedy" | "institution";
}

const CORE_LEGAL_CONCEPTS: LegalConceptV1[] = [
  {
    id: "expedition_of_appeal",
    label: "επίσπευση",
    aliases: ["επίσπευση έφεσης", "κατά προτεραιότητα εκδίκαση", "ταχεία εκδίκαση", "priority hearing", "expedited appeal", "epispefsi"],
    type: "procedure",
  },
  {
    id: "judicial_discretion",
    label: "δικαστική διακριτική ευχέρεια",
    aliases: ["δικαστική διακριτική ευχέρεια", "διακριτική ευχέρεια του δικαστηρίου", "judicial discretion"],
    type: "principle",
  },
  {
    id: "interlocutory_decision",
    label: "ενδιάμεση",
    aliases: ["ενδιάμεση απόφαση", "ενδιάμεσο διάταγμα", "παρεμπίπτουσα απόφαση", "interlocutory decision", "interim order"],
    type: "procedure",
  },
  {
    id: "non_binding_interpretation",
    label: "δεσμευτικότητα",
    aliases: ["μη δεσμευτική ερμηνεία", "μη οριστική ερμηνεία", "μη δεσμευτική κρίση", "non-binding interpretation"],
    type: "principle",
  },
  {
    id: "parallel_proceedings",
    label: "εκκρεμοδικία",
    aliases: ["παράλληλες διαδικασίες", "παράλληλες δικαστικές διαδικασίες", "lis pendens", "parallel proceedings"],
    type: "procedure",
  },
  {
    id: "conflicting_judgments",
    label: "αντίφαση",
    aliases: ["αντιφατικές αποφάσεις", "κίνδυνος αντιφατικών αποφάσεων", "conflicting judgments", "inconsistent decisions"],
    type: "principle",
  },
  {
    id: "preliminary_reference_cjeu",
    label: "παραπομπή",
    aliases: ["προδικαστικό ερώτημα", "παραπομπή στο ΔΕΕ", "προδικαστική παραπομπή", "preliminary reference", "CJEU reference"],
    type: "procedure",
  },
  {
    id: "urgency",
    label: "κατεπείγον",
    aliases: ["επείγουσα ανάγκη", "επείγουσα εκδίκαση", "urgency", "urgent relief", "delay undermines urgency"],
    type: "principle",
  },
  {
    id: "interim_injunction",
    label: "προσωρινό απαγορευτικό διάταγμα",
    aliases: ["προσωρινό απαγορευτικό διάταγμα", "ενδιάμεσο διάταγμα", "interim injunction", "temporary injunction", "injunction"],
    type: "remedy",
  },
  {
    id: "bank_guarantee",
    label: "εγγυητική",
    aliases: ["τραπεζική εγγυητική επιστολή", "εγγυητική προκαταβολής", "εγγυητική πιστής εκτέλεσης", "bank guarantee", "performance guarantee"],
    type: "area",
  },
  {
    id: "civil_procedure",
    label: "πολιτικοδικονομία",
    aliases: ["πολιτική δικονομία", "κανονισμοί πολιτικής δικονομίας", "civil procedure", "CPR 2023", "civil_procedure"],
    type: "area",
  },
  {
    id: "criminal_procedure",
    label: "ποινικοδικονομία",
    aliases: ["ποινική δικονομία", "ποινική διαδικασία", "criminal procedure", "criminal_procedure"],
    type: "area",
  },
  {
    id: "jurisdiction",
    label: "δικαιοδοσία",
    aliases: ["δικαιοδοσία δικαστηρίου", "δικαιοδοσίας", "καθ' ύλην δικαιοδοσία", "κατά τόπον δικαιοδοσία", "αρμοδιότητα δικαστηρίου", "jurisdiction", "dikaiodosia"],
    type: "principle",
  },
  {
    id: "compensation",
    label: "αποζημίωση",
    aliases: ["αποζημιώσεις", "γενικές αποζημιώσεις", "γενικών αποζημιώσεων", "ειδικές αποζημιώσεις", "ειδικών αποζημιώσεων", "damages", "compensation", "monetary award", "apozimiosi"],
    type: "remedy",
  },
  {
    id: "limitation",
    label: "παραγραφή",
    aliases: ["παραγραφής", "περίοδος παραγραφής", "χρόνος παραγραφής", "limitation period", "time barred", "statute of limitations"],
    type: "principle",
  },
  {
    id: "adverse_possession",
    label: "εχθρική κατοχή",
    aliases: ["χρησικτησία", "χρησικτησίας", "εχθρικής κατοχής", "κτητική παραγραφή", "κτητικής παραγραφής", "adverse possession", "continuous adverse possession"],
    type: "area",
  },
  {
    id: "cancellation_of_registration",
    label: "ακύρωση εγγραφής",
    aliases: ["ακύρωση κτηματολογικής εγγραφής", "παραμερισμός εγγραφής", "cancellation of registration", "setting aside registration"],
    type: "remedy",
  },
  {
    id: "probative_value",
    label: "αποδεικτική αξία",
    aliases: ["αποδεικτική δύναμη", "στερείται αποδεικτικής αξίας", "probative value", "evidential value"],
    type: "evidence",
  },
  {
    id: "community_certificate",
    label: "κοινοτικό πιστοποιητικό",
    aliases: ["πιστοποιητικό κοινοτικής αρχής", "πιστοποιητικό του κοινοτάρχη", "community authority certificate", "village authority certificate"],
    type: "evidence",
  },
  {
    id: "private_life",
    label: "ιδιωτική ζωή",
    aliases: ["σεβασμός της ιδιωτικής ζωής", "δικαίωμα στην ιδιωτική ζωή", "private life", "privacy"],
    type: "area",
  },
  {
    id: "reasonable_expectation_of_privacy",
    label: "εύλογη προσδοκία ιδιωτικότητας",
    aliases: ["εύλογη προσδοκία σεβασμού της ιδιωτικής ζωής", "reasonable expectation of privacy", "expectation of privacy"],
    type: "principle",
  },
  {
    id: "identifiability",
    label: "αναγνωρισιμότητα",
    aliases: ["αναγνωρίσιμο πρόσωπο", "δυνατότητα αναγνώρισης", "identifiability", "recognisable person", "identifiable person"],
    type: "principle",
  },
  {
    id: "conditional_contract",
    label: "σύμβαση υπό αίρεση",
    aliases: ["συμφωνία υπό αίρεση", "conditional contract", "contract subject to condition"],
    type: "area",
  },
  {
    id: "voidable_contract",
    label: "ακυρώσιμη σύμβαση",
    aliases: ["ακυρώσιμη συμφωνία", "voidable contract", "rescissible contract"],
    type: "area",
  },
  {
    id: "credibility_review",
    label: "αξιοπιστία",
    aliases: ["αξιολόγηση αξιοπιστίας", "αξιολόγησης αξιοπιστίας", "αξιοπιστία μαρτύρων", "αξιοπιστίας μαρτύρων", "εφετειακή παρέμβαση στην αξιοπιστία", "credibility findings", "witness credibility"],
    type: "evidence",
  },
  {
    id: "hearsay",
    label: "εξακοής",
    aliases: ["εξ ακοής μαρτυρία", "μαρτυρία εξ ακοής", "hearsay", "hearsay evidence"],
    type: "evidence",
  },
  {
    id: "burden_of_proof",
    label: "απόδειξη",
    aliases: ["βάρος απόδειξης", "αποδεικτικό βάρος", "burden of proof", "onus of proof"],
    type: "evidence",
  },
  {
    id: "standard_of_proof",
    label: "πιθανότητες",
    aliases: ["μέτρο απόδειξης", "ισοζύγιο πιθανοτήτων", "standard of proof", "balance of probabilities"],
    type: "evidence",
  },
  {
    id: "negligence",
    label: "αμέλεια",
    aliases: ["αστική αμέλεια", "αστικής αμέλειας", "καθήκον επιμέλειας", "παράβαση καθήκοντος επιμέλειας", "negligence", "duty of care"],
    type: "area",
  },
  {
    id: "causation",
    label: "αιτιότητα",
    aliases: ["αιτιώδης σύνδεσμος", "αιτιώδους συνδέσμου", "αιτιώδης συνάφεια", "αιτιώδους συνάφειας", "causation", "causal link"],
    type: "principle",
  },
  {
    id: "contract",
    label: "σύμβαση",
    aliases: ["σύμβαση", "σύμβασης", "συμβατική διαφορά", "συμβατικές υποχρεώσεις", "contract", "contractual obligations"],
    type: "area",
  },
  {
    id: "breach",
    label: "παράβαση",
    aliases: ["παράβαση σύμβασης", "παράβασης σύμβασης", "παραβίαση υποχρέωσης", "breach of contract", "breach of duty"],
    type: "principle",
  },
  {
    id: "property",
    label: "ιδιοκτησία",
    aliases: ["ακίνητη ιδιοκτησία", "ακίνητης ιδιοκτησίας", "κυριότητα ακινήτου", "property law", "ownership", "property"],
    type: "area",
  },
  {
    id: "land_registry",
    label: "κτηματολόγιο",
    aliases: ["κτηματολογική διαφορά", "κτηματολογικές διαφορές", "κτηματικό μητρώο", "land registry", "land_registry"],
    type: "area",
  },
  {
    id: "company",
    label: "εταιρείες",
    aliases: ["εταιρικό δίκαιο", "εταιρική διαφορά", "company law", "corporate law", "company"],
    type: "area",
  },
  {
    id: "insolvency",
    label: "αφερεγγυότητα",
    aliases: ["πτώχευση", "εκκαθάριση εταιρείας", "insolvency", "bankruptcy", "liquidation"],
    type: "area",
  },
  {
    id: "tax",
    label: "φορολογία",
    aliases: ["φορολογικό δίκαιο", "φορολογική διαφορά", "tax law", "taxation", "tax"],
    type: "area",
  },
  {
    id: "immigration",
    label: "μετανάστευση",
    aliases: ["μεταναστευτικό δίκαιο", "άδεια παραμονής", "immigration", "residence permit"],
    type: "area",
  },
  {
    id: "asylum",
    label: "άσυλο",
    aliases: ["διεθνής προστασία", "αιτητής ασύλου", "asylum", "international protection"],
    type: "area",
  },
  {
    id: "constitutional_law",
    label: "συνταγματικότητα",
    aliases: ["συνταγματικό δίκαιο", "αντισυνταγματικότητα", "constitutional law", "constitutionality", "constitutional_law"],
    type: "area",
  },
  {
    id: "employment_law",
    label: "εργασία",
    aliases: ["εργατικό δίκαιο", "εργασιακή διαφορά", "employment law", "labour law", "employment_law"],
    type: "area",
  },
  {
    id: "family_law",
    label: "οικογένεια",
    aliases: ["οικογενειακό δίκαιο", "οικογενειακή διαφορά", "family law", "family_law"],
    type: "area",
  },
  {
    id: "sentencing",
    label: "ποινή",
    aliases: ["επιμέτρηση ποινής", "ύψος ποινής", "sentencing", "sentence", "sentencing"],
    type: "area",
  },
  {
    id: "discrimination",
    label: "απαγόρευση διακρίσεων",
    aliases: ["απαγόρευση διακρίσεων", "άνιση μεταχείριση", "discrimination", "equal treatment"],
    type: "principle",
  },
  {
    id: "proportionality",
    label: "αναλογικότητα",
    aliases: ["αρχή της αναλογικότητας", "δυσανάλογο μέτρο", "proportionality"],
    type: "principle",
  },
  {
    id: "legitimate_expectation",
    label: "προσδοκία",
    aliases: ["δικαιολογημένη εμπιστοσύνη", "έννομη προσδοκία", "legitimate expectation"],
    type: "principle",
  },
  {
    id: "standing",
    label: "νομιμοποίηση",
    aliases: ["έννομο συμφέρον", "ενεργητική νομιμοποίηση", "ενεργητικής νομιμοποίησης", "παθητική νομιμοποίηση", "παθητικής νομιμοποίησης", "standing", "locus standi"],
    type: "procedure",
  },
  {
    id: "res_judicata",
    label: "δεδικασμένο",
    aliases: ["αρχή του δεδικασμένου", "res judicata", "issue estoppel"],
    type: "principle",
  },
  {
    id: "abuse_of_process",
    label: "κατάχρηση",
    aliases: ["κατάχρηση διαδικασίας", "καταχρηστική διαδικασία", "abuse of process"],
    type: "principle",
  },
  {
    id: "fair_hearing",
    label: "ακρόαση",
    aliases: ["δικαίωμα ακρόασης", "δίκαιη δίκη", "φυσική δικαιοσύνη", "right to be heard", "fair hearing", "natural justice"],
    type: "principle",
  },
  {
    id: "certiorari",
    label: "ακυρωτικό",
    aliases: ["προνομιακό ένταλμα certiorari", "ένταλμα ακύρωσης", "certiorari", "prerogative writ"],
    type: "procedure",
  },
  {
    id: "habeas_corpus",
    label: "κράτηση",
    aliases: ["ένταλμα habeas corpus", "παράνομη κράτηση", "habeas corpus", "unlawful detention"],
    type: "procedure",
  },
  {
    id: "article_146_recourse",
    label: "προσφυγή",
    aliases: ["προσφυγή άρθρου 146", "άρθρο 146 του Συντάγματος", "administrative recourse", "judicial review under article 146"],
    type: "procedure",
  },
  {
    id: "appeal",
    label: "έφεση",
    aliases: ["πολιτική έφεση", "ποινική έφεση", "διοικητική έφεση", "appeal", "civil_appeal", "criminal_appeal", "administrative_appeal"],
    type: "procedure",
  },
  {
    id: "appeal_allowed",
    label: "επιτυχία",
    aliases: ["έφεση επιτράπηκε", "η έφεση γίνεται δεκτή", "appeal allowed", "appeal succeeded", "appeal_allowed"],
    type: "outcome",
  },
  {
    id: "appeal_dismissed",
    label: "απόρριψη",
    aliases: ["έφεση απορρίφθηκε", "η έφεση απορρίπτεται", "appeal dismissed", "appeal failed", "appeal_dismissed"],
    type: "outcome",
  },
  {
    id: "application_dismissed",
    label: "απόρριψη",
    aliases: ["αίτηση απορρίφθηκε", "η αίτηση απορρίπτεται", "application dismissed", "application refused", "application_dismissed"],
    type: "outcome",
  },
  {
    id: "conviction_quashed",
    label: "ακύρωση",
    aliases: ["καταδίκη ακυρώθηκε", "ακύρωση καταδίκης", "conviction quashed", "conviction set aside", "conviction_quashed"],
    type: "outcome",
  },
  {
    id: "sentence_reduced",
    label: "μείωση",
    aliases: ["μείωση ποινής", "ποινή μειώθηκε", "sentence reduced", "reduction of sentence", "sentence_reduced"],
    type: "outcome",
  },
];

const ELITE_LABEL_RENAMES: Record<string, string> = {
  "έρευνας": "έρευνα",
  "ακυρώσεως": "ακύρωση",
  "πέραν": "αμφιβολία",
  "βάρος": "απόδειξη",
  "καθήκον": "επιμέλεια",
  "μαρτυρία": "εξακοής",
  "έννομο": "νομιμοποίηση",
  "ισοζύγιο": "πιθανότητες",
  "Άρθρο": "νομοθεσία",
  "νόμων": "ερμηνεία",
};

const ELITE_NON_CANONICAL_LABELS = new Set([
  "απόρριψη", "προσωρινό", "συντηρητικό", "διάταγμα", "συνοπτική", "έκθεση",
  "οδηγίες", "ερήμην", "πρόσθετοι", "ένταλμα", "μέσο", "συζητήσιμο", "εντός",
  "σχέδιο", "διττό", "κανόνας", "διάρκεια", "διατάγματα", "παράγωγη", "δίκαιη",
  "σκοπός", "δέουσα", "αρχή", "ανώτερη", "ύψος", "υπόθεση", "δημόσιο",
  "θεμελιώδη", "έκδηλα", "πράξη", "φειδώ", "έλεγχος", "έκδηλη", "ύλες",
  "ηλικία", "συντρέχουσες", "αλλοδαπού", "εύλογος", "λόγος", "σημείο", "σχέση",
  "περιουσιακές", "θέσμια", "όρια", "αιτιολογημένη", "διοικητικής", "εργοδότη",
  "περιουσιακή", "εμφάνιση", "έλλειψη",
]);

const NORMALIZED_ELITE_CONCEPTS: LegalConceptV1[] = ELITE_LEGAL_CONCEPTS
  .map((concept) => ({ ...concept, label: ELITE_LABEL_RENAMES[concept.label] || concept.label }))
  .filter((concept) => !ELITE_NON_CANONICAL_LABELS.has(concept.label));

// Retain the curated modern core, then add the proven v11 MyNomosAI
// vocabulary. The detector deduplicates by semantic id and the tag builder
// deduplicates again by the canonical Greek label.
export const LEGAL_CONCEPTS: LegalConceptV1[] = [
  ...CORE_LEGAL_CONCEPTS,
  ...NORMALIZED_ELITE_CONCEPTS,
];

const ALIAS_TO_CONCEPT = new Map<string, LegalConceptV1>();

// These one-word labels are ambiguous in judgments (for example «διάκριση»
// often means a distinction between two rules, not discrimination). They are
// recognised only from their legally qualified aliases.
const LABEL_REQUIRES_QUALIFIER = new Set([
  "judicial_discretion",
  "interim_injunction",
  "discrimination",
  "elite_030",
  "elite_073",
  "elite_090",
  "elite_116",
]);

function conceptSearchText(value: string): string {
  const suffixes = [
    "οποιησεων", "οποιηση", "ησεων", "ησεως", "ωσεων", "ωσης", "ωσεις", "ικης", "ικου",
    "ικων", "ικους", "ικοι", "ικες", "ικη", "ικο", "οντας", "ουσας", "ματα",
    "ματων", "ματος", "σεις", "σης", "σεως", "εις", "ους", "ων", "ος", "ου",
    "ης", "ας", "ες", "οι", "αι", "ση", "η", "α", "ι",
  ];
  return tokenizeLegalText(value, { keepStopwords: false, stem: false })
    .map((token) => {
      if (!/[α-ω]/u.test(token) || token.length < 6) return token;
      const suffix = suffixes
        .map((item) => item.replace(/ς/g, "σ"))
        .find((item) => token.endsWith(item) && token.length - item.length >= 4);
      return suffix ? token.slice(0, -suffix.length) : token;
    })
    .join(" ");
}

for (const concept of LEGAL_CONCEPTS) {
  const aliases = LABEL_REQUIRES_QUALIFIER.has(concept.id)
    ? concept.aliases
    : [concept.label, ...concept.aliases];
  for (const alias of aliases) {
    const key = conceptSearchText(alias);
    // The modern core is deliberately ordered first. Do not let a broader
    // legacy phrase overwrite a narrower canonical meaning for the same alias.
    if (key && !ALIAS_TO_CONCEPT.has(key)) ALIAS_TO_CONCEPT.set(key, concept);
  }
}

export function conceptById(id: string): LegalConceptV1 | undefined {
  return LEGAL_CONCEPTS.find((concept) => concept.id === id);
}

export function detectConcepts(value: string): LegalConceptV1[] {
  const normalized = conceptSearchText(value);
  if (!normalized) return [];
  const haystack = ` ${normalized} `;
  const detected = new Map<string, LegalConceptV1>();
  for (const [alias, concept] of ALIAS_TO_CONCEPT) {
    if (alias && haystack.includes(` ${alias} `)) detected.set(concept.id, concept);
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
  const direct = ALIAS_TO_CONCEPT.get(conceptSearchText(value));
  if (!direct) return [];
  return [direct.label, ...direct.aliases];
}
