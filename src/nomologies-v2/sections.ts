import { createStructuredResponse } from "./openai-responses.ts";
import { SECTION_SYSTEM_PROMPT } from "./prompts.ts";
import { NOMOLOGIES_SCHEMAS } from "./schemas.ts";
import {
  NOMOLOGIES_V2_VERSION,
  SECTION_TYPES,
  SPEAKER_ROLES,
  type JudgmentParagraphV2,
  type JudgmentSourceV2,
  type SectionMapV2,
  type SectionSpanV2,
  type SectionType,
  type SpeakerRole,
} from "./types.ts";

type JsonRecord = Record<string, unknown>;

type Window = {
  index: number;
  paragraphs: JudgmentParagraphV2[];
  firstOrdinal: number;
  lastOrdinal: number;
};

type CandidateSpan = SectionSpanV2 & {
  windowIndex: number;
  startOrdinal: number;
  endOrdinal: number;
};

const WINDOW_TARGET_CHARS = 105_000;
const WINDOW_OVERLAP_TARGET_CHARS = 18_000;
const MAX_WINDOW_OVERLAP_PARAGRAPHS = 14;
const MIN_WINDOW_ADVANCE_PARAGRAPHS = 4;
const MAX_SECTION_WINDOWS = 64;
const MAX_CONCURRENCY = 3;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function clamp01(value: unknown, fallback = 0.5): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.min(1, number));
}

function enumValue<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: T[number],
): T[number] {
  const candidate = str(value);
  return (allowed as readonly string[]).includes(candidate)
    ? candidate as T[number]
    : fallback;
}

function buildWindows(paragraphs: JudgmentParagraphV2[]): Window[] {
  const windows: Window[] = [];
  let start = 0;

  while (start < paragraphs.length && windows.length < MAX_SECTION_WINDOWS) {
    let end = start;
    let characters = 0;
    while (end < paragraphs.length) {
      const addition = paragraphs[end].text.length + 120;
      if (end > start && characters + addition > WINDOW_TARGET_CHARS) break;
      characters += addition;
      end += 1;
    }
    if (end <= start) end = Math.min(paragraphs.length, start + 1);
    const slice = paragraphs.slice(start, end);
    windows.push({
      index: windows.length,
      paragraphs: slice,
      firstOrdinal: slice[0].ordinal,
      lastOrdinal: slice[slice.length - 1].ordinal,
    });
    if (end >= paragraphs.length) {
    start = paragraphs.length;
    break;
  }
    let overlapStart = end;
    let overlapCharacters = 0;
    let overlapParagraphs = 0;
    while (
      overlapStart > start &&
      overlapParagraphs < MAX_WINDOW_OVERLAP_PARAGRAPHS &&
      overlapCharacters < WINDOW_OVERLAP_TARGET_CHARS
    ) {
      overlapStart -= 1;
      overlapCharacters += paragraphs[overlapStart].text.length + 120;
      overlapParagraphs += 1;
    }

    // A fixed 14-paragraph overlap could consume almost an entire window
    // when CyLaw paragraphs are long, advancing only one paragraph per API
    // call. Preserve useful context while guaranteeing material progress.
    const minimumNext = Math.min(end, start + MIN_WINDOW_ADVANCE_PARAGRAPHS);
    const next = Math.max(minimumNext, overlapStart);
    if (next <= start) throw new Error("SECTION_WINDOW_PROGRESS_STALLED");
    start = next;
  }

  if (start < paragraphs.length) {
    throw new Error("SECTION_WINDOW_LIMIT_EXCEEDED");
  }
  return windows;
}

function paragraphPayload(paragraph: JudgmentParagraphV2): JsonRecord {
  return {
    id: paragraph.id,
    ordinal: paragraph.ordinal,
    relativePosition: paragraph.relativePosition,
    text: paragraph.text,
    formatting: {
      uppercaseRatio: paragraph.formatting.uppercaseRatio,
      headingCandidate: paragraph.formatting.headingCandidate,
      listCandidate: paragraph.formatting.listCandidate,
      paragraphNumber: paragraph.formatting.paragraphNumber,
    },
  };
}

function sectionUserPayload(source: JudgmentSourceV2, window: Window, totalWindows: number): string {
  return JSON.stringify({
    contract: "nomologies.sections.v2",
    source: {
      sourceTitle: source.sourceTitle,
      sourceUrl: source.sourceUrl,
      sourceDatabase: source.sourceDatabase,
      languageHint: source.languageHint,
      paragraphCount: source.paragraphs.length,
    },
    window: {
      index: window.index + 1,
      total: totalWindows,
      firstOrdinal: window.firstOrdinal,
      lastOrdinal: window.lastOrdinal,
      overlapNotice: totalWindows > 1
        ? "This window overlaps adjacent windows. Classify only supplied global paragraph IDs."
        : "Complete judgment supplied in one window.",
    },
    paragraphs: window.paragraphs.map(paragraphPayload),
  });
}

