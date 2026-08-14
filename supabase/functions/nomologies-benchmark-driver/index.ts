import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const DRIVER_TOKEN_SHA256 = "206a3d9872b452a05120551c7ffb2da6793a9fbc79c0f48f6966803f2e601b4c";
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

function safeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a[index] ^ b[index];
  return mismatch === 0;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function waitUntil(promise: Promise<unknown>): void {
  const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (value: Promise<unknown>) => void } }).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(promise);
  else void promise;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function activeCount(runIds: string[]): Promise<number> {
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

async function drive(runIds: string[], token: string, fanout: number, durationMs: number): Promise<void> {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    const active = await activeCount(runIds);
    if (!active) return;
    await kickWorker(Math.max(2, Math.min(fanout, active + 2)));
    await sleep(2500);
  }

  if (await activeCount(runIds)) {
    await fetch(`${SUPABASE_URL}/functions/v1/nomologies-benchmark-driver-20260814`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-benchmark-token": token },
      body: JSON.stringify({ runIds, fanout, durationMs }),
    });
  }
}

Deno.serve(async (request) => {
  const token = request.headers.get("x-benchmark-token") || "";
  if (!token || !safeEqual(await sha256(token), DRIVER_TOKEN_SHA256)) {
    return new Response(JSON.stringify({ ok: false, code: "UNAUTHORIZED" }), { status: 401, headers: { "content-type": "application/json" } });
  }
  const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
  const runIds = Array.isArray(payload.runIds) ? payload.runIds.map(String).filter(Boolean).slice(0, 10) : [];
  if (!runIds.length) return new Response(JSON.stringify({ ok: false, code: "RUN_IDS_REQUIRED" }), { status: 400, headers: { "content-type": "application/json" } });
  const fanout = Math.max(2, Math.min(12, Number(payload.fanout) || 8));
  const durationMs = Math.max(30_000, Math.min(125_000, Number(payload.durationMs) || 115_000));
  waitUntil(drive(runIds, token, fanout, durationMs));
  return new Response(JSON.stringify({ ok: true, accepted: runIds, fanout, durationMs }), { status: 202, headers: { "content-type": "application/json", "cache-control": "no-store" } });
});
