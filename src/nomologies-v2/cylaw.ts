import { htmlToConservativeText } from "./source.ts";

export interface FetchedCyLawJudgment {
  sourceUrl: string;
  sourceTitle: string;
  sourceDatabase: string;
  charset: string;
  html: string;
  text: string;
}

const FETCH_TIMEOUT_MS = 25_000;
const MAX_HTML_BYTES = 14_000_000;

export function isOfficialCyLawUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "cylaw.org" || url.hostname === "www.cylaw.org");
  } catch {
    return false;
  }
}

function databaseFromUrl(value: string): string {
  const lower = value.toLowerCase();
  if (lower.includes("supremeconstitutional")) return "supreme_constitutional_court";
  if (lower.includes("administrativecourtofappeal")) return "administrative_court_of_appeal";
  if (lower.includes("supremeadministrative")) return "supreme_administrative";
  if (lower.includes("courtofappeal")) return "court_of_appeal";
  if (lower.includes("supreme")) return "supreme_court";
  return "cylaw";
}

function charsetFromHeadersAndBytes(contentType: string, bytes: Uint8Array): string {
  const header = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1]?.toLowerCase() || "";
  if (header) return header;
  const prefix = new TextDecoder("windows-1252").decode(bytes.slice(0, Math.min(bytes.length, 16_000)));
  const meta = prefix.match(/charset\s*=\s*["']?\s*([a-z0-9._-]+)/i)?.[1]?.toLowerCase() || "";
  if (meta) return meta;
  return "";
}

function canonicalCharset(value: string): string {
  const clean = value.toLowerCase().replace(/[_\s]/g, "-");
  if (/^(windows|cp)-?1253$/.test(clean)) return "windows-1253";
  if (/^(iso-?8859-?7|greek)$/.test(clean)) return "iso-8859-7";
  if (/^utf-?8$/.test(clean)) return "utf-8";
  if (/^(windows|cp)-?1252$/.test(clean)) return "windows-1252";
  return clean || "utf-8";
}

function replacementScore(value: string): number {
  const replacements = (value.match(/�/g) || []).length;
  const controls = (value.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
  return replacements * 10 + controls;
}

function decodeJudgment(bytes: Uint8Array, declared: string): { html: string; charset: string } {
  const candidates = [canonicalCharset(declared), "utf-8", "windows-1253", "iso-8859-7"];
  const seen = new Set<string>();
  const decoded: Array<{ html: string; charset: string; score: number }> = [];
  for (const charset of candidates) {
    if (!charset || seen.has(charset)) continue;
    seen.add(charset);
    try {
      const html = new TextDecoder(charset).decode(bytes);
      decoded.push({ html, charset, score: replacementScore(html) });
    } catch {
      // Unsupported decoder label; try the next standards-compatible alias.
    }
  }
  decoded.sort((left, right) => left.score - right.score);
  if (!decoded.length) throw new Error("CYLAW_CHARSET_DECODE_FAILED");
  return decoded[0];
}

function decodeHtmlText(value: string): string {
  const map: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    ndash: "–", mdash: "—", laquo: "«", raquo: "»",
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity: string) => {
    if (entity.startsWith("#")) {
      const hex = entity[1]?.toLowerCase() === "x";
      const number = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : `&${entity};`;
    }
    return map[entity.toLowerCase()] || `&${entity};`;
  });
}

function titleFromHtml(html: string): string {
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
  return decodeHtmlText(title.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
}

export async function fetchCyLawJudgment(
  sourceUrl: string,
  signal?: AbortSignal,
): Promise<FetchedCyLawJudgment> {
  if (!isOfficialCyLawUrl(sourceUrl)) throw new Error("CYLAW_URL_NOT_ALLOWED");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("CYLAW_FETCH_TIMEOUT")), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const response = await fetch(sourceUrl, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MyNomosAI-NomologiesV2/1.0; authorised legal research)",
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "el,en;q=0.7",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`CYLAW_FETCH_HTTP_${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_HTML_BYTES) throw new Error("CYLAW_SOURCE_TOO_LARGE");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_HTML_BYTES) throw new Error("CYLAW_SOURCE_TOO_LARGE");
    const declared = charsetFromHeadersAndBytes(response.headers.get("content-type") || "", bytes);
    const decoded = decodeJudgment(bytes, declared);
    const text = htmlToConservativeText(decoded.html);
    if (text.length < 80) throw new Error("CYLAW_SOURCE_EMPTY");
    return {
      sourceUrl: response.url || sourceUrl,
      sourceTitle: titleFromHtml(decoded.html),
      sourceDatabase: databaseFromUrl(response.url || sourceUrl),
      charset: decoded.charset,
      html: decoded.html,
      text,
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