function normalizeWindowSpans(
  payload: JsonRecord,
  window: Window,
  paragraphOrdinal: Map<string, number>,
  reviewFlags: Set<string>,
): CandidateSpan[] {
  const allowedIds = new Set(window.paragraphs.map((paragraph) => paragraph.id));
  const candidates: CandidateSpan[] = [];

  for (const [index, raw] of asArray(payload.spans).entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as JsonRecord;
    const startId = str(row.startParagraphId);
    const endId = str(row.endParagraphId);
    if (!allowedIds.has(startId) || !allowedIds.has(endId)) {
      reviewFlags.add(`section_window_${window.index + 1}_invalid_range_${index + 1}`);
      continue;
    }
    let startOrdinal = paragraphOrdinal.get(startId) || 0;
    let endOrdinal = paragraphOrdinal.get(endId) || 0;
    if (!startOrdinal || !endOrdinal) continue;
    if (endOrdinal < startOrdinal) {
      [startOrdinal, endOrdinal] = [endOrdinal, startOrdinal];
      reviewFlags.add(`section_window_${window.index + 1}_reversed_range_${index + 1}`);
    }

    const boundaryIds = asArray(row.boundaryEvidenceParagraphIds)
      .map(str)
      .filter((id) => allowedIds.has(id))
      .slice(0, 12);

    candidates.push({
      id: str(row.id) || `W${window.index + 1}S${index + 1}`,
      startParagraphId: startId,
      endParagraphId: endId,
      sectionType: enumValue(row.sectionType, SECTION_TYPES, "other") as SectionType,
      speakerRole: enumValue(row.speakerRole, SPEAKER_ROLES, "unknown") as SpeakerRole,
      heading: str(row.heading).slice(0, 500),
      isQuotedMaterial: row.isQuotedMaterial === true,
      quotedSourceType: enumValue(
        row.quotedSourceType,
        ["legislation", "case", "academic", "other", "none"] as const,
        "none",
      ),
      confidence: clamp01(row.confidence),
      boundaryEvidenceParagraphIds: boundaryIds,
      rationale: str(row.rationale).slice(0, 1_200),
      windowIndex: window.index,
      startOrdinal,
      endOrdinal,
    });
  }

  return candidates;
}

function candidateKey(candidate: CandidateSpan): string {
  return [
    candidate.sectionType,
    candidate.speakerRole,
    candidate.isQuotedMaterial ? "quoted" : "direct",
    candidate.quotedSourceType,
  ].join("|");
}

