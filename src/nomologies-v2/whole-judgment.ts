import {
  combineSpecialistAgentResults,
  type SpecialistAgentKindV2,
  type SpecialistAgentRunV2,
  type SpecialistResultsV2,
} from "./agents.ts";
import type { DeterministicFindingV2 } from "./deterministic-baseline.ts";
import { createStructuredResponse } from "./openai-responses.ts";
import { WHOLE_JUDGMENT_SYSTEM_PROMPT } from "./prompts.ts";
import { NOMOLOGIES_SCHEMAS } from "./schemas.ts";
import type {
  JudgmentSourceV2,
  PipelineStageAuditV2,
  SectionMapV2,
} from "./types.ts";

type JsonRecord = Record<string, unknown>;

function object(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function fieldLike(value: unknown): value is JsonRecord {
  const item = object(value);
  return Object.hasOwn(item, "status") && Object.hasOwn(item, "value") && Object.hasOwn(item, "evidence");
}

function normalized(value: unknown): string {
  return String(value || "").toLocaleLowerCase("el").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ς/g, "σ").replace(/\s+/g, " ").trim();
}

function phraseTokens(value: unknown): Set<string> {
  return new Set(normalized(value)
    .replace(/[^a-zα-ω0-9]+/gu, " ")
    .split(" ")
    .filter((token) => token.length >= 3));
}

