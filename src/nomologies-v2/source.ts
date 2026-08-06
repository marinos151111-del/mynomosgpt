import type {
  JudgmentParagraphV2,
  JudgmentSourceV2,
  NomologiesPipelineInputV2,
  SourceFormattingHints,
} from "./types.ts";

const MAX_PARAGRAPH_CHARS = 7_000;
const MIN_SPLIT_FLOOR = 2_500;
const ATOMIC_SEGMENT_THRESHOLD = 180;

type SourceUnit = {
  text: string;
  parentBlockId: string;
};

function normalizeNewlines(value: string): string {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function decodeEntity(entity: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»",
  };
  if (entity[0] === "#") {
    const hex = entity[1]?.toLowerCase() === "x";
    const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isFinite(value) ? String.fromCodePoint(value) : `&${entity};`;
  }
  return named[entity.toLowerCase()] ?? `&${entity};`;
}

export function htmlToConservativeText(html: string): string {
  if (!html.trim()) return "";
  return normalizeNewlines(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<\/(?:p|div|section|article|header|footer|h[1-6]|li|tr|table|blockquote)>/gi, "\n\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, "")
      .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity) => decodeEntity(entity)),
  );
}

function uppercaseRatio(value: string): number {
  const letters = [...value].filter((char) => /[A-Za-zΑ-Ωα-ωΆ-Ώά-ώ]/u.test(char));
  if (!letters.length) return 0;
  const upper = letters.filter((char) => char === char.toLocaleUpperCase("el") && char !== char.toLocaleLowerCase("el")).length;
  return Number((upper / letters.length).toFixed(3));
}

function paragraphNumber(value: string): string {
  const match = value.match(/^\s*(?:\[(\d{1,4})\]|\((\d{1,4})\)|(\d{1,4})[.)])\s+/u);
  return String(match?.[1] || match?.[2] || match?.[3] || "");
}

function formattingHints(value: string): SourceFormattingHints {
  const clean = value.trim();
  const ratio = uppercaseRatio(clean);
  const short = clean.length <= 180;
  const headingCandidate = short && (
    ratio >= 0.64 ||
    /^(ΑΠΟΦΑΣΗ|ΔΙΑΤΑΓΗ|ΓΕΓΟΝΟΤΑ|ΠΡΑΓΜΑΤΙΚΑ|ΙΣΤΟΡΙΚΟ|ΝΟΜΙΚΟ ΠΛΑΙΣΙΟ|ΝΟΜΙΚΗ ΑΝΑΛΥΣΗ|ΚΡΙΣΗ|ΚΑΤΑΛΗΞΗ|ΕΞΟΔΑ|SENTENCE|JUDGMENT|FACTS|BACKGROUND|SUBMISSIONS|ANALYSIS|DISPOSITION|ORDER|COSTS)\b/iu.test(clean) ||
    /^(ΕΝΩΠΙΟΝ|ΠΑΡΟΝΤΕΣ|ΜΕΤΑΞΥ|ΚΑΙ ΜΕΤΑΞΥ|Για τον|Για την|Εμφανίσεις)/iu.test(clean)
  );
  return {
    bold: false,
    italic: false,
    centered: false,
    uppercaseRatio: ratio,
    headingCandidate,
    listCandidate: /^(?:[-•*]|\d+[.)]|[α-ωΑ-Ω][.)])\s+/u.test(clean),
    paragraphNumber: paragraphNumber(clean),
    htmlPath: "",
  };
}

function splitLongBlock(block: string): string[] {
  if (block.length <= MAX_PARAGRAPH_CHARS) return [block.trim()];
  const parts: string[] = [];
  let remaining = block.trim();
  while (remaining.length > MAX_PARAGRAPH_CHARS) {
    const window = remaining.slice(0, MAX_PARAGRAPH_CHARS);
    let splitAt = -1;
    for (const marker of ["\n", ". ", "; ", "· ", "· ", ": "]) {
      const candidate = window.lastIndexOf(marker);
      if (candidate >= MIN_SPLIT_FLOOR) splitAt = Math.max(splitAt, candidate + marker.length);
    }
    if (splitAt < MIN_SPLIT_FLOOR) splitAt = MAX_PARAGRAPH_CHARS;
    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) parts.push(remaining);
  return parts.filter(Boolean);
}

