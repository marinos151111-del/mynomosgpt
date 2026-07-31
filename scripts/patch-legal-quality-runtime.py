from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def patch(path: str, old: str, new: str) -> None:
    file = ROOT / path
    content = file.read_text(encoding="utf-8")
    if old not in content:
        raise SystemExit(f"Anchor not found in {path}: {old[:100]!r}")
    file.write_text(content.replace(old, new, 1), encoding="utf-8")


patch(
    "src/nomologies-v2/agents.ts",
    'import { NOMOLOGIES_SCHEMAS } from "./schemas.ts";',
    'import { NOMOLOGIES_SCHEMAS } from "./schemas.ts";\nimport { reconcileNomologiesQuality } from "./quality.ts";',
)
patch(
    "src/nomologies-v2/agents.ts",
    '''  "legal_framework", "quoted_legislation", "quoted_authority", "court_analysis",''',
    '''  "legal_framework", "quoted_legislation", "quoted_authority", "adopted_authority", "court_analysis",''',
)
patch(
    "src/nomologies-v2/agents.ts",
    '''  reconcileSpecialistFields({
    facts: factsProcedure.facts,
    procedure: factsProcedure.procedure,
    analysis,
    outcome,
    flags,
  });

  return {''',
    '''  reconcileSpecialistFields({
    facts: factsProcedure.facts,
    procedure: factsProcedure.procedure,
    analysis,
    outcome,
    flags,
  });
  reconcileNomologiesQuality({
    source,
    context,
    classification: identity.classification,
    procedure: factsProcedure.procedure,
    analysis,
    authorities,
    outcome,
    flags,
  });

  return {''',
)

patch(
    "src/nomologies-v2/pipeline.ts",
    'import { runSpecialistAgents, type SpecialistResultsV2 } from "./agents.ts";',
    'import { runSpecialistAgents, type SpecialistResultsV2 } from "./agents.ts";\nimport { detectSourceDateConflicts } from "./quality.ts";',
)
patch(
    "src/nomologies-v2/pipeline.ts",
    '''function deterministicConflicts(
  results: SpecialistResultsV2,
  sectionMap: SectionMapV2,
  officialSource: boolean,
): PipelineConflictV2[] {''',
    '''function deterministicConflicts(
  source: Awaited<ReturnType<typeof prepareJudgmentSource>>,
  results: SpecialistResultsV2,
  sectionMap: SectionMapV2,
  officialSource: boolean,
): PipelineConflictV2[] {''',
)
patch(
    "src/nomologies-v2/pipeline.ts",
    '''  if (!fieldAvailable(results.outcome.dispositionText)) add("DISPOSITION_UNVERIFIED", "critical", "outcome.dispositionText", "The operative final order is not evidence-grounded.");

  for (const flag of results.reviewFlags) {
    if (/wrong_section|wrong_speaker|quoted_material_not_permitted/u.test(flag)) {
      add("ATTRIBUTION_VALIDATION_FAILED", "critical", flag.split(":")[0] || "evidence", `Invalid legal attribution: ${flag}`);
    }
  }
  return conflicts;''',
    '''  if (!fieldAvailable(results.outcome.dispositionText)) add("DISPOSITION_UNVERIFIED", "critical", "outcome.dispositionText", "The operative final order is not evidence-grounded.");
  if (!fieldAvailable(results.classification.primaryLegalArea)) add("PRIMARY_LEGAL_AREA_UNVERIFIED", "material", "classification.primaryLegalArea", "The immediate primary legal area is not evidence-grounded.");
  if (!fieldAvailable(results.classification.proceedingType)) add("PROCEEDING_TYPE_UNVERIFIED", "material", "classification.proceedingType", "The immediate proceeding type is not evidence-grounded.");
  conflicts.push(...detectSourceDateConflicts(source));

  // Raw invalid anchors remain visible in reviewFlags, but do not become critical
  // conflicts when the validated field is optional or has been independently repaired.
  return conflicts;''',
)
patch(
    "src/nomologies-v2/pipeline.ts",
    '''  const outcomeFields = [
    results.outcome.overallOutcome, results.outcome.dispositionText,
    results.outcome.components, results.outcome.orders,
  ];''',
    '''  const outcomeFields = [
    results.outcome.overallOutcome, results.outcome.dispositionText,
    results.outcome.orders, results.outcome.costs,
  ];''',
)
patch(
    "src/nomologies-v2/pipeline.ts",
    '''  score -= conflicts.filter((item) => item.severity === "critical").length * 18;
  score -= conflicts.filter((item) => item.severity === "material").length * 5;
  if (reviewerRecommendation === "approve") score += 4;
  if (reviewerRecommendation === "reject") score -= 20;''',
    '''  score -= conflicts.filter((item) => item.severity === "critical").length * 12;
  score -= conflicts.filter((item) => item.severity === "material").length * 4;
  score -= conflicts.filter((item) => item.severity === "minor").length;
  if (reviewerRecommendation === "approve") score += 4;
  if (reviewerRecommendation === "review") score -= 2;
  if (reviewerRecommendation === "reject") score -= 8;''',
)

