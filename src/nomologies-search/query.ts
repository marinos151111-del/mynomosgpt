import {
  LEGAL_CONCEPTS,
  detectConcepts,
  expandWithLegalSynonyms,
} from "./synonyms.ts";
import {
  foldGreek,
  greekToLatin,
  normalizeCaseNumber,
  normalizeLegalText,
  tokenizeLegalText,
} from "./normalize.ts";
import type {
  ParsedSearchQueryV1,
  SearchFiltersV1,
  SearchIntentV1,
} from "./types.ts";

const OUTCOME_ALIASES: Array<[RegExp, SearchFiltersV1["outcome"]]> = [
  [/(?:έφεση|appeal).{0,18}(?:απορρίφ|dismiss)/iu, "appeal_dismissed"],
  [/(?:έφεση|appeal).{0,18}(?:επιτράπ|δεκτ|allow)/iu, "appeal_allowed"],
  [/(?:αίτηση|application).{0,18}(?:απορρίφ|dismiss|refus)/iu, "application_dismissed"],
  [/(?:καταδίκ|conviction).{0,18}(?:ακυρ|quash|set aside)/iu, "conviction_quashed"],
  [/(?:ποιν|sentence).{0,18}(?:μειώ|reduc)/iu, "sentence_reduced"],
];

const LEGAL_AREA_SIGNALS: Array<[RegExp, SearchFiltersV1["legalArea"]]> = [
  [/(πολιτικ(?:η|ης) δικονομ|civil procedure|cpr 2023)/iu, "civil_procedure"],
  [/(ποινικ(?:η|ης) δικονομ|criminal procedure)/iu, "criminal_procedure"],
  [/(συμβασ|contract)/iu, "contract"],
  [/(κατασκευ|construction)/iu, "construction"],
  [/(κτηματολογ|land registry)/iu, "land_registry"],
  [/(ακινητ|property|right of way|δικαιωμα διοδου)/iu, "property"],
  [/(εταιρικ|company|director|shareholder)/iu, "company"],
  [/(φορο|tax)/iu, "tax"],
  [/(μεταναστ|immigration|απελασ)/iu, "immigration"],
  [/(ασυλο|asylum)/iu, "asylum"],
  [/(αποδειξ|evidence|μαρτυρ)/iu, "evidence"],
  [/(ποιν(?:η|ης)|sentence|sentencing)/iu, "sentencing"],
];

const PROCEEDING_SIGNALS: Array<[RegExp, SearchFiltersV1["proceedingType"]]> = [
  [/(επίσπευσ|κατά προτεραιότητα|expedited appeal|expedition application|epispefsi)/iu, "expedition_application"],
  [/(certiorari)/iu, "certiorari"],
  [/(habeas corpus)/iu, "habeas_corpus"],
  [/(ποινικ(?:η|ης) έφεσ|criminal appeal)/iu, "criminal_appeal"],
  [/(πολιτικ(?:η|ης) έφεσ|civil appeal)/iu, "civil_appeal"],
  [/(διοικητικ(?:η|ης) έφεσ|administrative appeal)/iu, "administrative_appeal"],
];

function quotedPhrases(raw: string): string[] {
  const output: string[] = [];
  const pattern = /["“«]([^"”»]{2,200})["”»]/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw))) output.push(normalizeLegalText(match[1]));
  return [...new Set(output.filter(Boolean))];
}

function excludedTerms(raw: string): string[] {
  return [...raw.matchAll(/(?:^|\s)-([\p{L}\p{N}_/-]{2,80})/gu)]
    .map((match) => normalizeLegalText(match[1]))
    .filter(Boolean);
}

function detectedCaseNumbers(raw: string): string[] {
  const patterns = [
    /\b[Α-ΩA-Z]{0,5}\s*\d{1,5}\s*\/\s*(?:19|20)\d{2}\b/giu,
    /\b(?:ΠΟΛ\.?\s*ΕΦ\.?|ΠΟΙΝ\.?\s*ΕΦ\.?|ΑΙΤ\.?|ΕΦ\.?)[^,;\n]{0,20}\d{1,5}\s*\/\s*(?:19|20)\d{2}\b/giu,
  ];
  return [...new Set(patterns.flatMap((pattern) => [...raw.matchAll(pattern)].map((match) => normalizeCaseNumber(match[0]))))];
}

function detectedCitations(raw: string): string[] {
  const patterns = [
    /\((?:19|20)\d{2}\)\s*\d*(?:\([Α-ΩA-Z]\))?\s*(?:Α\.Α\.Δ\.|C\.L\.R\.|W\.L\.R\.)\s*\d+/giu,
    /ECLI:[A-Z]{2}:[A-Z0-9:._-]+/giu,
  ];
  return [...new Set(patterns.flatMap((pattern) => [...raw.matchAll(pattern)].map((match) => normalizeLegalText(match[0]))))];
}

function detectedProvisions(raw: string): string[] {
  const patterns = [
    /(?:κεφ\.?|κεφάλαιο)\s*\d+[a-zα-ω-]*/giu,
    /(?:ν\.?|νόμος)\s*\d+\s*\/\s*\d{2,4}/giu,
    /(?:άρθρο|αρθρο|article)\s*\d+[a-zα-ω]*(?:\([^)]{1,20}\))*/giu,
    /(?:μέρος|μερος|part)\s*\d+(?:\.\d+)*(?:\([^)]{1,20}\))*/giu,
  ];
  return [...new Set(patterns.flatMap((pattern) => [...raw.matchAll(pattern)].map((match) => normalizeLegalText(match[0]))))];
}