function sentenceSegments(block: string): string[] {
  const clean = block.trim();
  if (!clean) return [];
  const structural = formattingHints(clean).headingCandidate || /^[_—–-]{4,}$/u.test(clean);
  if (clean.length <= ATOMIC_SEGMENT_THRESHOLD || structural) return splitLongBlock(clean);

  let segments: string[] = [];
  try {
    const segmenter = new Intl.Segmenter("el", { granularity: "sentence" });
    segments = [...segmenter.segment(clean)]
      .map((item) => item.segment.trim())
      .filter(Boolean);
  } catch {
    segments = clean
      .split(/(?<=[.!;·])\s+(?=[«“"'(\[]*[A-ZΑ-ΩΆΈΉΊΌΎΏ])/u)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  // Extremely long legal paragraphs sometimes omit normal sentence boundaries.
  // Split only at strong proposition-owner transitions so submissions and the
  // present court's response do not remain inside one attribution unit.
  if (segments.length <= 1 && clean.length > 900) {
    segments = clean
      .split(/(?=\b(?:Ο Εφεσείων|Η Εφεσείουσα|Ο Αιτητής|Η Αιτήτρια|Ο Καθ' ου|Η Καθ' ης|Βρίσκουμε|Κρίνουμε|Υπενθυμίζουμε|Κατ' ακολουθία|Ως αποτέλεσμα|Πρόκειται για θέση|Δεν βρίσκουμε)\b)/u)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  const merged: string[] = [];
  for (const segment of segments) {
    const startsLowercase = /^[«“"'(\[]*[a-zα-ωάέήίόύώϊΐϋΰ]/u.test(segment);
    const previous = merged[merged.length - 1] || "";
    const openParentheses = (previous.match(/\(/g) || []).length > (previous.match(/\)/g) || []).length;
    const openGreekQuote = (previous.match(/«/g) || []).length > (previous.match(/»/g) || []).length;
    const openCurlyQuote = (previous.match(/“/g) || []).length > (previous.match(/”/g) || []).length;
    const previousEndsWithAbbreviation = /(?:\(?βλ|πρβλ|κ\.ά|κ\.α|ν|v|vs|αρ|ημερ|σελ|Δ|ΔΔ|Ltd|Co|Insur)\.\s*$/iu.test(previous) || /(?:[A-ZΑ-Ω]\.){2,}\s*$/u.test(previous);
    const shortCitationContinuation = segment.length <= 180 && /^(?:[A-ZΑ-Ω][\p{L}'’.-]+|\(?\d{4}\)|\d+\([A-ZΑ-Ω]\)|C\.L\.R\.|Α\.Α\.Δ\.)/u.test(segment);
    const continuePrevious = startsLowercase || openParentheses || openGreekQuote || openCurlyQuote || previousEndsWithAbbreviation ||
      (shortCitationContinuation && /(?:\b(?:ν|v|vs)\.|\(βλ\.|,\s*)/iu.test(previous));
    if (merged.length && continuePrevious) {
      merged[merged.length - 1] = `${previous} ${segment}`.trim();
    } else {
      merged.push(segment);
    }
  }
  return merged.flatMap(splitLongBlock).filter(Boolean);
}

function initialBlocks(text: string): SourceUnit[] {
  let blocks = text.split(/\n\s*\n+/g).map((block) => block.trim()).filter(Boolean);
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);

  // CyLaw pages often flatten each legal paragraph onto its own line. Use line
  // segmentation only when blank-line segmentation plainly collapsed the source.
  if (blocks.length <= 5 && lines.length >= 12) blocks = lines;

  // Preserve numbered legal paragraphs even when the source has only single line
  // breaks. This does not classify the paragraph; it only restores boundaries.
  if (blocks.length < 12 && lines.length >= 20) {
    const numbered = lines.filter((line) => /^(?:\[?\d{1,4}\]?|\(\d{1,4}\))\s*[.)]?\s+/u.test(line)).length;
    if (numbered >= Math.max(5, Math.floor(lines.length * 0.18))) blocks = lines;
  }

  return blocks.flatMap((block, index) => {
    const parentBlockId = `B${String(index + 1).padStart(5, "0")}`;
    return sentenceSegments(block).map((text) => ({ text, parentBlockId }));
  });
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function lineNumberAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < Math.min(offset, text.length); index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

export async function prepareJudgmentSource(input: NomologiesPipelineInputV2): Promise<JudgmentSourceV2> {
  const cleanText = normalizeNewlines(input.text || htmlToConservativeText(input.html || ""));
  if (cleanText.length < 80) throw new Error("JUDGMENT_SOURCE_TOO_SHORT");

  const sourceHash = await sha256(cleanText);
  const sourceId = `src_${sourceHash.slice(0, 24)}`;
  const units = initialBlocks(cleanText);
  if (!units.length) throw new Error("JUDGMENT_PARAGRAPHS_EMPTY");

  let cursor = 0;
  const paragraphs: JudgmentParagraphV2[] = units.map((unit, index) => {
    const block = unit.text;
    let startOffset = cleanText.indexOf(block, cursor);
    if (startOffset < 0) startOffset = cursor;
    const endOffset = startOffset + block.length;
    cursor = endOffset;
    return {
      id: `P${String(index + 1).padStart(6, "0")}`,
      ordinal: index + 1,
      text: block,
      startOffset,
      endOffset,
      relativePosition: units.length > 1 ? Number((index / (units.length - 1)).toFixed(6)) : 1,
      parentBlockId: unit.parentBlockId,
      sourceLineStart: lineNumberAt(cleanText, startOffset),
      sourceLineEnd: lineNumberAt(cleanText, endOffset),
      formatting: formattingHints(block),
    };
  });

  return {
    sourceId,
    sourceHash,
    sourceUrl: String(input.sourceUrl || "").trim(),
    sourceTitle: String(input.sourceTitle || "").trim(),
    sourceDatabase: String(input.sourceDatabase || "").trim(),
    retrievedAt: new Date().toISOString(),
    charset: String(input.charset || "utf-8").trim() || "utf-8",
    languageHint: /[Α-Ωα-ωΆ-Ώά-ώ]/u.test(cleanText) ? "el" : "en",
    originalHtml: String(input.html || ""),
    cleanText,
    characterCount: cleanText.length,
    paragraphs,
  };
}