function substantiallySame(left: unknown, right: unknown): boolean {
  const a = normalized(left);
  const b = normalized(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  if (shorter.length >= 28 && longer.includes(shorter) && shorter.length / longer.length >= 0.72) return true;
  const aa = phraseTokens(a);
  const bb = phraseTokens(b);
  if (!aa.size || !bb.size) return false;
  let intersection = 0;
  for (const token of aa) if (bb.has(token)) intersection += 1;
  const union = new Set([...aa, ...bb]).size;
  const containment = intersection / Math.min(aa.size, bb.size);
  const jaccard = intersection / union;
  return jaccard >= 0.82 || (containment >= 0.82 && jaccard >= 0.55);
}

function stripLeadingIssueFromPrinciple(raw: JsonRecord): void {
  const analysis = object(raw.analysis);
  const issueField = object(analysis.dominantIssue);
  const principleField = object(analysis.legalPrincipleSummary);
  if (issueField.status !== "available" || principleField.status !== "available") return;

  const issue = String(issueField.value || "").trim();
  const principle = String(principleField.value || "").trim();
  if (!issue || !principle || principle === issue) return;

  let remainder = "";
  if (principle.startsWith(issue)) {
    remainder = principle.slice(issue.length).replace(/^[\s.;:—–-]+/u, "").trim();
  } else {
    const paragraphs = principle.split(/\n{2,}/u).map((part) => part.trim()).filter(Boolean);
    if (paragraphs.length > 1 && substantiallySame(paragraphs[0], issue)) {
      remainder = paragraphs.slice(1).join("\n\n");
    }
  }

  if (remainder.length >= 30) principleField.value = remainder;
}

function canonicalAuthorityName(value: unknown): string {
  return normalized(value)
    .replace(/\s+(?:\[|\()(?:18|19|20)\d{2}[\s\S]*$/u, "")
    .replace(/\b(?:ν|vs?|versus)\b/gu, " v ")
    .replace(/\b(?:the|and|another|others?)\b/gu, " ")
    .replace(/\b(?:ltd|limited|plc|llp|incorporated|inc|company|co)\b/gu, " ")
    .replace(/\b(?:appellants?|respondents?|claimants?|defendants?)\b/gu, " ")
    .replace(/[^a-zα-ω0-9]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactCitation(value: unknown): string {
  return normalized(value).replace(/[^a-zα-ω0-9]+/gu, "");
}

function editDistance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const prior = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = prior;
    }
  }
  return row[right.length];
}

function sameAuthority(left: JsonRecord, right: JsonRecord): boolean {
  const leftEcli = compactCitation(left.ecli);
  const rightEcli = compactCitation(right.ecli);
  if (leftEcli && rightEcli && leftEcli === rightEcli) return true;
  const a = canonicalAuthorityName(left.name);
  const b = canonicalAuthorityName(right.name);
  if (!a || !b) return false;
  if (a === b) return true;
  const aa = a.split(" ");
  const bb = b.split(" ");
  if (aa.length !== bb.length || aa.length < 2) return false;
  return aa.reduce((sum, token, index) => sum + editDistance(token, bb[index]), 0) <= 2;
}

function secondaryLiterature(value: JsonRecord): boolean {
  const combined = `${value.name || ""} ${value.citation || ""}`;
  return /(?:\b(?:on|the)\s+law\b|textbook|treatise|commentary|edition|έκδοση|παρ(?:άγρ)?\.|paragraph|σελ\.|page|pp\.|Tugendhat|Christie|Gatley)/iu.test(combined);
}

function mergeAuthority(left: JsonRecord, right: JsonRecord): JsonRecord {
  const citation = [...new Set([String(left.citation || "").trim(), String(right.citation || "").trim()].filter(Boolean))].join("; ");
  const legalPoint = [...new Set([String(left.legalPoint || "").trim(), String(right.legalPoint || "").trim()].filter(Boolean))].join(" ");
  const treatmentRank = ["unknown", "mentioned", "cited", "considered", "adopted", "followed", "applied", "approved"];
  const treatment = treatmentRank.indexOf(String(right.treatment)) > treatmentRank.indexOf(String(left.treatment))
    ? right.treatment : left.treatment;
  const contextRank = ["unknown", "nested_quotation", "adopted_quotation", "direct"];
  const citationContext = contextRank.indexOf(String(right.citationContext)) > contextRank.indexOf(String(left.citationContext))
    ? right.citationContext : left.citationContext;
  return {
    ...left,
    ...right,
    name: String(left.name || right.name || ""),
    citation,
    legalPoint,
    treatment,
    citationContext,
    sourceType: secondaryLiterature(left) || secondaryLiterature(right)
      ? "secondary_literature"
      : String(right.sourceType || left.sourceType || "decision"),
    quoted: Boolean(left.quoted || right.quoted),
  };
}

function dedupeAuthorities(raw: JsonRecord): void {
  const group = object(raw.authorities);
  const field = object(group.authorities);
  if (field.status !== "available" || !Array.isArray(field.value)) return;
  const output: JsonRecord[] = [];
  for (const value of field.value) {
    const item = object(value);
    item.sourceType = secondaryLiterature(item) ? "secondary_literature" : (item.sourceType || "decision");
    const found = output.findIndex((current) => sameAuthority(current, item));
    if (found < 0) output.push(item);
    else output[found] = mergeAuthority(output[found], item);
  }
  field.value = output;
}

function richer(left: unknown, right: unknown, path: string): unknown {
  const leftSize = JSON.stringify(left).length;
  const rightSize = JSON.stringify(right).length;
  return leftSize >= rightSize
    ? mergePlain(left, right, path)
    : mergePlain(right, left, path);
}

function dedupeFieldValues(
  raw: JsonRecord,
  groupName: string,
  fieldName: string,
  label: (item: unknown) => string,
  exactOnly = false,
): void {
  const group = object(raw[groupName]);
  const field = object(group[fieldName]);
  if (field.status !== "available" || !Array.isArray(field.value)) return;
  const output: unknown[] = [];
  for (const item of field.value) {
    const candidate = label(item);
    if (!candidate) continue;
    const found = output.findIndex((current) => {
      const existing = label(current);
      return exactOnly ? normalized(existing) === normalized(candidate) : substantiallySame(existing, candidate);
    });
    if (found < 0) output.push(item);
    else output[found] = richer(output[found], item, `${groupName}.${fieldName}.value[]`);
  }
  field.value = output;
}

export function canonicalizeLawyerRecord(raw: JsonRecord): JsonRecord {
  stripLeadingIssueFromPrinciple(raw);
  dedupeFieldValues(raw, "identity", "judges", (item) => normalized(object(item).name || item), true);
  dedupeFieldValues(raw, "facts", "materialFacts", (item) => normalized(object(item).fact));
  dedupeFieldValues(raw, "facts", "chronology", (item) => {
    const row = object(item);
    return normalized(`${row.date || ""}|${row.event || ""}`);
  });
  dedupeFieldValues(raw, "facts", "witnessesAndEvidence", (item) => {
    const row = object(item);
    return normalized(`${row.name || ""}|${row.type || ""}`);
  });
  dedupeFieldValues(raw, "analysis", "legalIssues", (item) => normalized(object(item).issue));
  dedupeFieldValues(raw, "analysis", "findings", (item) => normalized(object(item).finding));
  dedupeFieldValues(raw, "analysis", "ratioDecidendi", (item) => normalized(object(item).principle));
  dedupeFieldValues(raw, "analysis", "secondaryPrinciples", (item) => normalized(object(item).principle));
  dedupeAuthorities(raw);
  return raw;
}

function itemKey(value: unknown, path: string): string {
  const item = object(value);
  if (path.includes("legislation")) return normalized(item.lawId || item.lawLabel || item.instrumentName);
  if (path.endsWith("authorities.value")) return canonicalAuthorityName(item.name || item.ecli || item.citation);
  if (path.includes("groundsOrIssues")) return normalized(item.number || item.title || item.description);
  if (path.includes("components")) return normalized(item.groundOrIssue || item.target || item.orderText);
  if (path.includes("ratioDecidendi") || path.includes("secondaryPrinciples")) return normalized(item.principle);
  if (path.includes("legalIssues")) return normalized(item.issue);
  if (path.includes("chronology")) return normalized(`${item.date}|${item.event}`);
  if (path.includes("costs") || path.includes("monetaryAwards")) return normalized(`${item.type}|${item.amount}|${item.currency}|${item.payer}|${item.payee}`);
  return normalized(JSON.stringify(value));
}

function mergePlain(existing: unknown, incoming: unknown, path: string): unknown {
  if (Array.isArray(existing) || Array.isArray(incoming)) {
    const output = new Map<string, unknown>();
    for (const item of [...array(existing), ...array(incoming)]) {
      const key = itemKey(item, path);
      if (!key) continue;
      const current = output.get(key);
      output.set(key, current && object(current) && object(item)
        ? path.endsWith("authorities.value")
          ? mergeAuthority(object(current), object(item))
          : mergePlain(current, item, `${path}[]`)
        : item);
    }
    return [...output.values()];
  }
  const left = object(existing);
  const right = object(incoming);
  if (Object.keys(left).length || Object.keys(right).length) {
    const result: JsonRecord = { ...left };
    for (const [key, value] of Object.entries(right)) {
      const current = result[key];
      if (Array.isArray(current) || Array.isArray(value) || (Object.keys(object(current)).length && Object.keys(object(value)).length)) {
        result[key] = mergePlain(current, value, `${path}.${key}`);
      } else if (current === "" || current === null || current === undefined) result[key] = value;
    }
    return result;
  }
  return existing === "" || existing === null || existing === undefined ? incoming : existing;
}

function evidenceKey(value: unknown): string {
  const item = object(value);
  return `${array(item.paragraphIds).join(",")}|${normalized(item.quote)}`;
}

function mergeField(existing: JsonRecord, incoming: JsonRecord, path: string): JsonRecord {
  const leftAvailable = existing.status === "available" && (Array.isArray(existing.value) ? existing.value.length > 0 : String(existing.value ?? "").trim().length > 0);
  const rightAvailable = incoming.status === "available" && (Array.isArray(incoming.value) ? incoming.value.length > 0 : String(incoming.value ?? "").trim().length > 0);
  if (!leftAvailable) return rightAvailable ? incoming : existing;
  if (!rightAvailable) return existing;

  let value: unknown = existing.value;
  if (Array.isArray(existing.value) || Array.isArray(incoming.value)) value = mergePlain(existing.value, incoming.value, `${path}.value`);
  else if (typeof existing.value === "string" && typeof incoming.value === "string") {
    const preferWhole = new Set([
      "analysis.holding",
      "analysis.legalPrincipleSummary",
      "procedure.proceduralHistory",
      "procedure.lowerCourtDecision",
      "outcome.dispositionText",
    ]).has(path);
    const incomingLimit = path === "analysis.legalPrincipleSummary" ? 1_050 : 8_000;
    if (preferWhole && incoming.value.trim().length <= incomingLimit) value = incoming.value;
    else if (incoming.value.length > existing.value.length * 1.35 && incoming.value.length <= incomingLimit) value = incoming.value;
  }

  const evidence = new Map<string, unknown>();
  for (const item of [...array(existing.evidence), ...array(incoming.evidence)]) {
    const key = evidenceKey(item);
    if (key) evidence.set(key, item);
  }
  return {
    status: "available",
    value,
    confidence: Math.max(Number(existing.confidence) || 0, Number(incoming.confidence) || 0),
    evidence: [...evidence.values()],
    conflicts: [...new Set([...array(existing.conflicts).map(String), ...array(incoming.conflicts).map(String)])],
  };
}

function mergeRaw(existing: unknown, incoming: unknown, path = ""): unknown {
  if (fieldLike(existing) || fieldLike(incoming)) return mergeField(object(existing), object(incoming), path);
  if (Array.isArray(existing) || Array.isArray(incoming)) return mergePlain(existing, incoming, path);
  const left = object(existing);
  const right = object(incoming);
  const output: JsonRecord = { ...left };
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    output[key] = mergeRaw(left[key], right[key], path ? `${path}.${key}` : key);
  }
  return output;
}

function compactCandidate(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactCandidate);
  const item = object(value);
  if (!Object.keys(item).length) return value;
  const output: JsonRecord = {};
  for (const [key, nested] of Object.entries(item)) {
    if (key === "evidence" || key === "conflicts" || key === "raw" || key === "audits") continue;
    output[key] = compactCandidate(nested);
  }
  return output;
}

