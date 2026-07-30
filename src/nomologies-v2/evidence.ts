import {
  FIELD_STATUSES,
  type EvidenceAnchorV2,
  type ExtractedFieldV2,
  type FieldStatus,
  type JudgmentSourceV2,
  type SectionMapV2,
  type SectionSpanV2,
  type SectionType,
  type SpeakerRole,
} from "./types.ts";

type JsonRecord = Record<string, unknown>;

export interface EvidenceValidationContext {
  source: JudgmentSourceV2;
  sectionMap: SectionMapV2;
  paragraphById: Map<string, JudgmentSourceV2["paragraphs"][number]>;
  ordinalById: Map<string, number>;
  sectionByParagraphId: Map<string, SectionSpanV2>;
}

export interface FieldValidationResult<T> {
  field: ExtractedFieldV2<T>;
  reviewFlags: string[];
}

type FieldPolicy = {
  allowedSections?: ReadonlySet<SectionType>;
  disallowedSpeakers?: ReadonlySet<SpeakerRole>;
  allowQuotedMaterial?: boolean;
  titleAllowed?: boolean;
  minimumQuoteLength?: number;
};

const IDENTITY_SECTIONS = new Set<SectionType>([
  "caption", "court_header", "case_metadata", "appearances", "signature",
]);
const FACT_SECTIONS = new Set<SectionType>([
  "facts", "witness_evidence", "documentary_evidence", "findings_of_fact",
  "procedural_history", "court_analysis",
]);
const PROCEDURE_SECTIONS = new Set<SectionType>([
  "caption", "case_metadata", "procedural_history", "appellant_submissions",
  "respondent_submissions", "applicant_submissions",
  "respondent_public_body_submissions", "prosecution_submissions",
  "defence_submissions", "other_party_submissions", "court_analysis",
  "legal_findings", "holding", "disposition", "remedy",
]);
const SUBMISSION_SECTIONS = new Set<SectionType>([
  "appellant_submissions", "respondent_submissions", "applicant_submissions",
  "respondent_public_body_submissions", "prosecution_submissions",
  "defence_submissions", "other_party_submissions",
]);
const ANALYSIS_SECTIONS = new Set<SectionType>([
  "legal_framework", "court_analysis", "findings_of_fact", "legal_findings", "holding",
  "ratio_decidendi", "obiter_dictum", "dissent", "concurrence",
]);
const LEGISLATION_SECTIONS = new Set<SectionType>([
  "legal_framework", "quoted_legislation", "court_analysis", "legal_findings",
  "holding", "ratio_decidendi", "disposition", "remedy", "sentence",
]);
const AUTHORITY_SECTIONS = new Set<SectionType>([
  "quoted_authority", "legal_framework", "court_analysis", "legal_findings",
  "holding", "ratio_decidendi", "obiter_dictum", "dissent", "concurrence",
]);
const OUTCOME_SECTIONS = new Set<SectionType>([
  "holding", "disposition", "remedy", "sentence", "damages", "costs",
]);

const PARTY_SPEAKERS = new Set<SpeakerRole>([
  "appellant", "respondent", "applicant", "public_body", "prosecution",
  "defence", "witness", "expert_witness", "quoted_court", "quoted_author",
]);

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function clamp01(value: unknown, fallback = 0): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.min(1, number));
}