function reconcileCandidates(
  source: JudgmentSourceV2,
  candidates: CandidateSpan[],
  reviewFlags: Set<string>,
): SectionSpanV2[] {
  type Vote = {
    key: string;
    sectionType: SectionType;
    speakerRole: SpeakerRole;
    isQuotedMaterial: boolean;
    quotedSourceType: SectionSpanV2["quotedSourceType"];
    score: number;
    count: number;
    heading: string;
    rationale: string;
    evidence: Set<string>;
  };

  const assignments: Vote[] = [];
  for (const paragraph of source.paragraphs) {
    const votes = new Map<string, Vote>();
    for (const candidate of candidates) {
      if (paragraph.ordinal < candidate.startOrdinal || paragraph.ordinal > candidate.endOrdinal) continue;
      const key = candidateKey(candidate);
      const existing = votes.get(key) || {
        key,
        sectionType: candidate.sectionType,
        speakerRole: candidate.speakerRole,
        isQuotedMaterial: candidate.isQuotedMaterial,
        quotedSourceType: candidate.quotedSourceType,
        score: 0,
        count: 0,
        heading: "",
        rationale: "",
        evidence: new Set<string>(),
      };
      // Penalise the very edge of a multi-window call slightly because overlapping
      // neighbouring windows have more context for those same paragraphs.
      const distanceToEdge = Math.min(
        paragraph.ordinal - candidate.startOrdinal,
        candidate.endOrdinal - paragraph.ordinal,
      );
      const edgeBonus = distanceToEdge >= 2 ? 0.03 : 0;
      existing.score += candidate.confidence + edgeBonus;
      existing.count += 1;
      if (!existing.heading && candidate.heading) existing.heading = candidate.heading;
      if (candidate.rationale.length > existing.rationale.length) existing.rationale = candidate.rationale;
      for (const id of candidate.boundaryEvidenceParagraphIds) existing.evidence.add(id);
      votes.set(key, existing);
    }

    const ranked = [...votes.values()].sort((left, right) => {
      const leftTotal = left.score + Math.min(0.2, (left.count - 1) * 0.08);
      const rightTotal = right.score + Math.min(0.2, (right.count - 1) * 0.08);
      return rightTotal - leftTotal;
    });
    if (ranked.length > 1) {
      const first = ranked[0].score / Math.max(1, ranked[0].count);
      const second = ranked[1].score / Math.max(1, ranked[1].count);
      if (Math.abs(first - second) < 0.08) {
        reviewFlags.add(`section_boundary_ambiguous_${paragraph.id}`);
      }
    }
    assignments.push(ranked[0] || {
      key: "other|unknown|direct|none",
      sectionType: "other",
      speakerRole: "unknown",
      isQuotedMaterial: false,
      quotedSourceType: "none",
      score: 0.25,
      count: 1,
      heading: "",
      rationale: "No reliable section vote; preserved for human review.",
      evidence: new Set<string>(),
    });
  }

  const spans: SectionSpanV2[] = [];
  let startIndex = 0;
  for (let index = 1; index <= assignments.length; index += 1) {
    const previous = assignments[index - 1];
    const next = assignments[index];
    if (index < assignments.length && next.key === previous.key) continue;
    const start = source.paragraphs[startIndex];
    const end = source.paragraphs[index - 1];
    const slice = assignments.slice(startIndex, index);
    const average = slice.reduce((sum, vote) => sum + vote.score / Math.max(1, vote.count), 0) / slice.length;
    const evidence = new Set<string>();
    for (const vote of slice) for (const id of vote.evidence) evidence.add(id);
    spans.push({
      id: `S${String(spans.length + 1).padStart(5, "0")}`,
      startParagraphId: start.id,
      endParagraphId: end.id,
      sectionType: previous.sectionType,
      speakerRole: previous.speakerRole,
      heading: slice.find((vote) => vote.heading)?.heading || "",
      isQuotedMaterial: previous.isQuotedMaterial,
      quotedSourceType: previous.quotedSourceType,
      confidence: Number(Math.max(0, Math.min(1, average)).toFixed(4)),
      boundaryEvidenceParagraphIds: [...evidence].slice(0, 16),
      rationale: slice.sort((a, b) => b.rationale.length - a.rationale.length)[0]?.rationale || "",
    });
    startIndex = index;
  }
  return spans;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function buildSectionMap(
  source: JudgmentSourceV2,
  options: { signal?: AbortSignal; model?: string } = {},
): Promise<{ map: SectionMapV2; audits: Array<Record<string, unknown>> }> {
  const windows = buildWindows(source.paragraphs);
  const paragraphOrdinal = new Map(source.paragraphs.map((paragraph) => [paragraph.id, paragraph.ordinal]));
  const reviewFlags = new Set<string>();

  const results = await mapWithConcurrency(windows, MAX_CONCURRENCY, async (window) => {
    const response = await createStructuredResponse({
      stage: `sections-${window.index + 1}-of-${windows.length}`,
      schemaName: NOMOLOGIES_SCHEMAS.sections.name,
      schema: NOMOLOGIES_SCHEMAS.sections.schema,
      system: SECTION_SYSTEM_PROMPT,
      user: sectionUserPayload(source, window, windows.length),
      effort: "medium",
      model: options.model,
      timeoutMs: 170_000,
      signal: options.signal,
    });
    return {
      response,
      candidates: normalizeWindowSpans(response.data, window, paragraphOrdinal, reviewFlags),
    };
  });

  const candidates = results.flatMap((result) => result.candidates);
  if (!candidates.length) reviewFlags.add("section_agent_returned_no_valid_spans");
  const spans = reconcileCandidates(source, candidates, reviewFlags);
  const map: SectionMapV2 = {
    version: `${NOMOLOGIES_V2_VERSION}:sections-v1`,
    paragraphCount: source.paragraphs.length,
    spans,
    coverageComplete: spans.length > 0 && spans[0].startParagraphId === source.paragraphs[0].id &&
      spans[spans.length - 1].endParagraphId === source.paragraphs[source.paragraphs.length - 1].id,
    overlapFree: true,
    reviewFlags: [...reviewFlags].sort(),
  };

  return {
    map,
    audits: results.map(({ response }, index) => ({
      stage: `sections-${index + 1}`,
      model: response.model,
      responseId: response.responseId,
      elapsedMs: response.elapsedMs,
      usage: response.usage,
    })),
  };
}
