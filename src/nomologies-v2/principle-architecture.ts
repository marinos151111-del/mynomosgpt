import { normalizeLegalText, tokenizeLegalText } from "../nomologies-search/normalize.ts";
import { detectConcepts } from "../nomologies-search/synonyms.ts";
import type {
  CaseAnalysisV2,
  EvidenceAnchorV2,
  ExtractedFieldV2,
  LegalPrincipleV2,
  PrincipleArchitectureV2,
  PrincipleEdgeV2,
  PrincipleLayerV2,
  PrincipleNodeV2,
} from "./types.ts";

export const PRINCIPLE_ARCHITECTURE_VERSION = "principle-architecture-v1.0.0" as const;

type Centrality = PrincipleNodeV2["centrality"];
type PrincipleType = PrincipleNodeV2["principleType"];

type NodeInput = {
  layer: PrincipleLayerV2;
  text: string;
  principleType: PrincipleType;
  centrality: Centrality;
  evidence: EvidenceAnchorV2[];
  sourceField: string;
  confidence: number;
  conditions?: string[];
  exceptions?: string[];
  applicationToFacts?: string;
};

function available<T>(field: ExtractedFieldV2<T>): boolean {
  if (field.status !== "available" || !field.evidence?.length) return false;
  if (typeof field.value === "string") return field.value.trim().length > 0;
  if (Array.isArray(field.value)) return field.value.length > 0;
  return field.value !== null && field.value !== undefined;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.map((value) => String(value || "").trim()).filter((value) => {
    const key = normalizeLegalText(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function evidenceParagraphIds(evidence: EvidenceAnchorV2[]): string[] {
  return [...new Set(evidence.flatMap((anchor) => anchor.paragraphIds || []).filter((id) => id && id !== "TITLE"))];
}

function stableId(layer: PrincipleLayerV2, value: string): string {
  const input = `${layer}|${normalizeLegalText(value)}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `pn_${layer}_${(hash >>> 0).toString(36)}`;
}

function questionLike(value: string): boolean {
  const cleaned = value.trim().replace(/^[\s"“”'‘’]+/u, "");
  return /^(?:κατά\s+πόσον|εάν|αν|κατά\s+ποιο|ποιο|ποια|πότε|whether|if|when|does|did|can|could|is|are)\b/iu.test(cleaned) || /\?\s*$/u.test(cleaned);
}

function bareOutcome(value: string): boolean {
  const normalized = normalizeLegalText(value);
  if (!normalized) return true;
  const tokens = tokenizeLegalText(value, { keepStopwords: false, stem: false });
  return tokens.length <= 14 && /(?:εφεσ|αιτησ|λογ(?:οσ|οι)\s+εφεσ|appeal|application|ground).*(?:απορρι|επιτρεπ|επιτυγχ|dismiss|allow|succeed|fail)/iu.test(normalized);
}

function substantiallySame(left: string, right: string): boolean {
  const a = new Set(tokenizeLegalText(left, { keepStopwords: false, stem: true }).filter((token) => token.length >= 3));
  const b = new Set(tokenizeLegalText(right, { keepStopwords: false, stem: true }).filter((token) => token.length >= 3));
  if (!a.size || !b.size) return false;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const containment = intersection / Math.min(a.size, b.size);
  const jaccard = intersection / new Set([...a, ...b]).size;
  return containment >= 0.88 && jaccard >= 0.64;
}

function strongerCentrality(left: Centrality, right: Centrality): Centrality {
  const rank: Record<Centrality, number> = { primary: 3, secondary: 2, ancillary: 1 };
  return rank[right] > rank[left] ? right : left;
}

function edgeKey(edge: PrincipleEdgeV2): string {
  return `${edge.fromNodeId}|${edge.relation}|${edge.toNodeId}`;
}

function layerForPrinciple(principle: LegalPrincipleV2): PrincipleLayerV2 {
  if (principle.type === "test" || principle.type === "standard") return "test";
  if (principle.type === "holding") return "holding";
  return "rule";
}

/**
 * Builds a read-only reasoning graph from evidence-grounded canonical fields.
 * No value is generated from free text outside those fields and no canonical
 * field is mutated or replaced.
 */
export function buildPrincipleArchitecture(analysis: CaseAnalysisV2): PrincipleArchitectureV2 {
  const nodes: PrincipleNodeV2[] = [];
  const edges: PrincipleEdgeV2[] = [];
  const warnings = new Set<string>();

  const addNode = (input: NodeInput): string => {
    const nodeText = input.text.trim();
    const paragraphs = evidenceParagraphIds(input.evidence);
    if (!nodeText || !paragraphs.length) return "";

    let layer = input.layer;
    let principleType = input.principleType;
    if (["rule", "test"].includes(layer) && questionLike(nodeText)) {
      warnings.add("QUESTION_EXCLUDED_FROM_RULE_LAYER");
      layer = "issue";
      principleType = "issue";
    }
    if (["rule", "test"].includes(layer) && bareOutcome(nodeText)) {
      warnings.add("OUTCOME_EXCLUDED_FROM_RULE_LAYER");
      return "";
    }

    const existing = nodes.find((node) => node.layer === layer && substantiallySame(node.text, nodeText));
    if (existing) {
      existing.centrality = strongerCentrality(existing.centrality, input.centrality);
      existing.conceptIds = unique([...existing.conceptIds, ...detectConcepts(nodeText).map((concept) => concept.id)]);
      existing.evidenceParagraphIds = [...new Set([...existing.evidenceParagraphIds, ...paragraphs])];
      existing.confidence = Math.max(existing.confidence, Math.max(0, Math.min(1, input.confidence || 0)));
      existing.conditions = unique([...existing.conditions, ...(input.conditions || [])]);
      existing.exceptions = unique([...existing.exceptions, ...(input.exceptions || [])]);
      if ((input.applicationToFacts || "").length > existing.applicationToFacts.length) existing.applicationToFacts = input.applicationToFacts || "";
      return existing.id;
    }

    const node: PrincipleNodeV2 = {
      id: stableId(layer, nodeText),
      layer,
      text: nodeText,
      principleType,
      centrality: input.centrality,
      conceptIds: unique(detectConcepts(nodeText).map((concept) => concept.id)),
      evidenceParagraphIds: paragraphs,
      sourceField: input.sourceField,
      confidence: Math.max(0, Math.min(1, input.confidence || 0)),
      conditions: unique(input.conditions || []),
      exceptions: unique(input.exceptions || []),
      applicationToFacts: (input.applicationToFacts || "").trim(),
    };
    nodes.push(node);
    return node.id;
  };

  const connect = (fromNodeId: string, toNodeId: string, relation: PrincipleEdgeV2["relation"]): void => {
    if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) return;
    const edge = { fromNodeId, toNodeId, relation };
    if (!edges.some((existing) => edgeKey(existing) === edgeKey(edge))) edges.push(edge);
  };

  let dominantIssueId = "";
  if (available(analysis.dominantIssue)) {
    dominantIssueId = addNode({
      layer: "issue", text: analysis.dominantIssue.value, principleType: "issue", centrality: "primary",
      evidence: analysis.dominantIssue.evidence, sourceField: "analysis.dominantIssue", confidence: analysis.dominantIssue.confidence,
    });
  }
  if (available(analysis.legalIssues)) {
    for (const issue of analysis.legalIssues.value) {
      const issueId = addNode({
        layer: "issue", text: issue.issue, principleType: "issue", centrality: issue.centrality,
        evidence: analysis.legalIssues.evidence, sourceField: "analysis.legalIssues", confidence: analysis.legalIssues.confidence,
      });
      if (!dominantIssueId && issue.centrality === "primary") dominantIssueId = issueId;
    }
  }

  const primaryRuleIds: string[] = [];
  if (available(analysis.legalPrincipleSummary)) {
    const id = addNode({
      layer: "rule", text: analysis.legalPrincipleSummary.value, principleType: "ratio", centrality: "primary",
      evidence: analysis.legalPrincipleSummary.evidence, sourceField: "analysis.legalPrincipleSummary", confidence: analysis.legalPrincipleSummary.confidence,
    });
    if (id && nodes.find((node) => node.id === id)?.layer === "rule") primaryRuleIds.push(id);
  }

  const addStructuredPrinciples = (field: ExtractedFieldV2<LegalPrincipleV2[]>, sourceField: string, centrality: Centrality): void => {
    if (!available(field)) return;
    for (const principle of field.value) {
      const layer = layerForPrinciple(principle);
      const parentId = addNode({
        layer, text: principle.principle, principleType: principle.type, centrality,
        evidence: field.evidence, sourceField, confidence: field.confidence,
        conditions: principle.conditions, exceptions: principle.exceptions, applicationToFacts: principle.applicationToFacts,
      });
      if (parentId && centrality === "primary" && nodes.find((node) => node.id === parentId)?.layer === "rule") primaryRuleIds.push(parentId);

      for (const condition of principle.conditions || []) {
        const conditionId = addNode({
          layer: "condition", text: condition, principleType: principle.type, centrality,
          evidence: field.evidence, sourceField: `${sourceField}.conditions`, confidence: field.confidence,
        });
        connect(parentId, conditionId, "qualified_by");
      }
      for (const exception of principle.exceptions || []) {
        const exceptionId = addNode({
          layer: "exception", text: exception, principleType: principle.type, centrality,
          evidence: field.evidence, sourceField: `${sourceField}.exceptions`, confidence: field.confidence,
        });
        connect(parentId, exceptionId, "limited_by");
      }
      if (principle.applicationToFacts) {
        const applicationId = addNode({
          layer: "application", text: principle.applicationToFacts, principleType: "application", centrality,
          evidence: field.evidence, sourceField: `${sourceField}.applicationToFacts`, confidence: field.confidence,
        });
        connect(parentId, applicationId, "applied_in");
      }
    }
  };

  addStructuredPrinciples(analysis.ratioDecidendi, "analysis.ratioDecidendi", "primary");
  addStructuredPrinciples(analysis.secondaryPrinciples, "analysis.secondaryPrinciples", "secondary");

  const testIds: string[] = [];
  if (available(analysis.legalTestsAndStandards)) {
    for (const test of analysis.legalTestsAndStandards.value) {
      const id = addNode({
        layer: "test", text: test, principleType: "test", centrality: "primary",
        evidence: analysis.legalTestsAndStandards.evidence, sourceField: "analysis.legalTestsAndStandards", confidence: analysis.legalTestsAndStandards.confidence,
      });
      if (id && nodes.find((node) => node.id === id)?.layer === "test") testIds.push(id);
    }
  }

  let holdingId = "";
  if (available(analysis.holding)) {
    holdingId = addNode({
      layer: "holding", text: analysis.holding.value, principleType: "holding", centrality: "primary",
      evidence: analysis.holding.evidence, sourceField: "analysis.holding", confidence: analysis.holding.confidence,
    });
  }

  const obiterIds: string[] = [];
  if (available(analysis.obiterDicta)) {
    for (const obiter of analysis.obiterDicta.value) {
      const id = addNode({
        layer: "obiter", text: obiter, principleType: "obiter", centrality: "ancillary",
        evidence: analysis.obiterDicta.evidence, sourceField: "analysis.obiterDicta", confidence: analysis.obiterDicta.confidence,
      });
      if (id) obiterIds.push(id);
    }
  }

  const dominantRuleId = unique(primaryRuleIds)[0] || nodes.find((node) => node.layer === "rule")?.id || "";
  const ruleIds = nodes.filter((node) => node.layer === "rule").map((node) => node.id);
  const applicationIds = nodes.filter((node) => node.layer === "application").map((node) => node.id);
  for (const ruleId of ruleIds) {
    connect(dominantIssueId, ruleId, "frames");
    for (const testId of testIds) connect(ruleId, testId, "operationalised_by");
    if (!applicationIds.length) connect(ruleId, holdingId, "governs");
  }
  for (const applicationId of applicationIds) connect(applicationId, holdingId, "supports");
  connect(dominantIssueId, holdingId, "resolved_by");
  for (const obiterId of obiterIds) connect(dominantIssueId, obiterId, "contextualised_by");

  if (!nodes.some((node) => node.layer === "issue")) warnings.add("NO_EVIDENCED_ISSUE_NODE");
  if (!nodes.some((node) => node.layer === "rule")) warnings.add("NO_EVIDENCED_RULE_NODE");
  if (!nodes.some((node) => node.layer === "holding")) warnings.add("NO_EVIDENCED_HOLDING_NODE");

  const evidenced = nodes.filter((node) => node.evidenceParagraphIds.length > 0).length;
  const completenessScore = Math.min(100,
    (nodes.some((node) => node.layer === "issue") ? 15 : 0) +
    (nodes.some((node) => node.layer === "rule") ? 30 : 0) +
    (nodes.some((node) => node.layer === "test") ? 10 : 0) +
    (nodes.some((node) => node.layer === "application") ? 15 : 0) +
    (nodes.some((node) => node.layer === "holding") ? 20 : 0) +
    (nodes.length ? Math.round((evidenced / nodes.length) * 10) : 0),
  );

  return {
    version: PRINCIPLE_ARCHITECTURE_VERSION,
    nodes,
    edges,
    dominantIssueId,
    dominantRuleId,
    conceptIds: unique(nodes.flatMap((node) => node.conceptIds)),
    completenessScore,
    warnings: [...warnings],
  };
}
