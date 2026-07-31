const GREEK_STOPWORDS = new Set([
  "και", "ή", "η", "ο", "οι", "τα", "το", "του", "της", "των", "τον", "την", "τις", "τους",
  "σε", "στο", "στη", "στην", "στον", "στα", "με", "για", "από", "προς", "κατά", "περί", "επί",
  "ως", "ότι", "που", "να", "θα", "δεν", "μη", "ένα", "μια", "ένας", "της", "αυτή", "αυτό",
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "by", "from", "that",
]);

const GREEK_TO_LATIN: Record<string, string> = {
  α: "a", β: "v", γ: "g", δ: "d", ε: "e", ζ: "z", η: "i", θ: "th", ι: "i", κ: "k",
  λ: "l", μ: "m", ν: "n", ξ: "x", ο: "o", π: "p", ρ: "r", σ: "s", ς: "s", τ: "t",
  υ: "y", φ: "f", χ: "ch", ψ: "ps", ω: "o",
};

export function foldGreek(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("el")
    .replace(/ς/g, "σ")
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/[“”„«»]/g, '"')
    .replace(/[’‘΄]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeLegalText(value: string): string {
  return foldGreek(value)
    .replace(/\bν\.?\s*(\d+[()/ιa-zα-ω-]*)/giu, "νομος $1")
    .replace(/\bκεφ\.?\s*(\d+[a-zα-ω-]*)/giu, "κεφαλαιο $1")
    .replace(/\bαρθρ(?:ο|ου)?\s*(\d+[a-zα-ω()/.:-]*)/giu, "αρθρο $1")
    .replace(/\bpart\s+(\d+[a-z0-9()./-]*)/giu, "μερος $1")
    .replace(/\barticle\s+(\d+[a-z0-9()./-]*)/giu, "αρθρο $1")
    .replace(/[^\p{L}\p{N}/().:%+€$'"-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function compactKey(value: string): string {
  return normalizeLegalText(value).replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "");
}

function lightGreekStem(token: string): string {
  if (!/[α-ω]/u.test(token) || token.length < 6) return token;
  const suffixes = [
    "οποιησεων", "οποιηση", "ησεων", "ησεως", "ησης", "ικους", "ικων", "ικο", "ικη", "ικες",
    "ομενων", "ομενη", "ομενο", "οντας", "ουσας", "ουσα", "ουσε", "σεων", "ση", "σεις",
    "ματος", "ματα", "ματων", "ους", "ων", "ους", "ους", "ες", "ος", "ου", "η", "α", "ι",
  ];
  for (const suffix of suffixes) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 4) {
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

export function tokenizeLegalText(value: string, options: { keepStopwords?: boolean; stem?: boolean } = {}): string[] {
  const normalized = normalizeLegalText(value);
  if (!normalized) return [];
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const raw of normalized.split(/\s+/u)) {
    const token = raw.replace(/^[-'".]+|[-'".]+$/g, "");
    if (!token || token.length === 1 && !/\d/u.test(token)) continue;
    if (!options.keepStopwords && GREEK_STOPWORDS.has(token)) continue;
    const finalToken = options.stem === false ? token : lightGreekStem(token);
    if (!finalToken || seen.has(finalToken)) continue;
    seen.add(finalToken);
    tokens.push(finalToken);
  }
  return tokens;
}

export function greekToLatin(value: string): string {
  return foldGreek(value).split("").map((char) => GREEK_TO_LATIN[char] ?? char).join("")
    .replace(/\s+/g, " ").trim();
}

export function legalTextVariants(value: string): string[] {
  const normalized = normalizeLegalText(value);
  const latin = greekToLatin(normalized);
  const compact = compactKey(normalized);
  return [...new Set([normalized, latin, compact].filter(Boolean))];
}

export function ngrams(tokens: string[], min = 2, max = 4): string[] {
  const output: string[] = [];
  for (let size = min; size <= max; size += 1) {
    for (let index = 0; index + size <= tokens.length; index += 1) {
      output.push(tokens.slice(index, index + size).join(" "));
    }
  }
  return output;
}

export function normalizeCaseNumber(value: string): string {
  return foldGreek(value)
    .replace(/\s+/g, "")
    .replace(/[‐‑‒–—−]/g, "-")
    .toUpperCase();
}

export function parseYear(value: string): number | null {
  const matches = String(value || "").match(/\b(19\d{2}|20\d{2})\b/g);
  if (!matches?.length) return null;
  const year = Number(matches[matches.length - 1]);
  return Number.isFinite(year) ? year : null;
}

export function bounded(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}