export function normalizeEvidenceText(value: string): string {
  return String(value || "")
    .normalize("NFC")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function canonicalFieldPath(value: string): string {
  return value.trim().replace(/\[\d+\]/g, "").replace(/\.+/g, ".").replace(/^\.|\.$/g, "");
}

function policyFor(fieldPath: string): FieldPolicy {
  const path = canonicalFieldPath(fieldPath);
  if (path.startsWith("identity.")) {
    return { allowedSections: IDENTITY_SECTIONS, titleAllowed: true, minimumQuoteLength: 2 };
  }
  if (path.startsWith("facts.")) {
    return { allowedSections: FACT_SECTIONS, allowQuotedMaterial: false, minimumQuoteLength: 12 };
  }
  if (path === "procedure.submissionsByParty") {
    return { allowedSections: SUBMISSION_SECTIONS, allowQuotedMaterial: false, minimumQuoteLength: 12 };
  }
  if (path.startsWith("procedure.")) {
    return { allowedSections: PROCEDURE_SECTIONS, allowQuotedMaterial: false, minimumQuoteLength: 8 };
  }
  if (path.startsWith("analysis.")) {
    return {
      allowedSections: ANALYSIS_SECTIONS,
      disallowedSpeakers: PARTY_SPEAKERS,
      allowQuotedMaterial: false,
      minimumQuoteLength: 12,
    };
  }
  if (path.startsWith("authorities.legislation") || path.startsWith("authorities.primaryLegislation") || path.startsWith("authorities.secondaryLegislation")) {
    return { allowedSections: LEGISLATION_SECTIONS, allowQuotedMaterial: true, minimumQuoteLength: 5 };
  }
  if (path.startsWith("authorities.authorities")) {
    return { allowedSections: AUTHORITY_SECTIONS, allowQuotedMaterial: true, minimumQuoteLength: 5 };
  }
  if (path.startsWith("outcome.")) {
    return {
      allowedSections: OUTCOME_SECTIONS,
      disallowedSpeakers: PARTY_SPEAKERS,
      allowQuotedMaterial: false,
      minimumQuoteLength: 5,
    };
  }
  return { allowQuotedMaterial: false, minimumQuoteLength: 8 };
}

export function buildEvidenceContext(
  source: JudgmentSourceV2,
  sectionMap: SectionMapV2,
): EvidenceValidationContext {
  const paragraphById = new Map(source.paragraphs.map((paragraph) => [paragraph.id, paragraph]));
  const ordinalById = new Map(source.paragraphs.map((paragraph) => [paragraph.id, paragraph.ordinal]));
  const sectionByParagraphId = new Map<string, SectionSpanV2>();
  for (const span of sectionMap.spans) {
    const start = ordinalById.get(span.startParagraphId);
    const end = ordinalById.get(span.endParagraphId);
    if (!start || !end) continue;
    for (let ordinal = start; ordinal <= end; ordinal += 1) {
      const paragraph = source.paragraphs[ordinal - 1];
      if (paragraph) sectionByParagraphId.set(paragraph.id, span);
    }
  }
  return { source, sectionMap, paragraphById, ordinalById, sectionByParagraphId };
}

function contiguousParagraphs(
  ids: string[],
  context: EvidenceValidationContext,
): JudgmentSourceV2["paragraphs"] | null {
  if (!ids.length) return null;
  const rows = ids.map((id) => context.paragraphById.get(id)).filter(Boolean) as JudgmentSourceV2["paragraphs"];
  if (rows.length !== ids.length) return null;
  rows.sort((left, right) => left.ordinal - right.ordinal);
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].ordinal !== rows[index - 1].ordinal + 1) return null;
  }
  return rows;
}

function validateRawAnchor(
  raw: unknown,
  fieldPath: string,
  index: number,
  context: EvidenceValidationContext,
): { anchor: EvidenceAnchorV2 | null; flags: string[] } {
  const flags: string[] = [];
  if (!isRecord(raw)) return { anchor: null, flags: [`${fieldPath}:invalid_evidence_${index + 1}`] };
  const paragraphIds = asArray(raw.paragraphIds).map(str).filter(Boolean);
  const quote = str(raw.quote);
  const policy = policyFor(fieldPath);
  if (!quote || normalizeEvidenceText(quote).length < (policy.minimumQuoteLength || 8)) {
    return { anchor: null, flags: [`${fieldPath}:evidence_quote_too_short`] };
  }

  if (paragraphIds.length === 1 && paragraphIds[0] === "TITLE") {
    if (!policy.titleAllowed || !context.source.sourceTitle ||
      !normalizeEvidenceText(context.source.sourceTitle).includes(normalizeEvidenceText(quote))) {
      return { anchor: null, flags: [`${fieldPath}:title_evidence_mismatch`] };
    }
    return {
      anchor: {
        id: `EV_${canonicalFieldPath(fieldPath).replace(/[^a-zA-Z0-9]+/g, "_")}_${index + 1}`,
        paragraphIds: ["TITLE"],
        quote,
        sectionType: "caption",
        speakerRole: "court",
        supports: asArray(raw.supports).map(str).filter(Boolean).length
          ? asArray(raw.supports).map(str).filter(Boolean)
          : [fieldPath],
        exactMatch: true,
      },
      flags,
    };
  }

  const rows = contiguousParagraphs(paragraphIds, context);
  if (!rows) return { anchor: null, flags: [`${fieldPath}:evidence_paragraphs_invalid_or_noncontiguous`] };
  const sourceText = normalizeEvidenceText(rows.map((paragraph) => paragraph.text).join(" "));
  const exactMatch = sourceText.includes(normalizeEvidenceText(quote));
  if (!exactMatch) return { anchor: null, flags: [`${fieldPath}:evidence_quote_not_found`] };

  const sections = rows
    .map((paragraph) => context.sectionByParagraphId.get(paragraph.id))
    .filter(Boolean) as SectionSpanV2[];
  if (sections.length !== rows.length) flags.push(`${fieldPath}:evidence_section_missing`);
  const sectionTypes = new Set(sections.map((span) => span.sectionType));
  const speakers = new Set(sections.map((span) => span.speakerRole));
  const quoted = sections.some((span) => span.isQuotedMaterial);

  if (policy.allowedSections && [...sectionTypes].some((section) => !policy.allowedSections!.has(section))) {
    flags.push(`${fieldPath}:evidence_from_wrong_section`);
  }
  if (policy.disallowedSpeakers && [...speakers].some((speaker) => policy.disallowedSpeakers!.has(speaker))) {
    flags.push(`${fieldPath}:evidence_from_wrong_speaker`);
  }
  if (quoted && !policy.allowQuotedMaterial) flags.push(`${fieldPath}:quoted_material_not_permitted`);

  const firstSection = sections[0];
  const criticalAttributionError = flags.some((flag) =>
    flag.endsWith("evidence_from_wrong_section") ||
    flag.endsWith("evidence_from_wrong_speaker") ||
    flag.endsWith("quoted_material_not_permitted")
  );
  if (criticalAttributionError) return { anchor: null, flags };

  return {
    anchor: {
      id: `EV_${canonicalFieldPath(fieldPath).replace(/[^a-zA-Z0-9]+/g, "_")}_${index + 1}`,
      paragraphIds: rows.map((paragraph) => paragraph.id),
      quote,
      sectionType: firstSection?.sectionType || "other",
      speakerRole: firstSection?.speakerRole || "unknown",
      supports: asArray(raw.supports).map(str).filter(Boolean).length
        ? asArray(raw.supports).map(str).filter(Boolean)
        : [fieldPath],
      exactMatch,
    },
    flags,
  };
}

