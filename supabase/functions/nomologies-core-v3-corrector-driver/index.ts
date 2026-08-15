import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const DRIVER_KEY_SHA256 = "7879b042028414d220805a8e229010a1786cc6070a56e2510a35e8ec322106c8";
const SUITE = "elite-core-v3-five-20260815";
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
function waitUntil(promise: Promise<unknown>): void {
  const runtime = (globalThis as any).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(promise); else void promise;
}
function safeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left); const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let mismatch = 0; for (let index = 0; index < a.length; index += 1) mismatch |= a[index] ^ b[index];
  return mismatch === 0;
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function authorized(req: Request): Promise<boolean> {
  const supplied = req.headers.get("x-core-v3-key") || "";
  return Boolean(supplied && safeEqual(await sha256(supplied), DRIVER_KEY_SHA256));
}
async function drive(): Promise<void> {
  const { data, error } = await db.schema("nomologies").from("core_v3_runs")
    .select("id,metrics")
    .eq("benchmark_suite", SUITE)
    .eq("status", "completed")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  const ids = (data || [])
    .filter((run: any) => !run.metrics?.correction)
    .map((run: any) => String(run.id));
  await Promise.allSettled(ids.map((runId) => fetch(`${SUPABASE_URL}/functions/v1/nomologies-core-v3-corrector`, {
    method: "POST",
    headers: { authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ runId }),
  })));
}
Deno.serve(async (req) => {
  if (!(await authorized(req))) {
    return new Response(JSON.stringify({ ok: false, code: "UNAUTHORIZED" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  waitUntil(drive());
  return new Response(JSON.stringify({ ok: true, suite: SUITE }), {
    status: 202,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
});