function yearFilters(raw: string, filters: SearchFiltersV1): void {
  const from = raw.match(/(?:από|from|after)\s*[:=]?\s*((?:19|20)\d{2})/iu);
  const to = raw.match(/(?:έως|μέχρι|to|before)\s*[:=]?\s*((?:19|20)\d{2})/iu);
  const range = raw.match(/\b((?:19|20)\d{2})\s*[-–]\s*((?:19|20)\d{2})\b/u);
  if (range) {
    filters.yearFrom = Number(range[1]);
    filters.yearTo = Number(range[2]);
  }
  if (from) filters.yearFrom = Number(from[1]);
  if (to) filters.yearTo = Number(to[1]);
}

function explicitFilter(raw: string, label: string): string {
  const pattern = new RegExp(`(?:^|\\s)${label}\\s*:\\s*(?:"([^"]+)"|([^,;]+))`, "iu");
  const match = raw.match(pattern);
  return normalizeLegalText(match?.[1] || match?.[2] || "");
}

function detectIntent(normalized: string, caseNumbers: string[], provisions: string[]): SearchIntentV1 {
  if (caseNumbers.length || /ecli|citation|παραπομπη|αριθμ(?:ο|ός) υποθεσ/u.test(normalized)) return "identity";
  if (provisions.length || /αρθρο|κεφαλαιο|νομος|μερος \d/u.test(normalized)) return "provision";
  if (/followed|distinguished|overruled|adopted|παρέπεμ|ακολουθη|διακριθ|ανατραπ/u.test(normalized)) return "authority";
  if (/νομικ(?:η|ης) αρχ|ratio|κριση|holding|test|κριτηρ/u.test(normalized)) return "principle";
  if (/εκβαση|αποτελεσμα|απορριφ|επιτραπ|καταδικ|ποιν/u.test(normalized)) return "outcome";
  if (/εφεσ|αιτησ|προσφυγ|certiorari|habeas|δικον|procedure/u.test(normalized)) return "procedure";
  if (/μαρτυρ|αξιοπιστ|εγγραφο|evidence|witness/u.test(normalized)) return "evidence";
  if (/γεγονοτ|χρονολογ|facts|timeline/u.test(normalized)) return "facts";
  return "general";
}

function naturalFilters(raw: string): SearchFiltersV1 {
  const filters: SearchFiltersV1 = {};
  for (const [pattern, value] of OUTCOME_ALIASES) if (pattern.test(raw)) filters.outcome = value;
  for (const [pattern, value] of LEGAL_AREA_SIGNALS) if (pattern.test(raw)) filters.legalArea = value;
  for (const [pattern, value] of PROCEEDING_SIGNALS) if (pattern.test(raw)) filters.proceedingType = value;

  if (/(εφετειο κυπρου|court of appeal)/iu.test(raw)) filters.courtLevel = "court_of_appeal";
  if (/(ανωτατο συνταγματικο|supreme constitutional)/iu.test(raw)) filters.courtLevel = "supreme_constitutional_court";
  if (/(ανωτατο δικαστηριο|supreme court)/iu.test(raw)) filters.courtLevel = "supreme_court";

  const judge = explicitFilter(raw, "(?:δικαστ(?:ης|ή)|judge)");
  const court = explicitFilter(raw, "(?:δικαστηριο|court)");
  const lawId = explicitFilter(raw, "(?:νομος|law)");
  if (judge) filters.judge = judge;
  if (court) filters.court = court;
  if (lawId) filters.lawId = lawId;
  yearFilters(raw, filters);
  return filters;
}

export function parseSearchQuery(rawValue: string, suppliedFilters: SearchFiltersV1 = {}): ParsedSearchQueryV1 {
  const raw = String(rawValue || "").trim();
  const normalized = normalizeLegalText(raw);
  const caseNumbers = detectedCaseNumbers(raw);
  const citations = detectedCitations(raw);
  const provisions = detectedProvisions(raw);
  const phrases = quotedPhrases(raw);
  const excluded = excludedTerms(raw);
  const filters = { ...naturalFilters(raw), ...suppliedFilters };
  if (provisions.length && !filters.provision) filters.provision = provisions[0];

  const concepts = detectConcepts(`${raw} ${greekToLatin(raw)}`);
  const terms = tokenizeLegalText(raw);
  const expanded = new Set<string>([
    ...terms,
    ...expandWithLegalSynonyms(raw),
    ...caseNumbers.map(normalizeCaseNumber),
    ...citations,
    ...provisions,
  ]);
  for (const concept of concepts) {
    expanded.add(normalizeLegalText(concept.label));
    expanded.add(concept.id.replace(/_/g, " "));
    for (const alias of concept.aliases) expanded.add(normalizeLegalText(alias));
  }

  // Greeklish users often omit accents and use Latin characters. Compare the
  // Latin form of known concepts against the Latin form of the query.
  const latinQuery = foldGreek(greekToLatin(raw));
  for (const concept of LEGAL_CONCEPTS) {
    const variants = [concept.label, ...concept.aliases].map((item) => foldGreek(greekToLatin(item)));
    if (variants.some((variant) => variant.length > 4 && latinQuery.includes(variant))) {
      expanded.add(normalizeLegalText(concept.label));
      for (const alias of concept.aliases) expanded.add(normalizeLegalText(alias));
    }
  }

  return {
    raw,
    normalized,
    intent: detectIntent(normalized, caseNumbers, provisions),
    terms,
    expandedTerms: [...expanded].filter(Boolean),
    exactPhrases: phrases,
    excludedTerms: excluded,
    detectedCaseNumbers: caseNumbers,
    detectedCitations: citations,
    detectedProvisions: provisions,
    filters,
  };
}
