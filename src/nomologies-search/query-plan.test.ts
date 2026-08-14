import { buildQueryPlan, greekToLatin } from "./query-plan.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("classifies exact case number as identity and disables semantic", () => {
  const plan = buildQueryPlan("Πολιτική Έφεση Αρ. 30/2016");
  assert(plan.intent === "identity", `unexpected intent ${plan.intent}`);
  assert(plan.semanticMode === "never", `unexpected semantic mode ${plan.semanticMode}`);
});

Deno.test("recognises provisions", () => {
  const plan = buildQueryPlan("Κεφ. 224 άρθρο 61");
  assert(plan.intent === "provision", `unexpected intent ${plan.intent}`);
  assert(plan.provisionReferences.some((reference) => reference.article === "61"), "article 61 missing");
});

Deno.test("natural language runs semantic lane", () => {
  const plan = buildQueryPlan("Πότε επεμβαίνει το Εφετείο στην αξιολόγηση της αξιοπιστίας μάρτυρα;");
  assert(plan.intent === "natural_language", `unexpected intent ${plan.intent}`);
  assert(plan.semanticMode === "always", `unexpected semantic mode ${plan.semanticMode}`);
});

Deno.test("Greeklish transliteration is stable", () => {
  assert(greekToLatin("εχθρική κατοχή") === "echthriki katochi", greekToLatin("εχθρική κατοχή"));
});

Deno.test("boolean exclusions are preserved", () => {
  const plan = buildQueryPlan('"ιδιωτική ζωή" -δυσφήμιση');
  assert(plan.precisionSyntax, "precision syntax not detected");
  assert(plan.negativeTerms.length === 1, "negative term missing");
});
