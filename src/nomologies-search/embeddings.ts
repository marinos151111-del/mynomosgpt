const EMBEDDINGS_ENDPOINT = "https://api.openai.com/v1/embeddings";
const DEFAULT_MODEL = "text-embedding-3-large";

function env(name: string): string {
  try {
    return String(Deno.env.get(name) || "").trim();
  } catch {
    return "";
  }
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function semanticSearchConfigured(): boolean {
  return Boolean(env("OPENAI_API_KEY"));
}

export function embeddingModel(): string {
  return env("NOMOLOGIES_EMBEDDING_MODEL") || DEFAULT_MODEL;
}

export async function embedTexts(
  texts: string[],
  options: { signal?: AbortSignal; dimensions?: number } = {},
): Promise<number[][]> {
  const apiKey = env("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY_NOT_CONFIGURED");
  const cleaned = texts.map((text) => String(text || "").trim());
  if (!cleaned.length) return [];
  const dimensions = options.dimensions || Number(env("NOMOLOGIES_EMBEDDING_DIMENSIONS")) || 1024;
  const output: number[][] = [];

  for (let offset = 0; offset < cleaned.length; offset += 32) {
    const input = cleaned.slice(offset, offset + 32);
    const response = await fetch(EMBEDDINGS_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: embeddingModel(),
        input,
        encoding_format: "float",
        dimensions,
      }),
      signal: options.signal,
    });
    if (!response.ok) {
      throw new Error(`OPENAI_EMBEDDINGS_HTTP_${response.status}`);
    }
    const payload = await response.json() as { data?: Array<{ index?: number; embedding?: number[] }> };
    const rows = Array.isArray(payload.data) ? payload.data : [];
    rows.sort((left, right) => asNumber(left.index) - asNumber(right.index));
    if (rows.length !== input.length) throw new Error("OPENAI_EMBEDDINGS_COUNT_MISMATCH");
    for (const row of rows) {
      if (!Array.isArray(row.embedding) || !row.embedding.length) throw new Error("OPENAI_EMBEDDINGS_EMPTY_VECTOR");
      output.push(row.embedding.map(asNumber));
    }
  }
  return output;
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (!length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const a = left[index] || 0;
    const b = right[index] || 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (!leftNorm || !rightNorm) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

