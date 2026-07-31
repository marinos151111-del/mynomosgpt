import type { NomologiesCaseRecordV2 } from "../nomologies-v2/types.ts";
import { buildSearchDocument } from "./document.ts";
import { cosineSimilarity, embedTexts, semanticSearchConfigured } from "./embeddings.ts";
import { LexicalCaseIndexV1 } from "./lexical.ts";
import { normalizeLegalText } from "./normalize.ts";
import { parseSearchQuery } from "./query.ts";
import type {
  EliteSearchResponseV1,
  ParsedSearchQueryV1,
  SearchDocumentV1,
  SearchFieldNameV1,
  SearchFiltersV1,
  SearchHitV1,
  SearchIntentV1,
} from "./types.ts";

type SemanticFieldVectors = Map<SearchFieldNameV1, number[]>;

const INTENT_FIELD_WEIGHTS: Record<SearchIntentV1, Partial<Record<SearchFieldNameV1, number>>> = {
  identity: { identity: 1, authorities: 0.35, provisions: 0.25 },
  provision: { provisions: 1, principle: 0.65, ratio: 0.6, holding: 0.45 },
  principle: { principle: 1, ratio: 1, holding: 0.9, issues: 0.75, provisions: 0.55 },
  authority: { authorities: 1, principle: 0.7, ratio: 0.65, provisions: 0.45 },
  outcome: { outcome: 1, holding: 0.8, issues: 0.55, procedure: 0.4 },
  procedure: { procedure: 1, issues: 0.85, outcome: 0.65, principle: 0.55, chronology: 0.35 },
  facts: { facts: 1, chronology: 0.75, evidence: 0.65, procedure: 0.45 },
  evidence: { evidence: 1, facts: 0.7, holding: 0.55, principle: 0.45 },
  general: { principle: 1, ratio: 0.95, holding: 0.9, issues: 0.85, provisions: 0.75, facts: 0.6, procedure: 0.55, authorities: 0.5, outcome: 0.5 },
};

