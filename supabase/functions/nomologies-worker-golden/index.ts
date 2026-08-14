// Controlled five-case benchmark wrapper for the exact pre-change worker source.
// The successful historical golden runs report the provider snapshot
// gpt-5.4-mini-2026-03-17. The request must use the accessible public alias
// gpt-5.4-mini; OpenAI reports the dated snapshot in the response audit.
// Only OpenAI Responses API model selection is pinned. CyLaw fetching,
// Supabase calls and embeddings are not altered. The underlying worker source
// remains commit 186ff106df99541e2604eab64ba43921d5c88cf2.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const PINNED_MODEL = "gpt-5.4-mini";
const RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
const MODELS_ENDPOINT = "https://api.openai.com/v1/models";
const nativeFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
    ? input.toString()
    : input.url;

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
      // Preserve the original request if its body is unexpectedly non-JSON.
    }
  }

  return nativeFetch(input, init);
};

await import(
  "https://raw.githubusercontent.com/marinos151111-del/mynomosgpt/186ff106df99541e2604eab64ba43921d5c88cf2/supabase/functions/nomologies-worker/index.ts"
);
