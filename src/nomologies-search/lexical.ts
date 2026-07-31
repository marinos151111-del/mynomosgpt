import { normalizeCaseNumber, normalizeLegalText, tokenizeLegalText } from "./normalize.ts";
import type {
  EliteSearchResponseV1,
  ParsedSearchQueryV1,
  SearchDocumentV1,
  SearchFacetBucketV1,
  SearchFacetResponseV1,
  SearchFieldNameV1,
  SearchFiltersV1,
  SearchHitV1,
  SearchScoreBreakdownV1,
  SmartTagV1,
} from "./types.ts";

type FieldStats = {
  tokens: string[];
  frequencies: Map<string, number>;
  length: number;
};

type IndexedDocument = {
  document: SearchDocumentV1;
  fields: Map<SearchFieldNameV1, FieldStats>;
  allText: string;
};

const K1 = 1.35;
const B = 0.72;

function increment(map: Map<string, number>, key: string, amount = 1): void {
  map.set(key, (map.get(key) || 0) + amount);
}

function fieldStats(text: string): FieldStats {
  const tokens = tokenizeLegalText(text);
  const frequencies = new Map<string, number>();
  for (const token of tokens) increment(frequencies, token);
  return { tokens, frequencies, length: Math.max(1, tokens.length) };
}

function same(value: string, expected: string): boolean {
  return normalizeLegalText(value) === normalizeLegalText(expected);
}

function includes(value: string, expected: string): boolean {
  return normalizeLegalText(value).includes(normalizeLegalText(expected));
}

function passesFilters(document: SearchDocumentV1, filters: SearchFiltersV1): boolean {
  const facets = document.facets;
  if (filters.caseFamily && facets.caseFamily !== filters.caseFamily) return false;
  if (filters.legalArea && !facets.legalAreas.includes(filters.legalArea) && facets.primaryLegalArea !== filters.legalArea) return false;
  if (filters.proceedingType && facets.proceedingType !== filters.proceedingType) return false;
  if (filters.proceduralPosture && facets.proceduralPosture !== filters.proceduralPosture) return false;
  if (filters.courtLevel && facets.courtLevel !== filters.courtLevel) return false;
  if (filters.court && !includes(facets.court, filters.court)) return false;
  if (filters.judge && !facets.judges.some((judge) => includes(judge, filters.judge!))) return false;
  if (filters.authoringJudge && !facets.authoringJudges.some((judge) => includes(judge, filters.authoringJudge!))) return false;
  if (filters.outcome && !facets.outcomes.includes(filters.outcome)) return false;
  if (filters.lawId && !facets.lawIds.some((lawId) => includes(lawId, filters.lawId!))) return false;
  if (filters.provision && !facets.provisionKeys.some((provision) => includes(provision, filters.provision!))) return false;
  if (filters.authorityTreatment && !facets.authorityTreatments.includes(filters.authorityTreatment)) return false;
  if (filters.authorityContext && !facets.authorityContexts.includes(filters.authorityContext)) return false;
  if (filters.yearFrom && (!facets.year || facets.year < filters.yearFrom)) return false;
  if (filters.yearTo && (!facets.year || facets.year > filters.yearTo)) return false;
  return true;
}

function snippet(text: string, query: ParsedSearchQueryV1): string {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= 310) return clean;
  const normalized = normalizeLegalText(clean);
  const needles = [...query.exactPhrases, ...query.terms, ...query.expandedTerms]
    .map(normalizeLegalText)
    .filter((term) => term.length >= 3);
  let position = -1;
  for (const needle of needles) {
    const found = normalized.indexOf(needle);
    if (found >= 0 && (position < 0 || found < position)) position = found;
  }
  if (position < 0) return `${clean.slice(0, 305)}…`;
  const start = Math.max(0, position - 90);
  const end = Math.min(clean.length, start + 310);
  return `${start > 0 ? "…" : ""}${clean.slice(start, end)}${end < clean.length ? "…" : ""}`;
}

function facetBuckets(values: string[]): SearchFacetBucketV1[] {
  const counts = new Map<string, number>();
  for (const value of values.map((item) => String(item || "").trim()).filter(Boolean)) increment(counts, value);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value, "el"));
}