function bounded(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function fieldWeight(intent: SearchIntentV1, field: SearchFieldNameV1): number {
  return INTENT_FIELD_WEIGHTS[intent][field] || 0.15;
}

function semanticText(document: SearchDocumentV1): Array<{ field: SearchFieldNameV1; text: string }> {
  return document.fields
    .filter((field) => field.text.trim().length >= 8)
    .map((field) => ({
      field: field.name,
      text: [
        `Υπόθεση: ${document.shortTitle}`,
        `Πεδίο: ${field.name}`,
        field.text.slice(0, 18_000),
      ].join("\n"),
    }));
}

function matchesFilters(document: SearchDocumentV1, filters: SearchFiltersV1): boolean {
  const facets = document.facets;
  if (filters.caseFamily && facets.caseFamily !== filters.caseFamily) return false;
  if (filters.legalArea && !facets.legalAreas.includes(filters.legalArea) && facets.primaryLegalArea !== filters.legalArea) return false;
  if (filters.proceedingType && facets.proceedingType !== filters.proceedingType) return false;
  if (filters.proceduralPosture && facets.proceduralPosture !== filters.proceduralPosture) return false;
  if (filters.courtLevel && facets.courtLevel !== filters.courtLevel) return false;
  if (filters.court && !normalizeLegalText(facets.court).includes(normalizeLegalText(filters.court))) return false;
  if (filters.judge && !facets.judges.some((judge) => normalizeLegalText(judge).includes(normalizeLegalText(filters.judge!)))) return false;
  if (filters.authoringJudge && !facets.authoringJudges.some((judge) => normalizeLegalText(judge).includes(normalizeLegalText(filters.authoringJudge!)))) return false;
  if (filters.outcome && !facets.outcomes.includes(filters.outcome)) return false;
  if (filters.lawId && !facets.lawIds.some((lawId) => normalizeLegalText(lawId).includes(normalizeLegalText(filters.lawId!)))) return false;
  if (filters.provision && !facets.provisionKeys.some((provision) => normalizeLegalText(provision).includes(normalizeLegalText(filters.provision!)))) return false;
  if (filters.authorityTreatment && !facets.authorityTreatments.includes(filters.authorityTreatment)) return false;
  if (filters.authorityContext && !facets.authorityContexts.includes(filters.authorityContext)) return false;
  if (filters.yearFrom && (!facets.year || facets.year < filters.yearFrom)) return false;
  if (filters.yearTo && (!facets.year || facets.year > filters.yearTo)) return false;
  return true;
}

function semanticSnippet(document: SearchDocumentV1, fieldName: SearchFieldNameV1): string {
  const field = document.fields.find((item) => item.name === fieldName) || document.fields[0];
  const text = String(field?.text || document.title).replace(/\s+/g, " ").trim();
  return text.length > 310 ? `${text.slice(0, 305)}…` : text;
}

export class EliteCaseSearchEngineV1 {
  private readonly lexical = new LexicalCaseIndexV1();
  private readonly semanticVectors = new Map<string, SemanticFieldVectors>();
  private readonly semanticModels = new Map<string, string>();

  size(): number {
    return this.lexical.size();
  }

  list(): SearchDocumentV1[] {
    return this.lexical.list();
  }

  clear(): void {
    this.lexical.clear();
    this.semanticVectors.clear();
    this.semanticModels.clear();
  }

  remove(id: string): boolean {
    this.semanticVectors.delete(id);
    this.semanticModels.delete(id);
    return this.lexical.remove(id);
  }

  async upsertDocument(
    document: SearchDocumentV1,
    options: { semantic?: boolean; signal?: AbortSignal } = {},
  ): Promise<{ document: SearchDocumentV1; semanticIndexed: boolean }> {
    this.lexical.upsert(document);
    if (options.semantic === false || !semanticSearchConfigured()) {
      return { document, semanticIndexed: false };
    }

    const chunks = semanticText(document);
    if (!chunks.length) return { document, semanticIndexed: false };
    try {
      const vectors = await embedTexts(chunks.map((chunk) => chunk.text), { signal: options.signal });
      const byField = new Map<SearchFieldNameV1, number[]>();
      chunks.forEach((chunk, index) => byField.set(chunk.field, vectors[index] || []));
      this.semanticVectors.set(document.id, byField);
      this.semanticModels.set(document.id, "openai");
      return { document, semanticIndexed: true };
    } catch (error) {
      console.warn("Nomologies semantic indexing unavailable; lexical index retained.", error);
      return { document, semanticIndexed: false };
    }
  }

  async upsertRecord(
    record: NomologiesCaseRecordV2,
    options: { semantic?: boolean; signal?: AbortSignal } = {},
  ): Promise<{ document: SearchDocumentV1; semanticIndexed: boolean }> {
    return await this.upsertDocument(buildSearchDocument(record), options);
  }

  private semanticScores(query: ParsedSearchQueryV1, queryVector: number[]): Map<string, { score: number; field: SearchFieldNameV1 }> {
    const output = new Map<string, { score: number; field: SearchFieldNameV1 }>();
    for (const document of this.lexical.list()) {
      if (!matchesFilters(document, query.filters)) continue;
      const vectors = this.semanticVectors.get(document.id);
      if (!vectors) continue;
      let best = 0;
      let bestField: SearchFieldNameV1 = "principle";
      for (const [field, vector] of vectors) {
        const similarity = cosineSimilarity(queryVector, vector);
        const weighted = similarity * fieldWeight(query.intent, field);
        if (weighted > best) {
          best = weighted;
          bestField = field;
        }
      }
      output.set(document.id, { score: best, field: bestField });
    }
    return output;
  }

  async search(
    raw: string,
    options: {
      filters?: SearchFiltersV1;
      limit?: number;
      semantic?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<EliteSearchResponseV1> {
    const startedAt = performance.now();
    const parsed = parseSearchQuery(raw, options.filters || {});
    const limit = Math.max(1, Math.min(100, options.limit || 20));
    const lexicalResponse = this.lexical.search(parsed, Math.max(limit * 5, 50));
    let semanticUsed = false;
    let semanticScores = new Map<string, { score: number; field: SearchFieldNameV1 }>();

    if (options.semantic !== false && parsed.normalized.length >= 3 && semanticSearchConfigured() && this.semanticVectors.size) {
      try {
        const [queryVector] = await embedTexts([
          `Νομική αναζήτηση (${parsed.intent}): ${parsed.raw}\n${parsed.expandedTerms.slice(0, 40).join(" · ")}`,
        ], { signal: options.signal });
        if (queryVector?.length) {
          semanticScores = this.semanticScores(parsed, queryVector);
          semanticUsed = semanticScores.size > 0;
        }
      } catch (error) {
        console.warn("Nomologies semantic query unavailable; lexical result retained.", error);
      }
    }

    const byId = new Map<string, SearchHitV1>(lexicalResponse.hits.map((hit) => [hit.document.id, hit]));
    for (const document of this.lexical.list()) {
      const semantic = semanticScores.get(document.id);
      if (!semantic || semantic.score < 0.26) continue;
      const semanticPoints = bounded((semantic.score - 0.2) / 0.8) * 62;
      const existing = byId.get(document.id);
      if (existing) {
        existing.score += semanticPoints;
        existing.scoreBreakdown.semantic = semanticPoints;
        existing.scoreBreakdown.total = existing.score;
        if (!existing.matchedFields.includes(semantic.field)) existing.matchedFields.push(semantic.field);
        existing.whyMatched.push(`Σημασιολογική συνάφεια: ${semantic.field}`);
        continue;
      }
      byId.set(document.id, {
        document,
        score: semanticPoints,
        scoreBreakdown: {
          exactIdentity: 0,
          phrase: 0,
          lexical: 0,
          smartTags: 0,
          facets: 0,
          semantic: semanticPoints,
          authority: 0,
          quality: 0,
          total: semanticPoints,
        },
        matchedFields: [semantic.field],
        matchedTags: [],
        whyMatched: [`Σημασιολογική συνάφεια: ${semantic.field}`],
        snippet: semanticSnippet(document, semantic.field),
        snippetField: semantic.field,
      });
    }

    const hits = [...byId.values()]
      .sort((left, right) => right.score - left.score || (right.document.year || 0) - (left.document.year || 0))
      .slice(0, limit);

    return {
      ...lexicalResponse,
      query: parsed,
      hits,
      semanticUsed,
      elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
    };
  }
}