function runsFromRaw(raw: JsonRecord, audit: PipelineStageAuditV2): SpecialistAgentRunV2[] {
  const entries: Array<[SpecialistAgentKindV2, JsonRecord]> = [
    ["identity", { identity: object(raw.identity), classification: object(raw.classification) }],
    ["facts", { facts: object(raw.facts) }],
    ["procedure", { procedure: object(raw.procedure) }],
    ["analysis", { analysis: object(raw.analysis) }],
    ["authorities", { authorities: object(raw.authorities) }],
    ["outcome", { outcome: object(raw.outcome) }],
  ];
  return entries.map(([kind, data]) => ({ kind, raw: data, audit }));
}

function specialistRaw(value: SpecialistResultsV2): JsonRecord {
  return {
    identity: object(value.raw.identity).identity,
    classification: object(value.raw.identity).classification,
    facts: object(value.raw.factsProcedure).facts,
    procedure: object(value.raw.factsProcedure).procedure,
    analysis: object(value.raw.analysis).analysis,
    authorities: object(value.raw.authorities).authorities,
    outcome: object(value.raw.outcome).outcome,
  };
}

export async function runWholeJudgmentSynthesis(
  source: JudgmentSourceV2,
  sectionMap: SectionMapV2,
  current: SpecialistResultsV2,
  deterministicFindings: DeterministicFindingV2[],
  options: { model?: string; signal?: AbortSignal } = {},
): Promise<SpecialistResultsV2> {
  const user = JSON.stringify({
    contract: "nomologies.whole-judgment.original-headnote-v2",
    source: {
      sourceTitle: source.sourceTitle,
      sourceUrl: source.sourceUrl,
      sourceHash: source.sourceHash,
      paragraphs: source.paragraphs.map((paragraph) => ({ id: paragraph.id, ordinal: paragraph.ordinal, text: paragraph.text })),
    },
    sectionMap: {
      version: sectionMap.version,
      reviewFlags: sectionMap.reviewFlags,
      spans: sectionMap.spans,
    },
    deterministicFindings,
    specialistCandidate: compactCandidate(current),
  });
  const startedAt = new Date().toISOString();
  const response = await createStructuredResponse({
    stage: "whole-judgment-synthesis",
    schemaName: NOMOLOGIES_SCHEMAS.wholeJudgment.name,
    schema: NOMOLOGIES_SCHEMAS.wholeJudgment.schema,
    system: WHOLE_JUDGMENT_SYSTEM_PROMPT,
    user,
    effort: "low",
    model: options.model,
    timeoutMs: 125_000,
    signal: options.signal,
  });
  const audit: PipelineStageAuditV2 = {
    stage: "whole-judgment-synthesis",
    status: "completed",
    model: response.model,
    responseId: response.responseId,
    startedAt,
    completedAt: new Date().toISOString(),
    elapsedMs: response.elapsedMs,
    inputCharacters: user.length,
    outputCharacters: JSON.stringify(response.data).length,
    errorCode: "",
  };

  const mergedRaw = canonicalizeLawyerRecord(object(mergeRaw(specialistRaw(current), response.data)));
  const merged = combineSpecialistAgentResults(source, sectionMap, runsFromRaw(mergedRaw, audit));
  merged.audits = [...current.audits, audit];
  return merged;
}
