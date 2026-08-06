// ════════════════════════════════════════════════════════════════════════════
// case-search-engine.ts — global precision query engine for Νομολογίες.
//
// Pure functions, no I/O. Deno/TypeScript compatible.
//
// Provides backward-compatible exports:
//   - strip(tokenOrText)
//   - lemma(token)
//   - lemmatize(text)
//   - parseQuery(text)
//   - matchExpr(ast, hay)
//   - leafTerms(ast)
//   - countHits(ast, hay)
//   - extractSnippet(rawText, ast, max?)
//
// Adds production helpers:
//   - tokenizeForSearch(text)
//   - buildSearchDoc(text)
//   - scoreMatch(ast, docOrText, options?)
//   - explainMatch(ast, docOrText)
//
// Design goals:
//   - global, law-agnostic matching; no CAP113/CAP154/tax hacks
//   - Greek final-sigma/accent/micro-sign normalization
//   - conservative legal-search stemming, not destructive morphology
//   - correct boolean precedence: NOT > AND > OR
//   - Google-style -term exclusion
//   - phrase matching on lemma-token sequences
//   - positive/negative leaf separation for scoring/snippets
//   - offset-based snippets, not ratio-based approximations
// ════════════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────────
// Normalisation
// ───────────────────────────────────────────────────────────────────────────

const COMBINING_MARKS_RX = /[\u0300-\u036f]/g;
const TOKEN_RX = /[A-Za-zΑ-Ωα-ωΆ-ώΪΫϊϋΐΰµΜ]+|\d+(?:[.,]\d+)*/gu;
const WORD_CHAR_RX = /[a-zα-ω0-9]/u;

/**
 * Accent/case/final-sigma normaliser.
 * Keeps punctuation so callers that need phrase text can still decide how to split.
 */
