import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const LIVE_KEY_SHA256 = "cc5bb5d0a15fd13d1e5576b16984ffe2a1b3ab3050749de2fd3145cce416e2fe";
const DRIVER = "nomologies-core-v3-live-driver";
const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, any>;
const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const now = (): string => new Date().toISOString();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
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
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
function waitUntil(promise: Promise<unknown>): void {
  const runtime = (globalThis as any).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(promise);
  else void promise;
}

async function authorized(req: Request, payload: Row): Promise<boolean> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (SERVICE_KEY && safeEqual(bearer, SERVICE_KEY)) return true;

  const suppliedStatic = req.headers.get("x-core-v3-key") || "";
  if (suppliedStatic && safeEqual(await sha256(suppliedStatic), LIVE_KEY_SHA256)) return true;

  const coreRunId = text(payload.coreRunId || payload.runId);
  const suppliedToken = text(payload.driverToken);
  if (!/^[0-9a-f-]{36}$/i.test(coreRunId) || !suppliedToken) return false;
  const { data, error } = await db.schema("nomologies").from("core_v3_live_links")
    .select("driver_token")
    .eq("core_run_id", coreRunId)
    .maybeSingle();
  if (error || !data) return false;
  const expected = text(data.driver_token);
  return Boolean(expected && safeEqual(suppliedToken, expected));
}

async function invoke(name: string, payload: Row = {}): Promise<Row> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = object(await response.json().catch(() => ({})));
  if (!response.ok || body.ok === false) {
    throw new Error(
      `${name.toUpperCase().replace(/-/g, "_")}_FAILED:${response.status}:${text(body.code) || text(body.message) || "unknown"}`,
    );
  }
  return body;
}