old_reviewer = '''function reviewerConflicts(
  payload: JsonRecord,
  allEvidenceIds: Set<string>,
  results: SpecialistResultsV2,
): PipelineConflictV2[] {
  return asArray(payload.conflicts).flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const code = str(raw.code) || "REVIEWER_CONFLICT";
    const fieldPath = str(raw.fieldPath);
    if (code === "HOLDING_NOT_POPULATED" && fieldAvailable(results.analysis.holding)) return [];
    if (code === "MISSING_COMPONENT_OUTCOMES" && fieldAvailable(results.outcome.components) &&
      fieldAvailable(results.procedure.groundsOrIssues)) {
      const resolved = results.procedure.groundsOrIssues.value.filter((ground) =>
        ["succeeded", "failed", "partly_succeeded"].includes(ground.result)
      );
      if (results.outcome.components.value.length >= resolved.length) return [];
    }
    if (code === "SECTION_CROSSCONTAMINATION_OUTCOME_IN_FACTS" &&
      fieldAvailable(results.facts.summary) &&
      !/(?:έφεση|αίτηση|προσφυγή)\\s+(?:απορρίπ|επιτρέπ|γίνεται\\s+δεκτ)/iu.test(results.facts.summary.value)) return [];
    if (code === "LOWER_COURT_ORDER_CONFLICT" && results.procedure.lowerCourtDecision.status === "available") return [];
    const severity = str(raw.severity);
    if (!["critical", "material", "minor"].includes(severity)) return [];
    return [{
      code,
      severity: severity as PipelineConflictV2["severity"],
      fieldPath,
      message: str(raw.message),
      evidenceIds: asArray(raw.evidenceIds).map(str).filter((id) => allEvidenceIds.has(id)),
    }];
  });
}'''
new_reviewer = '''function reviewerConflicts(
  payload: JsonRecord,
  validEvidenceRefs: Set<string>,
  results: SpecialistResultsV2,
): PipelineConflictV2[] {
  const explicitlyNumbered = fieldAvailable(results.procedure.groundsOrIssues) &&
    results.procedure.groundsOrIssues.value.some((ground) => ground.number.trim().length > 0);
  return asArray(payload.conflicts).flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const code = str(raw.code) || "REVIEWER_CONFLICT";
    const fieldPath = str(raw.fieldPath);
    if (code === "HOLDING_NOT_POPULATED" && fieldAvailable(results.analysis.holding)) return [];
    if (["MISSING_COMPONENT_OUTCOMES", "OUTCOME_COMPONENTS_INCOMPLETE"].includes(code) && !explicitlyNumbered) return [];
    if (code === "MISSING_COMPONENT_OUTCOMES" && fieldAvailable(results.outcome.components) &&
      fieldAvailable(results.procedure.groundsOrIssues)) {
      const resolved = results.procedure.groundsOrIssues.value.filter((ground) =>
        ["succeeded", "failed", "partly_succeeded"].includes(ground.result)
      );
      if (results.outcome.components.value.length >= resolved.length) return [];
    }
    if (code === "HOLDING_EVIDENCE_MISATTRIBUTED" && fieldAvailable(results.analysis.holding)) return [];
    if (code === "SECTION_CROSSCONTAMINATION_OUTCOME_IN_FACTS" &&
      fieldAvailable(results.facts.summary) &&
      !/(?:έφεση|αίτηση|προσφυγή)\\s+(?:απορρίπ|επιτρέπ|γίνεται\\s+δεκτ)/iu.test(results.facts.summary.value)) return [];
    if (code === "LOWER_COURT_ORDER_CONFLICT" && results.procedure.lowerCourtDecision.status === "available") return [];
    let severity = str(raw.severity);
    if (code === "LEGISLATION_ATTRIBUTION_AMBIGUOUS") severity = "minor";
    if (!["critical", "material", "minor"].includes(severity)) return [];
    return [{
      code,
      severity: severity as PipelineConflictV2["severity"],
      fieldPath,
      message: str(raw.message),
      evidenceIds: asArray(raw.evidenceIds).map(str).filter((id) => validEvidenceRefs.has(id)),
    }];
  });
}'''
patch("src/nomologies-v2/pipeline.ts", old_reviewer, new_reviewer)

