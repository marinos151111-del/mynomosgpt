import { fetchCyLawJudgment, isOfficialCyLawUrl } from "../src/nomologies-v2/cylaw.ts";
import { runNomologiesPipelineV2 } from "../src/nomologies-v2/pipeline.ts";
import { prepareJudgmentSource } from "../src/nomologies-v2/source.ts";
import type { SectionMapV2 } from "../src/nomologies-v2/types.ts";

type JsonRecord = Record<string, unknown>;

const OUTPUT_DIR = "artifacts/nomologies-v2";

function env(name: string): string {
  return String(Deno.env.get(name) || "").trim();
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function html(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function compactResult<T>(result: T): T {
  const clone = structuredClone(result) as unknown as JsonRecord;
  const source = clone.mode === "sections"
    ? clone.source
    : isRecord(clone.record) ? clone.record.source : undefined;
  if (isRecord(source) && typeof source.originalHtml === "string") {
    source.originalHtml = `[omitted from artifact: ${source.originalHtml.length} characters]`;
  }
  return clone as T;
}

function sectionsTable(map: SectionMapV2): string {
  return map.spans.map((span) => `<tr>
    <td><code>${html(span.startParagraphId)}–${html(span.endParagraphId)}</code></td>
    <td><strong>${html(span.sectionType)}</strong></td>
    <td>${html(span.speakerRole)}</td>
    <td>${span.isQuotedMaterial ? `yes · ${html(span.quotedSourceType)}` : "no"}</td>
    <td>${Math.round(Number(span.confidence || 0) * 100)}%</td>
    <td>${html(span.heading || "—")}</td>
    <td>${html(span.rationale || "")}</td>
  </tr>`).join("");
}

function extractedFieldRows(value: unknown, path = "record", rows: string[] = []): string[] {
  if (!value || typeof value !== "object") return rows;
  if (isRecord(value) && typeof value.status === "string" && "value" in value && Array.isArray(value.evidence)) {
    const evidence = value.evidence as unknown[];
    const evidenceHtml = evidence.map((raw) => {
      const item = isRecord(raw) ? raw : {};
      return `<article class="evidence"><header><code>${html(Array.isArray(item.paragraphIds) ? item.paragraphIds.join(", ") : "")}</code> · ${html(item.sectionType)} · ${html(item.speakerRole)}</header><blockquote>“${html(item.quote)}”</blockquote></article>`;
    }).join("");
    rows.push(`<tr>
      <td><code>${html(path.replace(/^record\./, ""))}</code></td>
      <td><span class="status status-${html(value.status)}">${html(value.status)}</span></td>
      <td><pre>${html(JSON.stringify(value.value, null, 2))}</pre></td>
      <td>${Math.round(Number(value.confidence || 0) * 100)}%</td>
      <td><details><summary>${evidence.length} anchor${evidence.length === 1 ? "" : "s"}</summary>${evidenceHtml || "<em>None</em>"}</details></td>
    </tr>`);
    return rows;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => extractedFieldRows(item, `${path}[${index}]`, rows));
    return rows;
  }
  for (const [key, child] of Object.entries(value as JsonRecord)) {
    if (["source", "sectionMap", "allEvidence", "stages"].includes(key)) continue;
    extractedFieldRows(child, `${path}.${key}`, rows);
  }
  return rows;
}

function buildReport(result: Awaited<ReturnType<typeof runNomologiesPipelineV2>>, elapsedMs: number): string {
  const source = result.mode === "sections" ? result.source : result.record.source;
  const map = result.mode === "sections" ? result.sectionMap : result.record.sectionMap;
  const full = result.mode === "full" ? result.record : null;
  const fields = full ? extractedFieldRows(full).join("") : "";
  const conflicts = full?.conflicts.map((item) => `<tr><td class="severity-${html(item.severity)}">${html(item.severity)}</td><td><code>${html(item.code)}</code></td><td><code>${html(item.fieldPath)}</code></td><td>${html(item.message)}</td></tr>`).join("") || "";
  const overview = full
    ? `<div class="metrics"><div><span>Readiness</span><b>${full.readinessScore}/100</b></div><div><span>Strict-ready</span><b>${full.strictReady ? "yes" : "no"}</b></div><div><span>Conflicts</span><b>${full.conflicts.length}</b></div><div><span>Review required</span><b>${full.humanReviewRequired ? "yes" : "no"}</b></div></div>`
    : `<div class="metrics"><div><span>Coverage</span><b>${map.coverageComplete ? "complete" : "incomplete"}</b></div><div><span>Overlap</span><b>${map.overlapFree ? "none" : "detected"}</b></div><div><span>Sections</span><b>${map.spans.length}</b></div><div><span>Review flags</span><b>${map.reviewFlags.length}</b></div></div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nomologies V2 Test</title><style>
  :root{--ink:#1b1813;--muted:#706859;--paper:#f3ecdf;--panel:#fffdf8;--line:#dfd3bf;--brass:#92702e;--ok:#286747;--warn:#946612;--bad:#9b3e31}*{box-sizing:border-box}body{margin:0;background:linear-gradient(#f5efe5,#e9e0d0);color:var(--ink);font-family:Inter,system-ui,sans-serif}main{max-width:1500px;margin:auto;padding:32px 22px 80px}h1,h2{font-family:Georgia,serif;font-weight:500}h1{font-size:42px;margin:0}h2{margin:34px 0 12px}.hero,.card{background:var(--panel);border:1px solid var(--line);border-radius:18px;box-shadow:0 18px 55px rgba(56,43,20,.08)}.hero{padding:25px}.card{padding:16px;overflow:auto}.meta{color:var(--muted)}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-top:20px}.metrics div{padding:12px;background:#f7f1e6;border:1px solid #e5dac7;border-radius:12px}.metrics span{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted)}.metrics b{display:block;margin-top:5px}table{border-collapse:collapse;width:100%;min-width:900px}th,td{padding:10px;border-bottom:1px solid #e9dfcf;text-align:left;vertical-align:top;font-size:13px}th{position:sticky;top:0;background:#f1e9dc;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}pre{white-space:pre-wrap;max-width:590px;margin:0}.status{padding:3px 8px;border-radius:999px;font-size:10px;font-weight:700}.status-available{color:var(--ok);background:#e5f2e9}.status-unavailable{color:var(--muted);background:#eeeae2}.status-indeterminate,.severity-material{color:var(--warn);background:#f7edd2}.status-conflicted,.severity-critical{color:var(--bad);background:#f7e1dc}.evidence{padding:9px;margin:7px 0;background:#f7f1e6;border-left:3px solid var(--brass)}.evidence header{font-size:10px;color:var(--muted)}blockquote{font-family:Georgia,serif;line-height:1.5;margin:7px 0}summary{cursor:pointer;color:var(--brass);font-weight:700}a{color:var(--brass)}
  </style></head><body><main><section class="hero"><h1>Nomologies V2 Test Report</h1><p class="meta"><b>Mode:</b> ${html(result.mode)} · <b>Elapsed:</b> ${Math.round(elapsedMs / 100) / 10}s · <b>Generated:</b> ${html(new Date().toISOString())}</p><p class="meta"><b>Source:</b> <a href="${html(source.sourceUrl)}">${html(source.sourceTitle || source.sourceUrl)}</a> · ${source.paragraphs.length} paragraphs · ${source.characterCount.toLocaleString()} characters · ${html(source.charset)}</p>${overview}</section><h2>Section Map</h2><section class="card"><table><thead><tr><th>Paragraphs</th><th>Section</th><th>Speaker</th><th>Quoted</th><th>Confidence</th><th>Heading</th><th>Rationale</th></tr></thead><tbody>${sectionsTable(map)}</tbody></table></section>${full ? `<h2>Extracted Fields</h2><section class="card"><table><thead><tr><th>Field</th><th>Status</th><th>Value</th><th>Confidence</th><th>Evidence</th></tr></thead><tbody>${fields}</tbody></table></section><h2>Conflicts</h2><section class="card"><table><thead><tr><th>Severity</th><th>Code</th><th>Field</th><th>Message</th></tr></thead><tbody>${conflicts || '<tr><td colspan="4">No conflicts returned.</td></tr>'}</tbody></table></section>` : ""}<h2>Raw JSON</h2><section class="card"><details><summary>Open result</summary><pre>${html(JSON.stringify(compactResult(result), null, 2))}</pre></details></section></main></body></html>`;
}

async function fail(error: unknown, sourceUrl: string, mode: string): Promise<never> {
  await Deno.mkdir(OUTPUT_DIR, { recursive: true });
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack || "" : "";
  await Deno.writeTextFile(`${OUTPUT_DIR}/nomologies-v2-error.json`, JSON.stringify({ ok: false, sourceUrl, mode, message, stack, at: new Date().toISOString() }, null, 2));
  await Deno.writeTextFile(`${OUTPUT_DIR}/summary.md`, `# Nomologies V2 test failed\n\n- Source: ${sourceUrl}\n- Mode: ${mode}\n- Error: ${message}\n`);
  await Deno.writeTextFile(`${OUTPUT_DIR}/nomologies-v2-report.html`, `<!doctype html><meta charset="utf-8"><title>Nomologies V2 failure</title><style>body{font:16px system-ui;padding:40px;max-width:900px;margin:auto}pre{white-space:pre-wrap;background:#f4eee2;padding:20px}</style><h1>Nomologies V2 test failed</h1><p><b>Source:</b> ${html(sourceUrl)}</p><p><b>Mode:</b> ${html(mode)}</p><pre>${html(message)}\n\n${html(stack)}</pre>`);
  console.error(message);
  Deno.exit(1);
}

const sourceUrl = env("SOURCE_URL");
const mode: "sections" | "full" = env("PIPELINE_MODE") === "full" ? "full" : "sections";
const model = env("NOMOLOGIES_V2_MODEL") || undefined;

if (!sourceUrl) await fail(new Error("SOURCE_URL is required."), sourceUrl, mode);
if (!isOfficialCyLawUrl(sourceUrl)) await fail(new Error("SOURCE_URL must be an official HTTPS CyLaw judgment URL."), sourceUrl, mode);
if (!env("OPENAI_API_KEY")) await fail(new Error("GitHub secret OPENAI_API_KEY is not configured."), sourceUrl, mode);

try {
  await Deno.mkdir(OUTPUT_DIR, { recursive: true });
  const fetched = await fetchCyLawJudgment(sourceUrl);
  const prepared = await prepareJudgmentSource({
    text: fetched.text,
    html: fetched.html,
    sourceTitle: fetched.sourceTitle,
    sourceUrl,
    sourceDatabase: fetched.sourceDatabase,
    charset: fetched.charset,
    mode,
  });
  const paragraphLengths = prepared.paragraphs.map((paragraph) => paragraph.text.length).sort((a, b) => a - b);
  const percentile = (fraction: number): number => paragraphLengths.length
    ? paragraphLengths[Math.min(paragraphLengths.length - 1, Math.floor((paragraphLengths.length - 1) * fraction))]
    : 0;
  const diagnostics = {
    sourceUrl,
    sourceTitle: fetched.sourceTitle,
    charset: fetched.charset,
    htmlCharacters: fetched.html.length,
    fetchedTextCharacters: fetched.text.length,
    cleanTextCharacters: prepared.cleanText.length,
    paragraphCount: prepared.paragraphs.length,
    paragraphCharacters: paragraphLengths.reduce((sum, length) => sum + length, 0),
    paragraphLength: {
      minimum: paragraphLengths[0] || 0,
      median: percentile(0.5),
      p90: percentile(0.9),
      p95: percentile(0.95),
      p99: percentile(0.99),
      maximum: paragraphLengths.at(-1) || 0,
    },
    paragraphsAtMaximumSplit: paragraphLengths.filter((length) => length >= 6_900).length,
    generatedAt: new Date().toISOString(),
  };
  await Deno.writeTextFile(`${OUTPUT_DIR}/source-diagnostics.json`, JSON.stringify(diagnostics, null, 2));
  console.log('Source diagnostics:', JSON.stringify(diagnostics));
  const startedAt = Date.now();
  console.log(`Running Nomologies V2 ${mode} test for ${sourceUrl}`);
  const result = await runNomologiesPipelineV2({
    text: fetched.text,
    html: fetched.html,
    sourceTitle: fetched.sourceTitle,
    sourceUrl,
    sourceDatabase: fetched.sourceDatabase,
    charset: fetched.charset,
    mode,
  }, { model });
  const elapsedMs = Date.now() - startedAt;
  const safeResult = compactResult(result);
  await Deno.writeTextFile(`${OUTPUT_DIR}/nomologies-v2-result.json`, JSON.stringify(safeResult, null, 2));
  await Deno.writeTextFile(`${OUTPUT_DIR}/nomologies-v2-report.html`, buildReport(safeResult, elapsedMs));

  const source = result.mode === "sections" ? result.source : result.record.source;
  const map = result.mode === "sections" ? result.sectionMap : result.record.sectionMap;
  const summary = result.mode === "full"
    ? `# Nomologies V2 full extraction completed\n\n- Source: ${source.sourceTitle || source.sourceUrl}\n- URL: ${source.sourceUrl}\n- Paragraphs: ${source.paragraphs.length}\n- Sections: ${map.spans.length}\n- Readiness: ${result.record.readinessScore}/100\n- Strict-ready: ${result.record.strictReady ? "yes" : "no"}\n- Conflicts: ${result.record.conflicts.length}\n- Elapsed: ${Math.round(elapsedMs / 100) / 10}s\n\nDownload the HTML report and JSON artifact for review.\n`
    : `# Nomologies V2 section recognition completed\n\n- Source: ${source.sourceTitle || source.sourceUrl}\n- URL: ${source.sourceUrl}\n- Paragraphs: ${source.paragraphs.length}\n- Sections: ${map.spans.length}\n- Coverage complete: ${map.coverageComplete ? "yes" : "no"}\n- Overlap free: ${map.overlapFree ? "yes" : "no"}\n- Review flags: ${map.reviewFlags.join(", ") || "none"}\n- Elapsed: ${Math.round(elapsedMs / 100) / 10}s\n\nDownload the HTML report to inspect each section and speaker.\n`;
  await Deno.writeTextFile(`${OUTPUT_DIR}/summary.md`, summary);
  console.log(summary);
} catch (error) {
  await fail(error, sourceUrl, mode);
}