function meaningful(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value as JsonRecord).length > 0;
  return value !== null && value !== undefined;
}

function statusOf(value: unknown): FieldStatus {
  const status = str(value);
  return (FIELD_STATUSES as readonly string[]).includes(status)
    ? status as FieldStatus
    : "indeterminate";
}

export function validateExtractedField<T>(
  raw: unknown,
  fieldPath: string,
  fallback: T,
  context: EvidenceValidationContext,
): FieldValidationResult<T> {
  const row = isRecord(raw) ? raw : {};
  const requestedStatus = statusOf(row.status);
  const value = (row.value === undefined ? fallback : row.value) as T;
  const rawConflicts = asArray(row.conflicts).map(str).filter(Boolean);
  const evidence: EvidenceAnchorV2[] = [];
  const flags: string[] = [];

  for (const [index, item] of asArray(row.evidence).entries()) {
    const validated = validateRawAnchor(item, fieldPath, index, context);
    flags.push(...validated.flags);
    if (validated.anchor) evidence.push(validated.anchor);
  }

  if (requestedStatus === "unavailable") {
    return {
      field: {
        status: "unavailable",
        value: fallback,
        confidence: clamp01(row.confidence),
        evidence,
        conflicts: rawConflicts,
      },
      reviewFlags: flags,
    };
  }

  if (requestedStatus === "conflicted") {
    return {
      field: {
        status: "conflicted",
        value: meaningful(value) ? value : fallback,
        confidence: clamp01(row.confidence),
        evidence,
        conflicts: rawConflicts.length ? rawConflicts : ["Source evidence is materially conflicting."],
      },
      reviewFlags: [...flags, `${fieldPath}:model_reported_conflict`],
    };
  }

  const validAvailable = requestedStatus === "available" && meaningful(value) && evidence.length > 0;
  if (!validAvailable) {
    if (requestedStatus === "available") flags.push(`${fieldPath}:available_field_not_grounded`);
    return {
      field: {
        status: "indeterminate",
        value: fallback,
        confidence: 0,
        evidence: [],
        conflicts: rawConflicts,
      },
      reviewFlags: flags,
    };
  }

  return {
    field: {
      status: "available",
      value,
      confidence: clamp01(row.confidence),
      evidence,
      conflicts: rawConflicts,
    },
    reviewFlags: flags,
  };
}

export function collectEvidence(value: unknown): EvidenceAnchorV2[] {
  const seen = new Set<string>();
  const output: EvidenceAnchorV2[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const record = node as JsonRecord;
    if (Array.isArray(record.evidence)) {
      for (const raw of record.evidence) {
        if (!isRecord(raw) || !str(raw.id) || !str(raw.quote)) continue;
        const key = `${str(raw.id)}|${normalizeEvidenceText(str(raw.quote))}`;
        if (seen.has(key)) continue;
        seen.add(key);
        output.push(raw as unknown as EvidenceAnchorV2);
      }
    }
    Object.values(record).forEach(visit);
  };
  visit(value);
  return output;
}