patch(
    "src/nomologies-v2/pipeline.ts",
    '''  const deterministic = deterministicConflicts(specialists, sections.map, officialSource);''',
    '''  const deterministic = deterministicConflicts(source, specialists, sections.map, officialSource);''',
)
patch(
    "src/nomologies-v2/pipeline.ts",
    '''  const evidenceIds = new Set(preliminaryEvidence.map((item) => item.id));
  const conflictMap = new Map<string, PipelineConflictV2>();
  for (const conflict of [...deterministic, ...reviewerConflicts(review.payload, evidenceIds, specialists)]) {''',
    '''  const validEvidenceRefs = new Set([
    ...preliminaryEvidence.map((item) => item.id),
    ...source.paragraphs.map((paragraph) => paragraph.id),
  ]);
  const conflictMap = new Map<string, PipelineConflictV2>();
  for (const conflict of [...deterministic, ...reviewerConflicts(review.payload, validEvidenceRefs, specialists)]) {''',
)
patch(
    "src/nomologies-v2/pipeline.ts",
    '''  const recommendation = str(review.payload.publishRecommendation) || "review";
  const readinessScore = scoreReadiness(specialists, sections.map, conflicts, officialSource, recommendation);
  const criticalConflict = conflicts.some((item) => item.severity === "critical");''',
    '''  const rawRecommendation = str(review.payload.publishRecommendation) || "review";
  const criticalConflict = conflicts.some((item) => item.severity === "critical");
  const recommendation = rawRecommendation === "reject" && !criticalConflict ? "review" : rawRecommendation;
  const readinessScore = scoreReadiness(specialists, sections.map, conflicts, officialSource, recommendation);''',
)
patch(
    "src/nomologies-v2/pipeline.ts",
    '''    reviewer: review.payload,''',
    '''    reviewer: {
      ...review.payload,
      effectivePublishRecommendation: recommendation,
      rawPublishRecommendation: rawRecommendation,
    },''',
)

patch(
    "web/app.js",
    '''  for (const [key, node] of Object.entries({
    empty: elements.emptyState,
    processing: elements.processingState,
    error: elements.errorState,
    results: elements.resultsState,
  })) {
    node.hidden = key !== name;
  }''',
    '''  for (const [key, node] of Object.entries({
    empty: elements.emptyState,
    processing: elements.processingState,
    error: elements.errorState,
    results: elements.resultsState,
  })) {
    const visible = key === name;
    node.hidden = !visible;
    node.style.display = visible ? "" : "none";
    node.setAttribute("aria-hidden", visible ? "false" : "true");
  }
  if (name === "results") {
    elements.errorTitle.textContent = "";
    elements.errorMessage.textContent = "";
  }''',
)
patch(
    "web/app.js",
    '''    fieldList("Cited authorities", authorities.authorities, (item) => `<article class="list-card"><b>${h(item.name || "Authority")}</b><p>${h(item.legalPoint || "")}</p><small>${h(item.citation || "")} · ${h(item.treatment || "unknown")}</small></article>`),''',
    '''    fieldList("Cited authorities", authorities.authorities, (item) => `<article class="list-card"><b>${h(item.name || "Authority")}</b><p>${h(item.legalPoint || "")}</p><small>${h(item.citation || "")} · ${h(item.treatment || "unknown")} · ${h(item.citationContext || "unknown context")}</small></article>`),''',
)
patch(
    "web/styles.css",
    '* { box-sizing: border-box; }',
    '* { box-sizing: border-box; }\n[hidden] { display: none !important; }',
)

server = (ROOT / "server.ts").read_text(encoding="utf-8")
server = server.replace('version: "2.1.0-async-jobs"', 'version: "2.2.0-legal-quality"')
(ROOT / "server.ts").write_text(server, encoding="utf-8")

print("Patched Nomologies runtime, scoring and Pipeline Lab state handling.")
