// Controlled five-case benchmark wrapper for the exact pre-change worker source.
// The successful historical golden runs used gpt-5.4-mini-2026-03-17 for every
// extraction and verification stage. The wrapper pins only OpenAI Responses API
// calls to that snapshot; CyLaw fetching, Supabase calls and embeddings are not
// altered. The underlying worker source remains commit
// 186ff106df99541e2604eab64ba43921d5c88cf2.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const PINNED_MODEL = "gpt-5.4-mini-2026-03-17";
const RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
const MODELS_ENDPOINT = "https://api.openai.com/v1/models";
const nativeFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
    ? input.toString()
    : input.url;

  // Avoid dynamic model drift. The real response call below is still made with
  // the existing private API key and the original strict schema/source payload.
  if (url === MODELS_ENDPOINT) {
    return new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  if (url === RESPONSES_ENDPOINT && init?.body) {
    try {
      const body = JSON.parse(String(init.body));
      body.model = PINNED_MODEL;
      return nativeFetch(input, { ...init, body: JSON.stringify(body) });
    } catch {
      // Preserve the original request if its body is not JSON for any reason.
    }
  }

  return nativeFetch(input, init);
};

await import(
  "https://raw.githubusercontent.com/marinos151111-del/mynomosgpt/186ff106df99541e2604eab64ba43921d5c88cf2/supabase/functions/nomologies-worker/index.ts"
);
