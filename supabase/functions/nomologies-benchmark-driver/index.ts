import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const SUITE = "cyprus-supreme-2026-five";

function waitUntil(promise: Promise<unknown>): void {
  const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (value: Promise<unknown>) => void } }).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(promise);
  else void promise;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function permittedRunIds(): Promise<string[]> {
  const { data, error } = await db.schema("nomologies").from("pipeline_runs")
    .select("id,stage_state,status")
    .in("status", ["queued", "running"])
    .eq("stage_state->benchmark->>suite", SUITE)
    .order("created_at", { ascending: true })
    .limit(10);
  if (error) throw new Error(`BENCHMARK_RUN_READ_FAILED:${error.message}`);
  return (data || []).map((row) => String(row.id));
}

async function activeCount(runIds: string[]): Promise<number> {
  if (!runIds.length) return 0;
  const result = await db.schema("nomologies").from("pipeline_tasks")
    .select("id", { count: "exact", head: true })
    .in("run_id", runIds)
    .in("status", ["queued", "running", "leased", "retry"]);
  if (result.error) throw new Error(`ACTIVE_TASK_READ_FAILED:${result.error.message}`);
  return result.count || 0;
}

async function kickWorker(count: number): Promise<void> {
  await Promise.allSettled(Array.from({ length: count }, () => fetch(`${SUPABASE_URL}/functions/v1/nomologies-worker`, {
    method: "POST",
    headers: { authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json" },
    body: "{}",
  })));
}

async function drive(fanout: number, durationMs: number): Promise<void> {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    const runIds = await permittedRunIds();
    const active = await activeCount(runIds);
    if (!active) return;
    await kickWorker(Math.max(2, Math.min(fanout, active + 2)));
    await sleep(2500);
  }

  const runIds = await permittedRunIds();
  if (await activeCount(runIds)) {
    await fetch(`${SUPABASE_URL}/functions/v1/nomologies-benchmark-driver-20260814`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fanout, durationMs }),
    });
  }
}

Deno.serve(async (request) => {
  const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
  const fanout = Math.max(2, Math.min(12, Number(payload.fanout) || 8));
  const durationMs = Math.max(30_000, Math.min(125_000, Number(payload.durationMs) || 115_000));
  const runIds = await permittedRunIds();
  if (!runIds.length) return new Response(JSON.stringify({ ok: true, accepted: [], status: "idle" }), { headers: { "content-type": "application/json" } });
  waitUntil(drive(fanout, durationMs));
  return new Response(JSON.stringify({ ok: true, accepted: runIds, fanout, durationMs }), { status: 202, headers: { "content-type": "application/json", "cache-control": "no-store" } });
});