function facetsFor(documents: SearchDocumentV1[]): SearchFacetResponseV1 {
  return {
    caseFamilies: facetBuckets(documents.map((document) => document.facets.caseFamily)),
    legalAreas: facetBuckets(documents.flatMap((document) => document.facets.legalAreas)),
    proceedingTypes: facetBuckets(documents.map((document) => document.facets.proceedingType)),
    courts: facetBuckets(documents.map((document) => document.facets.court)),
    judges: facetBuckets(documents.flatMap((document) => document.facets.judges)),
    outcomes: facetBuckets(documents.flatMap((document) => document.facets.outcomes)),
    lawIds: facetBuckets(documents.flatMap((document) => document.facets.lawIds)),
    years: facetBuckets(documents.map((document) => document.facets.year ? String(document.facets.year) : "")),
  };
}

export class LexicalCaseIndexV1 {
  private readonly documents = new Map<string, IndexedDocument>();

  upsert(document: SearchDocumentV1): void {
    const fields = new Map<SearchFieldNameV1, FieldStats>();
    for (const field of document.fields) fields.set(field.name, fieldStats(field.normalized || field.text));
    this.documents.set(document.id, {
      document,
      fields,
      allText: normalizeLegalText([
        document.title,
        document.shortTitle,
        document.citation,
        document.caseNumber,
        ...document.aliases,
        ...document.smartTags.flatMap((tag) => [tag.label, ...tag.aliases]),
        ...document.fields.map((field) => field.text),
      ].join(" ")),
    });
  }

  remove(id: string): boolean {
    return this.documents.delete(id);
  }

  clear(): void {
    this.documents.clear();
  }

  size(): number {
    return this.documents.size;
  }

  list(): SearchDocumentV1[] {
    return [...this.documents.values()].map((entry) => entry.document);
  }

  private documentFrequency(term: string, fieldName: SearchFieldNameV1): number {
    let count = 0;
    for (const entry of this.documents.values()) {
      if ((entry.fields.get(fieldName)?.frequencies.get(term) || 0) > 0) count += 1;
    }
    return count;
  }

  private averageFieldLength(fieldName: SearchFieldNameV1): number {
    const lengths = [...this.documents.values()].map((entry) => entry.fields.get(fieldName)?.length || 0).filter((length) => length > 0);
    if (!lengths.length) return 1;
    return lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
  }

  private bm25(entry: IndexedDocument, query: ParsedSearchQueryV1): { score: number; matched: SearchFieldNameV1[] } {
    const queryTokens = [...new Set(query.expandedTerms.flatMap((term) => tokenizeLegalText(term)))].slice(0, 100);
    let score = 0;
    const matched = new Set<SearchFieldNameV1>();
    const totalDocuments = Math.max(1, this.documents.size);

    for (const field of entry.document.fields) {
      const stats = entry.fields.get(field.name);
      if (!stats) continue;
      const averageLength = this.averageFieldLength(field.name);
      for (const term of queryTokens) {
        const frequency = stats.frequencies.get(term) || 0;
        if (!frequency) continue;
        const df = this.documentFrequency(term, field.name);
        const idf = Math.log(1 + (totalDocuments - df + 0.5) / (df + 0.5));
        const denominator = frequency + K1 * (1 - B + B * stats.length / averageLength);
        score += field.weight * idf * (frequency * (K1 + 1) / denominator);
        matched.add(field.name);
      }
    }
    return { score, matched: [...matched] };
  }

  private identityScore(entry: IndexedDocument, query: ParsedSearchQueryV1): number {
    let score = 0;
    const caseNumber = normalizeCaseNumber(entry.document.caseNumber);
    for (const detected of query.detectedCaseNumbers) {
      if (caseNumber && caseNumber === detected) score = Math.max(score, 220);
      else if (caseNumber && detected.includes(caseNumber)) score = Math.max(score, 160);
    }
    for (const citation of query.detectedCitations) {
      if (same(entry.document.citation, citation)) score = Math.max(score, 210);
      else if (includes(entry.document.citation, citation)) score = Math.max(score, 150);
    }
    const normalized = query.normalized;
    if (normalized && normalized.length >= 3) {
      if (same(entry.document.title, normalized) || same(entry.document.shortTitle, normalized)) score = Math.max(score, 230);
      else if (entry.document.aliases.some((alias) => same(alias, normalized))) score = Math.max(score, 205);
      else if (entry.document.aliases.some((alias) => includes(alias, normalized))) score = Math.max(score, 115);
    }
    return score;
  }

