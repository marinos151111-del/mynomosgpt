import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SUITE = "elite-core-v3-five-20260815";
const db = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
function waitUntil(promise: Promise<unknown>): void { const runtime = (globalThis as any).EdgeRuntime; if (runtime?.waitUntil) runtime.waitUntil(promise); else void promise; }
async function drive(): Promise<void> {
  const { data, error } = await db.schema("nomologies").from("core_v3_runs")
    .select("id,metrics")
    .eq("benchmark_suite", SUITE)
    .eq("status", "completed")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  const ids = (data || []).filter((run: any) => run.metrics?.finalization && !run.metrics?.resolution).map((run: any) => String(run.id));
  await Promise.allSettled(ids.map((runId) => fetch(`${URL}/functions/v1/nomologies-core-v3-resolution`, {
    method: "POST",
    headers: { authorization: `Bearer ${SERVICE}`, "content-type": "application/json" },
    body: JSON.stringify({ runId }),
  })));
}
Deno.serve(() => {
  waitUntil(drive());
  return new Response(JSON.stringify({ ok: true, suite: SUITE }), { status: 202, headers: { "content-type": "application/json", "cache-control": "no-store" } });
});