async function readState(coreRunId: string): Promise<{ link: Row; run: Row }> {
  const [linkResult, runResult] = await Promise.all([
    db.schema("nomologies").from("core_v3_live_links").select("*").eq("core_run_id", coreRunId).single(),
    db.schema("nomologies").from("core_v3_runs").select("*").eq("id", coreRunId).single(),
  ]);
  if (linkResult.error) throw new Error(`LIVE_LINK_READ_FAILED:${linkResult.error.message}`);
  if (runResult.error) throw new Error(`CORE_RUN_READ_FAILED:${runResult.error.message}`);
  return { link: linkResult.data, run: runResult.data };
}
async function patchLink(coreRunId: string, patch: Row): Promise<void> {
  const { error } = await db.schema("nomologies").from("core_v3_live_links")
    .update({ ...patch, updated_at: now() })
    .eq("core_run_id", coreRunId);
  if (error) throw new Error(`LIVE_LINK_UPDATE_FAILED:${error.message}`);
}
async function heartbeat(coreRunId: string): Promise<void> {
  await patchLink(coreRunId, {
    orchestrator_locked_until: new Date(Date.now() + 120_000).toISOString(),
  });
}
async function claim(coreRunId: string): Promise<Row | null> {
  const { data, error } = await db.schema("nomologies").rpc("claim_core_v3_live_link", {
    p_core_run_id: coreRunId,
    p_worker_name: `${DRIVER}-${crypto.randomUUID().slice(0, 8)}`,
    p_lease_seconds: 120,
  });
  if (error) throw new Error(`LIVE_LINK_CLAIM_FAILED:${error.message}`);
  return Array.isArray(data) ? data[0] || null : object(data);
}
async function selfInvoke(coreRunId: string, delayMs = 250): Promise<void> {
  if (delayMs > 0) await sleep(delayMs);
  await fetch(`${SUPABASE_URL}/functions/v1/${DRIVER}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ coreRunId }),
  }).catch(() => undefined);
}

const PHASE_PROGRESS: Record<string, number> = {
  worker: 8,
  refine: 72,
  normalize: 78,
  post_normalize: 83,
  finalize: 88,
  resolve: 92,
  calibrate: 95,
  correct: 97,
  publish: 99,
};

async function updateShadow(link: Row, phase: string): Promise<void> {
  const progress = PHASE_PROGRESS[phase] || 5;
  const { data: shadowRun, error: shadowError } = await db.schema("nomologies").from("pipeline_runs")
    .select("stage_state")
    .eq("id", link.v2_run_id)
    .single();
  if (shadowError) throw new Error(`SHADOW_RUN_READ_FAILED:${shadowError.message}`);
  const stageState = object(shadowRun.stage_state);
  const priorCore = object(stageState.coreV3);
  const stage = `core_v3_${phase}`;
  const { error: runError } = await db.schema("nomologies").from("pipeline_runs").update({
    schema_version: "elite-core-v3.10-live-compat",
    status: "running",
    current_stage: stage,
    model: "gpt-5.4-mini",
    error_code: "",
    error_message: "",
    completed_at: null,
    stage_state: {
      ...stageState,
      coreV3: {
        ...priorCore,
        enabled: true,
        pipeline: "elite-core-v3",
        model: "gpt-5.4-mini",
        coreRunId: link.core_run_id,
        phase,
        progress,
        updatedAt: now(),
      },
    },
    updated_at: now(),
  }).eq("id", link.v2_run_id);
  if (runError) throw new Error(`SHADOW_RUN_UPDATE_FAILED:${runError.message}`);

  if (link.bulk_item_id) {
    const { error: itemError } = await db.schema("nomologies").from("bulk_items").update({
      pipeline_run_id: link.v2_run_id,
      status: "processing",
      current_stage: stage,
      progress,
      last_error_code: "",
      last_error_message: "",
      updated_at: now(),
    }).eq("id", link.bulk_item_id);
    if (itemError) throw new Error(`BULK_ITEM_UPDATE_FAILED:${itemError.message}`);
  }
}

async function failShadow(link: Row, code: string, message: string): Promise<void> {
  await db.schema("nomologies").from("pipeline_runs").update({
    status: "failed",
    current_stage: "core_v3_failed",
    error_code: code.slice(0, 300),
    error_message: message.slice(0, 4000),
    completed_at: now(),
    updated_at: now(),
  }).eq("id", link.v2_run_id);
  if (link.bulk_item_id) {
    await db.schema("nomologies").from("bulk_items").update({
      status: "blocked",
      current_stage: "core_v3_failed",
      last_error_code: code.slice(0, 300),
      last_error_message: message.slice(0, 4000),
      updated_at: now(),
    }).eq("id", link.bulk_item_id);
  }
  await db.schema("nomologies").from("cases").update({
    pending_run_id: null,
    pending_created_at: null,
    human_review_required: Boolean(link.candidate_version_id),
    updated_at: now(),
  }).eq("id", link.case_id).eq("pending_run_id", link.v2_run_id);
}

async function process(coreRunId: string): Promise<void> {
  const claimed = await claim(coreRunId);
  if (!claimed) return;
  const deadline = Date.now() + 105_000;
  try {
    while (Date.now() < deadline) {
      const { link, run } = await readState(coreRunId);
      if (text(link.phase) === "done") return;
      if (run.status === "failed") {
        throw new Error(`CORE_RUN_FAILED:${text(run.error_code)}:${text(run.error_message)}`);
      }

      await heartbeat(coreRunId);
      const phase = text(link.phase) || "worker";
      await updateShadow(link, phase);

      if (phase === "worker") {
        if (run.status !== "completed") {
          await invoke("nomologies-core-v3-worker", {});
          await sleep(1_800);
          continue;
        }
        await patchLink(coreRunId, {
          phase: run.core_status === "review" ? "refine" : "normalize",
          status: "running",
        });
        continue;
      }
      if (phase === "refine") {
        await invoke("nomologies-core-v3-refiner", { runId: coreRunId });
        await patchLink(coreRunId, { phase: "normalize" });
        continue;
      }
      if (phase === "normalize") {
        await invoke("nomologies-core-v3-normalizer", { runId: coreRunId });
        await patchLink(coreRunId, { phase: "post_normalize" });
        continue;
      }
      if (phase === "post_normalize") {
        await invoke("nomologies-core-v3-postnormalizer", { runId: coreRunId });
        await patchLink(coreRunId, { phase: "finalize" });
        continue;
      }
      if (phase === "finalize") {
        await invoke("nomologies-core-v3-finalizer", { runId: coreRunId });
        await patchLink(coreRunId, { phase: "resolve" });
        continue;
      }
      if (phase === "resolve") {
        await invoke("nomologies-core-v3-resolution", { runId: coreRunId });
        await patchLink(coreRunId, { phase: "calibrate" });
        continue;
      }
      if (phase === "calibrate") {
        await invoke("nomologies-core-v3-mixed-outcome", { runId: coreRunId });
        await patchLink(coreRunId, { phase: "correct" });
        continue;
      }
      if (phase === "correct") {
        await invoke("nomologies-core-v3-corrector", { runId: coreRunId });
        await patchLink(coreRunId, { phase: "publish" });
        continue;
      }
      if (phase === "publish") {
        const result = await invoke("nomologies-core-v3-live-publisher", { coreRunId });
        if (result.autoPublished === true) await invoke("nomologies-worker", {});
        return;
      }
      throw new Error(`UNKNOWN_LIVE_PHASE:${phase}`);
    }

    await patchLink(coreRunId, {
      orchestrator_locked_at: null,
      orchestrator_locked_until: null,
      orchestrator_locked_by: "",
    });
    waitUntil(selfInvoke(coreRunId, 500));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const state = await readState(coreRunId).catch(() => ({ link: claimed as Row, run: {} }));
    const attempts = Number(state.link.attempt_count || 0) + 1;
    const terminal = attempts >= Number(state.link.max_attempts || 8);
    await patchLink(coreRunId, {
      attempt_count: attempts,
      status: terminal ? "failed" : "queued",
      error_code: message.split(":")[0].slice(0, 300),
      error_message: message.slice(0, 4000),
      orchestrator_locked_at: null,
      orchestrator_locked_until: null,
      orchestrator_locked_by: "",
      completed_at: terminal ? now() : null,
    }).catch(() => undefined);
    if (terminal) {
      await failShadow(state.link, message.split(":")[0], message).catch(() => undefined);
    } else {
      waitUntil(selfInvoke(coreRunId, Math.min(10_000, 750 * attempts)));
    }
    console.error(message);
  }
}

Deno.serve(async (req: Request) => {
  const payload = object(await req.json().catch(() => ({})));
  if (!(await authorized(req, payload))) {
    return json({ ok: false, code: "UNAUTHORIZED" }, 401);
  }
  const coreRunId = text(payload.coreRunId || payload.runId);
  if (!/^[0-9a-f-]{36}$/i.test(coreRunId)) {
    return json({ ok: false, code: "CORE_RUN_ID_REQUIRED" }, 400);
  }
  waitUntil(process(coreRunId));
  return json({
    ok: true,
    accepted: true,
    coreRunId,
    pipeline: "elite-core-v3",
    model: "gpt-5.4-mini",
  }, 202);
});