  private phraseScore(entry: IndexedDocument, query: ParsedSearchQueryV1): number {
    let score = 0;
    const phrases = [...query.exactPhrases, ...(query.normalized.length > 5 ? [query.normalized] : [])];
    for (const phrase of phrases) {
      const normalized = normalizeLegalText(phrase);
      if (!normalized) continue;
      for (const field of entry.document.fields) {
        if ((field.normalized || normalizeLegalText(field.text)).includes(normalized)) score += field.weight * 3.5;
      }
      if (entry.document.aliases.some((alias) => normalizeLegalText(alias).includes(normalized))) score += 80;
    }
    return score;
  }

  private tagScore(entry: IndexedDocument, query: ParsedSearchQueryV1): { score: number; tags: SmartTagV1[] } {
    const matched: SmartTagV1[] = [];
    let score = 0;
    const terms = [...new Set([query.normalized, ...query.expandedTerms].map(normalizeLegalText).filter(Boolean))];
    for (const tag of entry.document.smartTags) {
      const candidates = [tag.normalized, ...tag.aliases.map(normalizeLegalText)].filter(Boolean);
      const exact = terms.some((term) => candidates.some((candidate) => term === candidate));
      const partial = !exact && terms.some((term) => term.length >= 4 && candidates.some((candidate) => candidate.includes(term) || term.includes(candidate)));
      if (!exact && !partial) continue;
      matched.push(tag);
      score += tag.boost * tag.confidence * (exact ? 4.5 : 1.8);
    }
    return { score, tags: matched.sort((left, right) => right.boost - left.boost).slice(0, 12) };
  }

  search(query: ParsedSearchQueryV1, limit = 20): EliteSearchResponseV1 {
    const startedAt = performance.now();
    const filtered = [...this.documents.values()].filter((entry) => passesFilters(entry.document, query.filters));
    const hits: SearchHitV1[] = [];

    for (const entry of filtered) {
      if (query.excludedTerms.some((term) => entry.allText.includes(normalizeLegalText(term)))) continue;
      const exactIdentity = this.identityScore(entry, query);
      const phrase = this.phraseScore(entry, query);
      const lexical = this.bm25(entry, query);
      const tags = this.tagScore(entry, query);
      const facetScore = Object.keys(query.filters).length ? 8 : 0;
      const authorityScore = query.intent === "authority" && lexical.matched.includes("authorities") ? 18 : 0;
      const qualityScore = Math.max(-8, Math.min(8, (entry.document.quality.readinessScore - 70) / 5))
        - entry.document.quality.criticalConflicts * 3;
      const total = exactIdentity + phrase + lexical.score + tags.score + facetScore + authorityScore + qualityScore;
      if (total <= 0.01 && query.normalized) continue;

      const breakdown: SearchScoreBreakdownV1 = {
        exactIdentity,
        phrase,
        lexical: lexical.score,
        smartTags: tags.score,
        facets: facetScore,
        semantic: 0,
        authority: authorityScore,
        quality: qualityScore,
        total,
      };
      const matchedFields = lexical.matched;
      const preferredField = (["principle", "ratio", "holding", "issues", "provisions", "identity", "facts", "procedure", "authorities", "outcome", "evidence", "chronology"] as SearchFieldNameV1[])
        .find((name) => matchedFields.includes(name)) || entry.document.fields[0]?.name || "identity";
      const sourceField = entry.document.fields.find((field) => field.name === preferredField) || entry.document.fields[0];
      const whyMatched = [
        exactIdentity >= 150 ? "Ακριβής αντιστοίχιση ονόματος, αριθμού ή παραπομπής" : "",
        phrase > 0 ? "Ακριβής φράση σε σταθμισμένο νομικό πεδίο" : "",
        tags.tags.length ? `Έξυπνες έννοιες: ${tags.tags.slice(0, 4).map((tag) => tag.label).join(" · ")}` : "",
        matchedFields.length ? `Πεδία: ${matchedFields.join(" · ")}` : "",
        query.filters.provision ? `Διάταξη: ${query.filters.provision}` : "",
      ].filter(Boolean);

      hits.push({
        document: entry.document,
        score: total,
        scoreBreakdown: breakdown,
        matchedFields,
        matchedTags: tags.tags,
        whyMatched,
        snippet: snippet(sourceField?.text || entry.document.title, query),
        snippetField: sourceField?.name || "identity",
      });
    }

    hits.sort((left, right) => right.score - left.score || (right.document.year || 0) - (left.document.year || 0));
    const top = hits.slice(0, Math.max(1, Math.min(100, limit)));
    return {
      query,
      hits: top,
      facets: facetsFor(filtered.map((entry) => entry.document)),
      semanticUsed: false,
      indexSize: this.documents.size,
      elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
    };
  }
}
