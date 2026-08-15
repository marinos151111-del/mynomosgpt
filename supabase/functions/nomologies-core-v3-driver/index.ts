import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SUITE = "elite-core-v3-five-20260815";
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function waitUntil(promise: Promise<unknown>): void {
  const runtime = (globalThis as any).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(promise); else void promise;
}
async function suiteRuns(): Promise<Array<Record<string, any>>> {
  const { data, error } = await db.schema("nomologies").from("core_v3_runs")
    .select("id,status,core_status,metrics")
    .eq("benchmark_suite", SUITE)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}
async function activeCount(): Promise<number> {
  const ids = (await suiteRuns()).filter((run) => ["queued", "running"].includes(String(run.status))).map((run) => String(run.id));
  if (!ids.length) return 0;
  const result = await db.schema("nomologies").from("core_v3_tasks")
    .select("id", { count: "exact", head: true })
    .in("run_id", ids)
    .in("status", ["queued", "retry", "running"]);
  if (result.error) throw new Error(result.error.message);
  return result.count || 0;
}
async function kick(count: number): Promise<void> {
  await Promise.allSettled(Array.from({ length: count }, () => fetch(`${SUPABASE_URL}/functions/v1/nomologies-core-v3-worker`, {
    method: "POST",
    headers: { authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json" },
    body: "{}",
  })));
}
async function refinePending(): Promise<number> {
  const candidates = (await suiteRuns()).filter((run) =>
    run.status === "completed" && run.core_status === "review" && !run.metrics?.refinement && !run.metrics?.normalization
  ).slice(0, 2);
  if (!candidates.length) return 0;
  await Promise.allSettled(candidates.map((run) => fetch(`${SUPABASE_URL}/functions/v1/nomologies-core-v3-refiner`, {
    method: "POST",
    headers: { authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ runId: run.id }),
  })));
  return candidates.length;
}
async function normalizePending(): Promise<number> {
  const candidates = (await suiteRuns()).filter((run) =>
    run.status === "completed" && !run.metrics?.normalization && (run.core_status === "pass" || !!run.metrics?.refinement)
  ).slice(0, 2);
  if (!candidates.length) return 0;
  await Promise.allSettled(candidates.map((run) => fetch(`${SUPABASE_URL}/functions/v1/nomologies-core-v3-normalizer`, {
    method: "POST",
    headers: { authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ runId: run.id }),
  })));
  return candidates.length;
}
async function outstanding(): Promise<boolean> {
  const runs = await suiteRuns();
  return !!(await activeCount()) || runs.some((run) =>
    run.status === "completed" && (
      (run.core_status === "review" && !run.metrics?.refinement && !run.metrics?.normalization) ||
      (!run.metrics?.normalization && (run.core_status === "pass" || !!run.metrics?.refinement))
    )
  );
}
async function drive(): Promise<void> {
  const deadline = Date.now() + 110_000;
  while (Date.now() < deadline) {
    const active = await activeCount();
    if (active) {
      await kick(Math.min(2, Math.max(1, active)));
      await sleep(2500);
      continue;
    }
    if (await refinePending()) { await sleep(1500); continue; }
    if (await normalizePending()) { await sleep(1000); continue; }
    return;
  }
  if (await outstanding()) {
    await fetch(`${SUPABASE_URL}/functions/v1/nomologies-core-v3-driver-20260815`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => undefined);
  }
}
Deno.serve(async () => {
  waitUntil(drive());
  return new Response(JSON.stringify({ ok: true, suite: SUITE }), {
    status: 202,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
});
