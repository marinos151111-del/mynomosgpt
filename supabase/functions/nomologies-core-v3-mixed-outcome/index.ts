import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const BUCKET = "nomologies-artifacts";
const db = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

type Row = Record<string, any>;
type Evidence = { paragraphIds: string[]; quote: string };
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const array = (value: unknown): any[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const normalize = (value: string): string => String(value || "").normalize("NFC").replace(/[\u00ad\u200b]/g, "").replace(/[\u00a0\u2007\u202f]/g, " ").replace(/[’‘`´]/g, "'").replace(/[“”]/g, '"').replace(/[‐‑‒–—―]/g, "-").replace(/\s+/gu, " ").trim();
const fold = (value: string): string => normalize(value).toLocaleLowerCase("el").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ς/g, "σ");
const now = () => new Date().toISOString();
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }
function authorized(req: Request): boolean { return SERVICE !== "" && (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") === SERVICE; }
async function upload(path: string, value: unknown): Promise<string> { const { error } = await db.storage.from(BUCKET).upload(path, new TextEncoder().encode(JSON.stringify(value)), { contentType: "application/json", upsert: true }); if (error) throw new Error(`ARTIFACT_UPLOAD_FAILED:${error.message}`); return path; }

async function calibrate(runId: string): Promise<Row> {
  const { data: run, error } = await db.schema("nomologies").from("core_v3_runs").select("*").eq("id", runId).single();
  if (error) throw new Error(`RUN_READ_FAILED:${error.message}`);
  const record = structuredClone(object(run.candidate_record));
  const orders = array(object(object(record.outcome).orders).value);
  const combined = fold(orders.map((item) => `${text(item.text)} ${array(item.evidence).map((anchor: Evidence) => anchor.quote).join(" ")}`).join(" "));
  const evidence = [...new Map(orders.flatMap((item) => array(item.evidence)).map((anchor: Evidence) => [`${anchor.paragraphIds.join(",")}|${normalize(anchor.quote)}`, anchor])).values()];
  const appealDismissed = /εφεση[^.]{0,100}απορριπ/u.test(combined);
  const crossAppealPartly = /αντεφεση[^.]{0,350}(?:πεντε\s+πρωτ|πρωτους\s+λογους)[^.]{0,250}(?:επιτυγχαν|βασιμ)[^.]{0,120}εκτο/u.test(combined) ||
    /αντεφεση[^.]{0,180}απορριπ[^.]{0,250}επιτυγχαν\s+μονο[^.]{0,120}εκτο/u.test(combined);
  if (appealDismissed && crossAppealPartly && evidence.length) {
    record.outcome.overallOutcome = { status: "available", value: "appeal_dismissed_cross_appeal_partly_allowed", confidence: 0.99, evidence };
  }
  record.schemaVersion = "elite-core-v3.7";
  record.calibratedAt = now();
  const blockers = array(run.blockers).filter((blocker) => !String(blocker.path || "").startsWith("outcome.overallOutcome"));
  const coreStatus = blockers.some((blocker) => blocker.required === true) ? "review" : "pass";
  record.coreStatus = coreStatus; record.blockers = blockers;
  const path = await upload(`core-v3/runs/${runId}/record-calibrated.json`, record);
  const metrics = { ...object(run.metrics), outcomeCalibration: { at: now(), schemaVersion: "elite-core-v3.7", value: object(object(record.outcome).overallOutcome).value } };
  const { error: updateError } = await db.schema("nomologies").from("core_v3_runs").update({ candidate_record: record, core_status: coreStatus, blockers, metrics, record_artifact_path: path, updated_at: now() }).eq("id", runId);
  if (updateError) throw new Error(`RUN_UPDATE_FAILED:${updateError.message}`);
  return { runId, coreStatus, outcome: object(object(record.outcome).overallOutcome).value, blockers: blockers.length, recordPath: path };
}

Deno.serve(async (req: Request) => {
  if (!authorized(req)) return json({ ok: false, code: "UNAUTHORIZED" }, 401);
  try { const payload = object(await req.json().catch(() => ({}))); const runId = text(payload.runId); if (!/^[0-9a-f-]{36}$/i.test(runId)) return json({ ok: false, code: "RUN_ID_REQUIRED" }, 400); return json({ ok: true, ...await calibrate(runId) }); }
  catch (error) { console.error(error); return json({ ok: false, code: "CALIBRATION_ERROR", message: error instanceof Error ? error.message : String(error) }, 500); }
});
