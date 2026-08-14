import { leafTerms, lemmatize, parseQuery, strip } from "./elite-query.ts";

export type SearchIntent =
  | "browse"
  | "identity"
  | "citation"
  | "provision"
  | "authority"
  | "concept"
  | "natural_language";

export type SemanticMode = "never" | "fallback" | "always";

export interface ProvisionReference {
  raw: string;
  instrument: string;
  article: string;
  paragraph: string;
}

export interface SearchQueryPlan {
  rawQuery: string;
  normalizedQuery: string;
  lemmaQuery: string;
  latinQuery: string;
  intent: SearchIntent;
  semanticMode: SemanticMode;
  precisionSyntax: boolean;
  positiveTerms: string[];
  positivePhrases: string[];
  negativeTerms: string[];
  negativePhrases: string[];
  provisionReferences: ProvisionReference[];
  candidateMultiplier: number;
}

const GREEK_TO_LATIN: Record<string, string> = {
  α: "a", β: "v", γ: "g", δ: "d", ε: "e", ζ: "z", η: "i", θ: "th",
  ι: "i", κ: "k", λ: "l", μ: "m", ν: "n", ξ: "x", ο: "o", π: "p",
  ρ: "r", σ: "s", ς: "s", τ: "t", υ: "y", φ: "f", χ: "ch", ψ: "ps", ω: "o",
};

export function greekToLatin(value: string): string {
  return strip(value)
    .split("")
    .map((character) => GREEK_TO_LATIN[character] ?? character)
    .join("")
    .replace(/[^a-z0-9/().:%+€$'"-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function parseProvisionReferences(query: string): ProvisionReference[] {
  const results: ProvisionReference[] = [];
  const patterns: RegExp[] = [
    /\b(?:κεφ\.?|κεφάλαιο|cap\.?|chapter)\s*([0-9]{1,4}[a-zα-ω]?)\s*(?:[,;:-]?\s*(?:άρθρο|αρθρο|article|art\.?|s\.?|section)\s*([0-9]{1,4}[a-zα-ω]?)(?:\s*\(([^)]+)\))?)?/giu,
    /\b(?:άρθρο|αρθρο|article|art\.?|s\.?|section)\s*([0-9]{1,4}[a-zα-ω]?)(?:\s*\(([^)]+)\))?\s*(?:του|of)?\s*(?:συντάγματος|συνταγμα|constitution|κεφ\.?\s*[0-9]{1,4}|cap\.?\s*[0-9]{1,4})?/giu,
    /\b(?:νόμος|νομος|law)\s*([0-9]{1,4}\s*\/\s*[0-9]{2,4})\b/giu,
  ];

  for (const pattern of patterns) {
    for (const match of query.matchAll(pattern)) {
      const raw = match[0].trim();
      const normalized = strip(raw);
      let instrument = "";
      let article = "";
      let paragraph = "";
      const cap = normalized.match(/(?:κεφ|κεφαλαιο|cap|chapter)\s*([0-9]{1,4}[a-zα-ω]?)/u);
      const art = normalized.match(/(?:αρθρο|article|art|section|s)\s*([0-9]{1,4}[a-zα-ω]?)/u);
      const law = normalized.match(/(?:νομοσ|law)\s*([0-9]{1,4}\s*\/\s*[0-9]{2,4})/u);
      if (cap) instrument = `cap ${cap[1]}`;
      else if (law) instrument = `law ${law[1].replace(/\s+/g, "")}`;
      else if (/συνταγμα|constitution/u.test(normalized)) instrument = "constitution";
      if (art) article = art[1];
      const paren = raw.match(/\(([^)]+)\)/u);
      if (paren) paragraph = strip(paren[1]);
      results.push({ raw, instrument, article, paragraph });
    }
  }

  return [...new Map(results.map((item) => [strip(item.raw), item])).values()];
}

function looksLikeCaseNumber(query: string): boolean {
  return /(?:^|\s)(?:αρ\.?\s*)?\d{1,5}\s*\/\s*(?:19|20)?\d{2,4}(?:\s|$)/iu.test(query);
}

function looksLikeCitation(query: string): boolean {
  return /\b(?:ecli:|\[?(?:19|20)\d{2}\]?\s*(?:1|2|3)?\s*(?:clr|aad|a\.a\.d\.)|πολιτικ[ηή]\s+εφεση\s+αρ)/iu.test(query);
}

function looksLikeAuthority(query: string): boolean {
  return /\b(?:v\.?|vs\.?|ν\.?|κατά)\b/iu.test(query) && /[\p{L}]{2,}/u.test(query);
}

function looksLikeNaturalLanguage(query: string): boolean {
  const wordCount = query.trim().split(/\s+/u).filter(Boolean).length;
  return wordCount >= 6 || /^(?:κατα|ποσο|ποτε|πότε|πωϏ|πώς|αν|whether|when|how|what|can|does|is)\b/iu.test(query);
}

function classifyIntent(query: string, provisions: ProvisionReference[]): SearchIntent {
  const trimmed = query.trim();
  if (trimmed === "*") return "browse";
  if (provisions.length > 0) return "provision";
  if (looksLikeCaseNumber(trimmed)) return "identity";
  if (looksLikeCitation(trimmed)) return "citation";
  if (looksLikeAuthority(trimmed)) return "authority";
  if (looksLikeNaturalLanguage(trimmed)) return "natural_language";
  if (trimmed.split(/\s+/u).length <= 3 && /[\p{L}]/u.test(trimmed)) return "concept";
  return "concept";
}

function semanticModeFor(intent: SearchIntent): SemanticMode {
  if (intent === "browse" || intent === "identity" || intent === "citation") return "never";
  if (intent === "natural_language" || intent === "concept") return "always";
  return "fallback";
}

export function buildQueryPlan(rawQuery: string): SearchQueryPlan {
  const raw = String(rawQuery || "").trim();
  const normalizedQuery = strip(raw);
  const lemmaQuery = lemmatize(raw);
  const latinQuery = greekToLatin(raw);
  const ast = parseQuery(raw);
  const leaves = leafTerms(ast, { includeNegative: true });
  const provisionReferences = parseProvisionReferences(raw);
  const intent = classifyIntent(raw, provisionReferences);
  const precisionSyntax = /["()]|\b(?:AND|OR|NOT)\b|(?:^|\s)-\S/iu.test(raw);

  return {
    rawQuery: raw,
    normalizedQuery,
    lemmaQuery,
    latinQuery,
    intent,
    semanticMode: semanticModeFor(intent),
    precisionSyntax,
    positiveTerms: unique(leaves.words || []),
    positivePhrases: unique(leaves.phrases || []),
    negativeTerms: unique(leaves.negativeWords || []),
    negativePhrases: unique(leaves.negativePhrases || []),
    provisionReferences,
    candidateMultiplier: intent === "natural_language" ? 10 : intent === "concept" ? 8 : 5,
  };
}