export function strip(s: string): string {
  return (s || "")
    .replace(/[µ]/g, "μ")
    .replace(/[Μ]/g, "Μ")
    .toLowerCase()
    .normalize("NFD")
    .replace(COMBINING_MARKS_RX, "")
    .replace(/ς/g, "σ")
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeToken(token: string): string {
  return strip(token)
    .replace(/[,]/g, ".")
    .replace(/^\.+|\.+$/g, "");
}

function isGreekToken(t: string): boolean {
  return /[α-ω]/u.test(t);
}

function isNumericToken(t: string): boolean {
  return /^\d+(?:\.\d+)*$/.test(t);
}

function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ───────────────────────────────────────────────────────────────────────────
// Conservative Greek / English legal-search lemmatisation
// ───────────────────────────────────────────────────────────────────────────

const STEM_BLOCKLIST = new Set([
  // Greek function words / legal connectors
  "και", "η", "ο", "το", "τα", "τη", "την", "του", "των", "σε", "στη", "στην", "στο", "στον", "με", "για",
  "δια", "ως", "εν", "επι", "απο", "προσ", "υπο", "περι", "κατα", "ανευ", "μη", "δεν", "να", "που",
  // English connectors
  "and", "or", "not", "the", "of", "to", "in", "on", "for", "by", "with", "from", "without",
]);

/**
 * High-precision Greek suffix rules.
 * These rules intentionally avoid single-letter stripping and avoid turning short
 * legal words into ambiguous stems. They collapse common Cyprus-law forms:
 *   αμέλεια/αμέλειας/αμέλειες       → αμελει
 *   σύμβαση/σύμβασης/συμβάσεις      → συμβασ
 *   ακύρωση/ακύρωσης/ακυρώσεις      → ακυρωσ
 *   προμελέτη/προμελέτης/προμελέτες → προμελετ
 */
const GREEK_REWRITE_RULES: Array<[RegExp, string, number]> = [
  [/ει(?:α|ασ|εσ|ων)$/u, "ει", 6],
  [/ασ(?:η|ησ|εισ|εων)$/u, "ασ", 6],
  [/ωσ(?:η|ησ|εισ|εων)$/u, "ωσ", 6],
  [/ησ(?:η|ησ|εισ|εων)$/u, "ησ", 6],
  [/ετ(?:η|ησ|εσ|ων)$/u, "ετ", 6],
  [/οτ(?:ητα|ητασ|ητεσ|ητων)$/u, "οτ", 8],
  [/ευσ(?:η|ησ|εισ|εων)$/u, "ευσ", 7],
  [/ποιησ(?:η|ησ|εισ|εων)$/u, "ποιησ", 9],
  [/ουργημ(?:α|ατοσ|ατα|ατων)$/u, "ουργημ", 9],
];

const GREEK_SUFFIXES = [
  // longer endings first; all after strip() final-sigma folding
  "ικων", "ικοισ", "ικουσ", "ικησ", "ικεσ", "ικοσ", "ικου", "ικη", "ικα",
  "τικων", "τικοισ", "τικουσ", "τικησ", "τικεσ", "τικοσ", "τικου", "τικη", "τικα",
  "μενων", "μενοισ", "μενουσ", "μενησ", "μενεσ", "μενοσ", "μενου", "μενη", "μενα",
  "σεων", "σεωσ", "ηδων", "αδων", "ουδων",
  "ατοσ", "ατων", "ματα", "ματοσ", "ματων",
  "ουσεσ", "ουνται", "ηκαν", "ηκε", "ηκα", "ωσαν", "ωσε", "ωσα",
  "εων", "εωσ", "ιασ", "ιεσ", "ιων", "ιου", "ιουσ",
  "ουσ", "οισ", "αισ", "ων", "ου", "οι", "ον", "ασ", "εσ", "ησ",
];

function englishLemma(t: string): string {
  if (t.length <= 4) return t;
  if (t.endsWith("'s")) return t.slice(0, -2);
  if (t.length > 7 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 8 && t.endsWith("ments")) return t.slice(0, -1);
  if (t.length > 6 && t.endsWith("s") && !/(ss|us|is)$/u.test(t)) return t.slice(0, -1);
  return t;
}

export function lemma(token: string): string {
  const t = normalizeToken(token);
  if (!t || STEM_BLOCKLIST.has(t) || isNumericToken(t)) return t;

  // If the token contains mixed punctuation/letters after normalisation, split it
  // through the same tokenizer and represent it as a phrase-like lemma sequence.
  if (/[^a-zα-ω0-9.]/u.test(t)) return lemmatize(t);

  if (!isGreekToken(t)) return englishLemma(t);
  if (t.length <= 4) return t;

  for (const [rx, replacement, minLen] of GREEK_REWRITE_RULES) {
    if (t.length >= minLen && rx.test(t)) return t.replace(rx, replacement);
  }

  for (const suf of GREEK_SUFFIXES) {
    if (t.length - suf.length >= 4 && t.endsWith(suf)) return t.slice(0, -suf.length);
  }
  return t;
}

export interface SearchToken {
  raw: string;
  norm: string;
  lemma: string;
  start: number;
  end: number;
  index: number;
}

export interface SearchDoc {
  raw: string;
  tokens: SearchToken[];
  lemmas: string[];
  lemmaText: string;
  lemmaSet: Set<string>;
}

export function tokenizeForSearch(text: string): SearchToken[] {
  const raw = text || "";
  const out: SearchToken[] = [];
  TOKEN_RX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RX.exec(raw)) !== null) {
    const tokenRaw = m[0];
    const norm = normalizeToken(tokenRaw);
    if (!norm) continue;
    const parts = norm.match(/[a-zα-ω]+|\d+(?:\.\d+)*/gu) || [];
    if (parts.length <= 1) {
      const lem = lemma(norm);
      if (!lem) continue;
      out.push({ raw: tokenRaw, norm, lemma: lem, start: m.index, end: m.index + tokenRaw.length, index: out.length });
    } else {
      // Preserve approximate offsets for compound tokens such as Ν.144(Ι)/2001.
      let searchFrom = m.index;
      for (const part of parts) {
        const local = raw.slice(searchFrom, m.index + tokenRaw.length).toLowerCase().indexOf(part.toLowerCase());
        const start = local >= 0 ? searchFrom + local : m.index;
        const end = Math.min(m.index + tokenRaw.length, start + part.length);
        const lem = lemma(part);
        if (lem) out.push({ raw: raw.slice(start, end), norm: part, lemma: lem, start, end, index: out.length });
        searchFrom = end;
      }
    }
  }
  return out;
}

export function buildSearchDoc(text: string): SearchDoc {
  const tokens = tokenizeForSearch(text || "");
  const lemmas = tokens.map((t) => t.lemma).filter(Boolean);
  return {
    raw: text || "",
    tokens,
    lemmas,
    lemmaText: lemmas.join(" "),
    lemmaSet: new Set(lemmas),
  };
}

