import { LexicalCaseIndexV1 } from "./lexical.ts";
import { parseSearchQuery } from "./query-elite.ts";
import type { SearchDocumentV1, SearchFieldNameV1 } from "./types.ts";
import { NOMOLOGIES_SEARCH_VERSION } from "./types.ts";
import { normalizeLegalText } from "./normalize.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function document(input: {
  id: string;
  title: string;
  caseNumber: string;
  fields: Array<[SearchFieldNameV1, string, number]>;
  tags?: Array<{ label: string; kind?: "procedure" | "principle" | "fact" | "provision" | "outcome" }>;
  legalArea?: "civil_procedure" | "property" | "criminal";
  proceedingType?: "expedition_application" | "civil_appeal" | "criminal_appeal";
  outcome?: "application_dismissed" | "appeal_dismissed" | "conviction_quashed";
  provisionKeys?: string[];
}): SearchDocumentV1 {
  return {
    schemaVersion: NOMOLOGIES_SEARCH_VERSION,
    id: input.id,
    runId: input.id,
    sourceUrl: "https://www.cylaw.org/example",
    sourceHash: input.id,
    title: input.title,
    shortTitle: input.title,
    citation: input.caseNumber,
    caseNumber: input.caseNumber,
    decisionDate: "17 Ιουλίου 2026",
    year: 2026,
    court: "Εφετείο Κύπρου",
    judges: ["ΣΤΑΥΡΟΥ"],
    authoringJudges: ["ΣΤΑΥΡΟΥ"],
    outcome: input.outcome || "appeal_dismissed",
    aliases: [normalizeLegalText(input.title), input.caseNumber],
    exactTerms: [input.caseNumber, ...(input.provisionKeys || [])],
    smartTags: (input.tags || []).map((tag, index) => ({
      id: `${input.id}_${index}`,
      label: tag.label,
      normalized: normalizeLegalText(tag.label),
      kind: tag.kind || "principle",
      confidence: 0.98,
      aliases: [tag.label],
      evidenceParagraphIds: ["P000001"],
      boost: tag.kind === "provision" ? 15 : 12,
      sourceField: "test",
    })),
    facets: {
      caseFamily: input.legalArea === "criminal" ? "criminal_law" : "private_law",
      legalAreas: [input.legalArea || "civil_procedure"],
      primaryLegalArea: input.legalArea || "civil_procedure",
      proceedingType: input.proceedingType || "civil_appeal",
      proceduralPosture: "appeal",
      courtLevel: "court_of_appeal",
      court: "Εφετείο Κύπρου",
      year: 2026,
      judges: ["ΣΤΑΥΡΟΥ"],
      authoringJudges: ["ΣΤΑΥΡΟΥ"],
      outcomes: [input.outcome || "appeal_dismissed"],
      lawIds: input.provisionKeys?.length ? ["14/60"] : [],
      provisionKeys: input.provisionKeys || [],
      authorityTreatments: ["applied"],
      authorityContexts: ["direct"],
    },
    fields: input.fields.map(([name, text, weight]) => ({
      name,
      text,
      normalized: normalizeLegalText(text),
      weight,
      paragraphIds: ["P000001"],
    })),
    quality: {
      readinessScore: 92,
      strictReady: true,
      humanReviewRequired: false,
      criticalConflicts: 0,
      materialConflicts: 0,
      evidenceCount: 20,
    },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function index(): LexicalCaseIndexV1 {
  const search = new LexicalCaseIndexV1();
  search.upsert(document({
    id: "e5",
    title: "Κυπριακή Δημοκρατία v. Intrakat",
    caseNumber: "E5/2025",
    legalArea: "civil_procedure",
    proceedingType: "expedition_application",
    outcome: "application_dismissed",
    provisionKeys: ["νομος 14/60 αρθρο 32", "κανονισμοι πολιτικης δικονομιας 2023 μερος 41.4"],
    tags: [
      { label: "επίσπευση έφεσης", kind: "procedure" },
      { label: "δικαστική διακριτική ευχέρεια", kind: "principle" },
      { label: "καθυστέρηση που αποδυναμώνει το κατεπείγον", kind: "principle" },
      { label: "Νόμος 14/60 · άρθρο 32", kind: "provision" },
    ],
    fields: [
      ["principle", "Η κατά προτεραιότητα εκδίκαση έφεσης επαφίεται στη διακριτική ευχέρεια του Εφετείου.", 13],
      ["issues", "Καθυστέρηση στην αίτηση επίσπευσης και παράλληλες διαδικασίες.", 10],
      ["provisions", "Κανονισμοί Πολιτικής Δικονομίας 2023 Μέρος 41.4 και Νόμος 14/60 άρθρο 32.", 12],
      ["outcome", "Η αίτηση απορρίπτεται.", 10],
    ],
  }));
  search.upsert(document({
    id: "property",
    title: "Αλεξάνδρου v. Edward",
    caseNumber: "30/2016",
    legalArea: "property",
    proceedingType: "civil_appeal",
    tags: [
      { label: "εχθρική κατοχή", kind: "principle" },
      { label: "κτηματολογική εγγραφή", kind: "fact" },
    ],
    fields: [
      ["principle", "Η εχθρική κατοχή μπορεί να θεμελιώσει δικαίωμα εγγραφής ακινήτου.", 13],
      ["facts", "Αμφισβήτηση κτηματολογικής εγγραφής και κατοχής τεμαχίου.", 6],
    ],
  }));
  search.upsert(document({
    id: "criminal",
    title: "Δημοκρατία v. Κατηγορουμένου",
    caseNumber: "115/2026",
    legalArea: "criminal",
    proceedingType: "criminal_appeal",
    outcome: "conviction_quashed",
    tags: [{ label: "καταδίκη ακυρώθηκε", kind: "outcome" }],
    fields: [
      ["principle", "Η εσφαλμένη καθοδήγηση ενόρκων επέβαλε την ακύρωση της καταδίκης.", 13],
      ["outcome", "Η καταδίκη ακυρώνεται και διατάσσεται επανεκδίκαση.", 10],
    ],
  }));
  return search;
}

Deno.test("exact case number dominates the ranking", () => {
  const result = index().search(parseSearchQuery("E5/2025"), 10);
  assert(result.hits[0]?.document.id === "e5", "E5/2025 should rank first");
  assert(result.hits[0].scoreBreakdown.exactIdentity >= 150, "exact identity boost should be visible");
});

Deno.test("Greek legal concept query retrieves the expedition case", () => {
  const result = index().search(parseSearchQuery("επίσπευση έφεσης λόγω καθυστέρησης"), 10);
  assert(result.hits[0]?.document.id === "e5", "expedition case should rank first");
  assert(result.hits[0].matchedTags.some((tag) => tag.label.includes("επίσπευση")), "smart tag should explain match");
});

Deno.test("Greeklish query expands to the Cyprus legal concept", () => {
  const parsed = parseSearchQuery("epispefsi efesis");
  assert(parsed.expandedTerms.some((term) => normalizeLegalText(term).includes(normalizeLegalText("επίσπευση"))), "Greeklish should expand to Greek concept");
  const result = index().search(parsed, 10);
  assert(result.hits[0]?.document.id === "e5", "Greeklish expedition query should rank E5 first");
});

Deno.test("law and article query ranks provision-bearing case", () => {
  const result = index().search(parseSearchQuery("Νόμος 14/60 άρθρο 32"), 10);
  assert(result.hits[0]?.document.id === "e5", "Article 32 case should rank first");
});

Deno.test("substantive property concept remains distinguishable", () => {
  const result = index().search(parseSearchQuery("εχθρική κατοχή κτηματολογική εγγραφή"), 10);
  assert(result.hits[0]?.document.id === "property", "property case should rank first");
});

Deno.test("structured filters are applied before ranking", () => {
  const result = index().search(parseSearchQuery("ακύρωση", { legalArea: "criminal" }), 10);
  assert(result.hits.length === 1 && result.hits[0].document.id === "criminal", "criminal filter should isolate criminal case");
});