export function lemmatize(text: string): string {
  return buildSearchDoc(text || "").lemmaText;
}

// ───────────────────────────────────────────────────────────────────────────
// Boolean + phrase query parser
// ───────────────────────────────────────────────────────────────────────────

export type AstNode =
  | { type: "term"; value: string; phrase: boolean; raw?: string }
  | { type: "and"; children: AstNode[] }
  | { type: "or"; children: AstNode[] }
  | { type: "not"; child: AstNode };

type QueryToken =
  | { kind: "word"; value: string }
  | { kind: "phrase"; value: string }
  | { kind: "and" | "or" | "not" | "lparen" | "rparen" };

function isUnaryMinusAt(s: string, i: number): boolean {
  if (s[i] !== "-") return false;
  const prev = i === 0 ? " " : s[i - 1];
  const next = i + 1 < s.length ? s[i + 1] : "";
  return /\s|\(|^/.test(prev) && !!next && !/\s|\)/.test(next);
}

function tokenizeQuery(text: string): QueryToken[] {
  const out: QueryToken[] = [];
  const s = String(text || "").trim();
  let i = 0;

  while (i < s.length) {
    const ch = s[i];

    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "(") { out.push({ kind: "lparen" }); i++; continue; }
    if (ch === ")") { out.push({ kind: "rparen" }); i++; continue; }

    if (ch === '"') {
      let j = i + 1;
      let val = "";
      while (j < s.length) {
        if (s[j] === '"') break;
        if (s[j] === "\\" && j + 1 < s.length) { val += s[j + 1]; j += 2; continue; }
        val += s[j];
        j++;
      }
      out.push({ kind: "phrase", value: val });
      i = j < s.length && s[j] === '"' ? j + 1 : j;
      continue;
    }

    if (isUnaryMinusAt(s, i)) {
      out.push({ kind: "not" });
      i++;
      continue;
    }

    if (ch === "!" && i + 1 < s.length) { out.push({ kind: "not" }); i++; continue; }
    if (ch === "+") { i++; continue; } // Google-style required term; default AND already does this.

    let j = i;
    while (j < s.length && !/[\s()"]/.test(s[j])) j++;
    const word = s.slice(i, j);
    i = j;
    if (!word) continue;

    const op = strip(word).toUpperCase();
    if (op === "AND" || word === "&&") out.push({ kind: "and" });
    else if (op === "OR" || word === "||") out.push({ kind: "or" });
    else if (op === "NOT") out.push({ kind: "not" });
    else out.push({ kind: "word", value: word });
  }

  return out;
}

function termNodeFromText(raw: string, forcePhrase = false): AstNode | null {
  const value = lemmatize(raw);
  if (!value) return null;
  const tokenCount = value.split(" ").filter(Boolean).length;
  return { type: "term", value, phrase: forcePhrase || tokenCount > 1, raw };
}

class Parser {
  private pos = 0;
  private toks: QueryToken[];
  constructor(toks: QueryToken[]) { this.toks = toks; }
  private peek(): QueryToken | undefined { return this.toks[this.pos]; }
  private eat(): QueryToken | undefined { return this.toks[this.pos++]; }

  parse(): AstNode | null {
    return this.parseOr();
  }

  private parseOr(): AstNode | null {
    let left = this.parseAnd();
    while (this.peek()?.kind === "or") {
      this.eat();
      const right = this.parseAnd();
      if (!right) continue; // trailing OR: ignore operator, do not create match-all term
      if (!left) { left = right; continue; }
      left = left.type === "or" ? { type: "or", children: [...left.children, right] } : { type: "or", children: [left, right] };
    }
    return left;
  }

  private parseAnd(): AstNode | null {
    let left = this.parseNot();
    while (this.peek() && this.peek()!.kind !== "or" && this.peek()!.kind !== "rparen") {
      if (this.peek()!.kind === "and") this.eat();
      const right = this.parseNot();
      if (!right) continue;
      if (!left) { left = right; continue; }
      left = left.type === "and" ? { type: "and", children: [...left.children, right] } : { type: "and", children: [left, right] };
    }
    return left;
  }

  private parseNot(): AstNode | null {
    if (this.peek()?.kind === "not") {
      this.eat();
      const child = this.parseNot();
      return child ? { type: "not", child } : null;
    }
    return this.parseAtom();
  }

  private parseAtom(): AstNode | null {
    const tok = this.eat();
    if (!tok) return null;

    if (tok.kind === "lparen") {
      const inner = this.parseOr();
      if (this.peek()?.kind === "rparen") this.eat();
      return inner;
    }

    if (tok.kind === "phrase") return termNodeFromText(tok.value, true);
    if (tok.kind === "word") return termNodeFromText(tok.value, false);

    // Stray operator or unmatched rparen. Ignore safely.
    return null;
  }
}

export function parseQuery(text: string): AstNode | null {
  const toks = tokenizeQuery(text || "");
  if (!toks.length) return null;
  return new Parser(toks).parse();
}

// ───────────────────────────────────────────────────────────────────────────
// AST leaf collection with polarity
// ───────────────────────────────────────────────────────────────────────────

export interface LeafTermsOptions {
  includeNegative?: boolean;
  positiveOnly?: boolean;
}

export interface LeafTermsResult {
  words: string[];
  phrases: string[];
  negativeWords?: string[];
  negativePhrases?: string[];
}

/**
 * By default returns positive terms only. Use includeNegative=true if you need
 * both positive and negative leaves. This deliberately fixes the original bug
 * where NOT terms polluted scoring and snippets.
 */
export function leafTerms(ast: AstNode | null, options: LeafTermsOptions = {}): LeafTermsResult {
  const words: string[] = [];
  const phrases: string[] = [];
  const negativeWords: string[] = [];
  const negativePhrases: string[] = [];

  const walk = (n: AstNode, negated: boolean) => {
    if (n.type === "term") {
      if (!n.value) return;
      if (negated) {
        if (n.phrase) negativePhrases.push(n.value); else negativeWords.push(n.value);
      } else {
        if (n.phrase) phrases.push(n.value); else words.push(n.value);
      }
      return;
    }
    if (n.type === "not") { walk(n.child, !negated); return; }
    for (const c of n.children) walk(c, negated);
  };

  if (ast) walk(ast, false);
  const base: LeafTermsResult = { words: uniq(words), phrases: uniq(phrases) };
  if (options.includeNegative) {
    base.negativeWords = uniq(negativeWords);
    base.negativePhrases = uniq(negativePhrases);
  }
  return base;
}

// ───────────────────────────────────────────────────────────────────────────
// Matching
// ───────────────────────────────────────────────────────────────────────────

function ensureDoc(docOrText: SearchDoc | string): SearchDoc {
  return typeof docOrText === "string" ? buildSearchDoc(docOrText) : docOrText;
}

function containsToken(doc: SearchDoc, term: string): boolean {
  if (!term) return true;
  // term may itself be a phrase-like lemma sequence, e.g. query Κεφ.113 → "κεφ 113".
  if (term.includes(" ")) return containsPhrase(doc, term);
  return doc.lemmaSet.has(term);
}

function containsPhrase(doc: SearchDoc, phrase: string): boolean {
  const parts = phrase.split(/\s+/).filter(Boolean);
  if (!parts.length) return true;
  if (parts.length === 1) return containsToken(doc, parts[0]);

  const first = parts[0];
  for (let i = 0; i <= doc.lemmas.length - parts.length; i++) {
    if (doc.lemmas[i] !== first) continue;
    let ok = true;
    for (let j = 1; j < parts.length; j++) {
      if (doc.lemmas[i + j] !== parts[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

function containsInLemmaText(hay: string, value: string, phrase: boolean): boolean {
  if (!value) return true;
  const cleanHay = ` ${hay || ""} `;
  if (phrase || value.includes(" ")) {
    const rx = new RegExp(`(?:^|\\s)${escapeRegExp(value)}(?=\\s|$)`, "u");
    return rx.test(cleanHay.trim());
  }
  const rx = new RegExp(`(?:^|\\s)${escapeRegExp(value)}(?=\\s|$)`, "u");
  return rx.test(hay || "");
}

/**
 * Backward-compatible evaluator.
 * If hay is a lemmatized string, this does strict token/phrase boundary checks.
 * For best precision, pass buildSearchDoc(rawText) to scoreMatch/explainMatch.
 */
export function matchExpr(ast: AstNode | null, hay: string): boolean {
  if (!ast) return true;
  switch (ast.type) {
    case "term": return containsInLemmaText(hay || "", ast.value, ast.phrase);
    case "not": return !matchExpr(ast.child, hay);
    case "and": return ast.children.every((c) => matchExpr(c, hay));
    case "or": return ast.children.some((c) => matchExpr(c, hay));
  }
}

function matchExprDoc(ast: AstNode | null, doc: SearchDoc): boolean {
  if (!ast) return true;
  switch (ast.type) {
    case "term": return ast.phrase ? containsPhrase(doc, ast.value) : containsToken(doc, ast.value);
    case "not": return !matchExprDoc(ast.child, doc);
    case "and": return ast.children.every((c) => matchExprDoc(c, doc));
    case "or": return ast.children.some((c) => matchExprDoc(c, doc));
  }
}

export function countHits(ast: AstNode | null, hay: string): number {
  if (!ast) return 0;
  const { words, phrases } = leafTerms(ast);
  let n = 0;
  for (const w of words) if (containsInLemmaText(hay, w, false)) n++;
  for (const p of phrases) if (containsInLemmaText(hay, p, true)) n++;
  return n;
}

// ───────────────────────────────────────────────────────────────────────────
// Scoring / explanation helpers
// ───────────────────────────────────────────────────────────────────────────

export interface ScoreOptions {
  /** Extra boost when all positive query leaves hit. Default true. */
  completenessBoost?: boolean;
  /** Phrase hit multiplier. Default 3. */
  phraseWeight?: number;
  /** Word hit multiplier. Default 1. */
  wordWeight?: number;
  /** Penalize documents containing negative leaves even if AST does not exclude them due to OR grouping. Default true. */
  softNegativePenalty?: boolean;
}

function phraseOccurrences(doc: SearchDoc, phrase: string): number[] {
  const parts = phrase.split(/\s+/).filter(Boolean);
  if (!parts.length) return [];
  if (parts.length === 1) return doc.tokens.filter((t) => t.lemma === parts[0]).map((t) => t.index);
  const starts: number[] = [];
  for (let i = 0; i <= doc.lemmas.length - parts.length; i++) {
    let ok = true;
    for (let j = 0; j < parts.length; j++) {
      if (doc.lemmas[i + j] !== parts[j]) { ok = false; break; }
    }
    if (ok) starts.push(i);
  }
  return starts;
}

export function scoreMatch(ast: AstNode | null, docOrText: SearchDoc | string, options: ScoreOptions = {}): number {
  const doc = ensureDoc(docOrText);
  if (!ast) return 1;
  if (!matchExprDoc(ast, doc)) return 0;

  const phraseWeight = options.phraseWeight ?? 3;
  const wordWeight = options.wordWeight ?? 1;
  const { words, phrases, negativeWords = [], negativePhrases = [] } = leafTerms(ast, { includeNegative: true });

  let score = 10;
  let positiveHits = 0;
  const totalPositive = words.length + phrases.length;

  for (const p of phrases) {
    const occ = phraseOccurrences(doc, p).length;
    if (occ > 0) { positiveHits++; score += phraseWeight * Math.min(5, occ) * 6; }
  }
  for (const w of words) {
    let occ = 0;
    for (const t of doc.tokens) if (t.lemma === w) occ++;
    if (occ > 0) { positiveHits++; score += wordWeight * Math.min(6, occ) * 3; }
  }

  if ((options.completenessBoost ?? true) && totalPositive > 0 && positiveHits === totalPositive) score += 12;

  if (options.softNegativePenalty ?? true) {
    for (const p of negativePhrases) if (containsPhrase(doc, p)) score -= 15;
    for (const w of negativeWords) if (containsToken(doc, w)) score -= 8;
  }

  // Prefer denser hits in shorter texts but do not over-penalize long judgments.
  const lengthPenalty = Math.log10(Math.max(10, doc.tokens.length)) * 2;
  return clamp(score - lengthPenalty, 0, 100);
}

export function explainMatch(ast: AstNode | null, docOrText: SearchDoc | string): {
  matched: boolean;
  score: number;
  positive: LeafTermsResult;
  negative: Pick<LeafTermsResult, "negativeWords" | "negativePhrases">;
} {
  const doc = ensureDoc(docOrText);
  const leaves = leafTerms(ast, { includeNegative: true });
  return {
    matched: matchExprDoc(ast, doc),
    score: scoreMatch(ast, doc),
    positive: { words: leaves.words, phrases: leaves.phrases },
    negative: { negativeWords: leaves.negativeWords || [], negativePhrases: leaves.negativePhrases || [] },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Offset-based snippet extraction
// ───────────────────────────────────────────────────────────────────────────

interface HitSpan {
  startToken: number;
  endToken: number;
  start: number;
  end: number;
  term: string;
  phrase: boolean;
}

function collectPositiveHitSpans(doc: SearchDoc, ast: AstNode | null): HitSpan[] {
  const { words, phrases } = leafTerms(ast);
  const spans: HitSpan[] = [];

  for (const w of words) {
    for (const t of doc.tokens) {
      if (t.lemma === w) spans.push({ startToken: t.index, endToken: t.index, start: t.start, end: t.end, term: w, phrase: false });
    }
  }

  for (const p of phrases) {
    const parts = p.split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    for (const startIdx of phraseOccurrences(doc, p)) {
      const first = doc.tokens[startIdx];
      const last = doc.tokens[startIdx + parts.length - 1];
      if (!first || !last) continue;
      spans.push({ startToken: first.index, endToken: last.index, start: first.start, end: last.end, term: p, phrase: true });
    }
  }

  return spans.sort((a, b) => a.start - b.start || Number(b.phrase) - Number(a.phrase));
}

function chooseBestSnippetWindow(doc: SearchDoc, spans: HitSpan[], max: number): { start: number; end: number } | null {
  if (!spans.length) return null;

  let best: { start: number; end: number; score: number } | null = null;

  for (const anchor of spans) {
    const mid = Math.floor((anchor.start + anchor.end) / 2);
    let start = Math.max(0, mid - Math.floor(max / 2));
    let end = Math.min(doc.raw.length, start + max);
    start = Math.max(0, end - max);

    // Expand/contract to word-ish boundaries.
    while (start > 0 && WORD_CHAR_RX.test(strip(doc.raw[start] || ""))) start--;
    while (end < doc.raw.length && WORD_CHAR_RX.test(strip(doc.raw[end] || ""))) end++;

    let score = 0;
    const seen = new Set<string>();
    for (const h of spans) {
      if (h.start >= start && h.end <= end) {
        score += h.phrase ? 10 : 4;
        seen.add(h.term);
      }
    }
    score += seen.size * 3;
    score -= Math.abs((start + end) / 2 - mid) / 200;

    if (!best || score > best.score || (score === best.score && start < best.start)) best = { start, end, score };
  }

  return best ? { start: best.start, end: best.end } : null;
}

export function extractSnippet(rawText: string, ast: AstNode | null, max = 220): { text: string; hits: string[] } | null {
  if (!ast || !rawText) return null;

  const doc = buildSearchDoc(rawText);
  const spans = collectPositiveHitSpans(doc, ast);
  if (!spans.length) return null;

  const win = chooseBestSnippetWindow(doc, spans, max);
  if (!win) return null;

  let snippet = rawText.slice(win.start, win.end).replace(/\s+/g, " ").trim();
  if (win.start > 0) snippet = "…" + snippet;
  if (win.end < rawText.length) snippet = snippet + "…";

  const hitsInWindow = spans
    .filter((h) => h.start >= win.start && h.end <= win.end)
    .map((h) => h.term);

  return { text: snippet, hits: uniq(hitsInWindow) };
}

// ───────────────────────────────────────────────────────────────────────────
// Optional field-aware ranking helper for route-case-search.ts
// ───────────────────────────────────────────────────────────────────────────

export interface WeightedSearchField {
  name: string;
  text: string;
  weight?: number;
}

export interface RankedFieldHit {
  field: string;
  score: number;
  snippet: { text: string; hits: string[] } | null;
}

export function scoreWeightedFields(ast: AstNode | null, fields: WeightedSearchField[]): {
  matched: boolean;
  score: number;
  fields: RankedFieldHit[];
} {
  const hits: RankedFieldHit[] = [];
  let total = 0;
  let matched = false;

  for (const f of fields) {
    const doc = buildSearchDoc(f.text || "");
    const fieldMatched = matchExprDoc(ast, doc);
    if (!fieldMatched) continue;
    matched = true;
    const rawScore = scoreMatch(ast, doc);
    const weighted = rawScore * (f.weight ?? 1);
    total += weighted;
    hits.push({ field: f.name, score: clamp(weighted, 0, 100), snippet: extractSnippet(f.text || "", ast) });
  }

  hits.sort((a, b) => b.score - a.score);
  return { matched, score: clamp(total, 0, 100), fields: hits };
}
