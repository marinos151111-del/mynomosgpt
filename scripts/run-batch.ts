// Batch benchmark: run the full Nomologies V2 pipeline over the first N
// judgments of a CyLaw index page and publish aggregate results.

import { fetchCyLawJudgment, isOfficialCyLawUrl } from "../src/nomologies-v2/cylaw.ts";
import { runNomologiesPipelineV2 } from "../src/nomologies-v2/pipeline.ts";

type JsonRecord = Record<string, unknown>;

const OUTPUT_DIR = "artifacts/nomologies-v2-benchmark";

function env(name: string): string {
  return String(Deno.env.get(name) || "").trim();
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

interface CaseMetrics {
  index: number;
  url: string;
  title: string;
  paragraphs: number;
  sections: number;
  readiness: number;
  strictReady: boolean;
  recommendation: string;
  conflictsCritical: number;
  conflictsMaterial: number;
  conflictsMinor: number;
  caseName: string;
  overallOutcome: string;
  reviewFlagCount: number;
  elapsedMs: number;
  error: string;
}

async function decodeIndexHtml(indexUrl: string): Promise<string> {
  const response = await fetch(indexUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; MyNomosAI-NomologiesV2/1.0; authorised legal research)",
      Accept: "text/html,*/*;q=0.8",
    },
  });
  if (!response.ok) throw new Error(`INDEX_FETCH_HTTP_${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  for (const charset of ["windows-1253", "utf-8", "iso-8859-7"]) {
    try {
      const html = new TextDecoder(charset).decode(bytes);
      if (!html.includes("�")) return html;
    } catch {
      // Try the next candidate charset.
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

export async function extractJudgmentLinks(indexUrl: string, count: number): Promise<string[]> {
  const html = await decodeIndexHtml(indexUrl);
  const links: string[] = [];
  const seen = new Set<string>();
  // Any CyLaw judgment link (open.pl?file=...), regardless of which court
  // database the index belongs to. Host validation happens below.
  const pattern = /href=["']([^"']*open\.pl\?file=[^"']+?\.html)["']/gi;
  for (const match of html.matchAll(pattern)) {
    let absolute: string;
    try {
      absolute = new URL(match[1], indexUrl).toString();
    } catch {
      continue;
    }
    if (!isOfficialCyLawUrl(absolute) || seen.has(absolute)) continue;
    seen.add(absolute);
    links.push(absolute);
    if (links.length >= count) break;
  }
  return links;
}

function compactRecord(result: JsonRecord): JsonRecord {
  const clone = structuredClone(result);
  const record = isRecord(clone.record) ? clone.record : null;
  const source = record && isRecord(record.source) ? record.source : null;
  if (source) {
    if (typeof source.originalHtml === "string") {
      source.originalHtml = `[omitted: ${source.originalHtml.length} characters]`;
    }
    if (typeof source.cleanText === "string") {
      source.cleanText = `[omitted: ${source.cleanText.length} characters]`;
    }
  }
  delete clone.rawAgents;
  return clone;
}

function metricsFrom(index: number, url: string, result: JsonRecord, elapsedMs: number): CaseMetrics {
  const record = isRecord(result.record) ? result.record : {};
  const source = isRecord(record.source) ? record.source : {};
  const sectionMap = isRecord(record.sectionMap) ? record.sectionMap : {};
  const conflicts = Array.isArray(record.conflicts) ? record.conflicts : [];
  const reviewer = isRecord(result.reviewer) ? result.reviewer : {};
  const identity = isRecord(record.identity) ? record.identity : {};
  const caseNameField = isRecord(identity.caseName) ? identity.caseName : {};
  const outcome = isRecord(record.outcome) ? record.outcome : {};
  const overallField = isRecord(outcome.overallOutcome) ? outcome.overallOutcome : {};
  const bySeverity = (severity: string) =>
    conflicts.filter((item) => isRecord(item) && item.severity === severity).length;
  return {
    index,
    url,
    title: String(source.sourceTitle || ""),
    paragraphs: Array.isArray(source.paragraphs) ? source.paragraphs.length : 0,
    sections: Array.isArray(sectionMap.spans) ? sectionMap.spans.length : 0,
    readiness: Number(record.readinessScore || 0),
    strictReady: record.strictReady === true,
    recommendation: String(reviewer.publishRecommendation || ""),
    conflictsCritical: bySeverity("critical"),
    conflictsMaterial: bySeverity("material"),
    conflictsMinor: bySeverity("minor"),
    caseName: String(caseNameField.value || ""),
    overallOutcome: String(overallField.value || ""),
    reviewFlagCount: Array.isArray(record.reviewFlags) ? record.reviewFlags.length : 0,
    elapsedMs,
    error: "",
  };
}

function summaryTable(rows: CaseMetrics[]): string {
  const header = "| # | Case | Readiness | Strict | Conflicts (C/M/m) | Sections | Outcome | Time |\n|---|------|-----------|--------|-------------------|----------|---------|------|";
  const body = rows.map((row) => {
    if (row.error) {
      return `| ${row.index} | [failed](${row.url}) | — | — | — | — | ${row.error} | ${Math.round(row.elapsedMs / 1000)}s |`;
    }
    const name = (row.caseName || row.title || row.url).slice(0, 60).replaceAll("|", "/");
    return `| ${row.index} | [${name}](${row.url}) | ${row.readiness}/100 | ${row.strictReady ? "✅" : "—"} | ${row.conflictsCritical}/${row.conflictsMaterial}/${row.conflictsMinor} | ${row.sections} | ${row.overallOutcome || "?"} | ${Math.round(row.elapsedMs / 1000)}s |`;
  }).join("\n");
  return `${header}\n${body}`;
}

if (import.meta.main) {
  const indexUrl = env("INDEX_URL") || "https://www.cylaw.org/supreme/index_2026.html";
  const count = Math.max(1, Math.min(20, Number(env("CASE_COUNT") || 10)));
  const budgetMs = Math.max(10, Math.min(300, Number(env("BUDGET_MINUTES") || 75))) * 60_000;
  const startedAt = Date.now();

  await Deno.mkdir(OUTPUT_DIR, { recursive: true });
  if (!env("OPENAI_API_KEY")) {
    console.error("OPENAI_API_KEY is not configured.");
    Deno.exit(1);
  }

  console.log(`Collecting ${count} judgment links from ${indexUrl}`);
  const links = await extractJudgmentLinks(indexUrl, count);
  if (!links.length) {
    console.error("No judgment links found on the index page.");
    Deno.exit(1);
  }
  console.log(`Found ${links.length} links.`);

  const rows: CaseMetrics[] = [];
  for (const [position, url] of links.entries()) {
    const caseIndex = position + 1;
    if (Date.now() - startedAt > budgetMs) {
      console.log(`Time budget exhausted; skipping remaining ${links.length - position} cases.`);
      break;
    }
    const caseStarted = Date.now();
    console.log(`\n[${caseIndex}/${links.length}] ${url}`);
    try {
      const fetched = await fetchCyLawJudgment(url);
      const result = await runNomologiesPipelineV2({
        text: fetched.text,
        html: fetched.html,
        sourceTitle: fetched.sourceTitle,
        sourceUrl: url,
        sourceDatabase: fetched.sourceDatabase,
        charset: fetched.charset,
        mode: "full",
      }, { model: env("NOMOLOGIES_V2_MODEL") || undefined });
      const elapsedMs = Date.now() - caseStarted;
      const resultRecord = result as unknown as JsonRecord;
      const metrics = metricsFrom(caseIndex, url, resultRecord, elapsedMs);
      rows.push(metrics);
      await Deno.writeTextFile(
        `${OUTPUT_DIR}/case-${String(caseIndex).padStart(2, "0")}.json`,
        JSON.stringify(compactRecord(resultRecord), null, 2),
      );
      console.log(`  readiness=${metrics.readiness} strict=${metrics.strictReady} conflicts=${metrics.conflictsCritical}/${metrics.conflictsMaterial}/${metrics.conflictsMinor} sections=${metrics.sections} elapsed=${Math.round(elapsedMs / 1000)}s`);
    } catch (error) {
      const elapsedMs = Date.now() - caseStarted;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  FAILED: ${message}`);
      if (/429|RATE_LIMIT/i.test(message) && Date.now() - startedAt < budgetMs) {
        console.log("  Rate limited; cooling down 90s before the next case.");
        await new Promise((resolve) => setTimeout(resolve, 90_000));
      }
      rows.push({
        index: caseIndex,
        url,
        title: "",
        paragraphs: 0,
        sections: 0,
        readiness: 0,
        strictReady: false,
        recommendation: "",
        conflictsCritical: 0,
        conflictsMaterial: 0,
        conflictsMinor: 0,
        caseName: "",
        overallOutcome: "",
        reviewFlagCount: 0,
        elapsedMs,
        error: message,
      });
    }
  }

  const succeeded = rows.filter((row) => !row.error);
  const average = (select: (row: CaseMetrics) => number) =>
    succeeded.length ? Math.round(succeeded.reduce((sum, row) => sum + select(row), 0) / succeeded.length) : 0;
  const summary = [
    "# Nomologies V2 branch benchmark",
    "",
    `- Index: ${indexUrl}`,
    `- Cases attempted: ${rows.length} · succeeded: ${succeeded.length} · failed: ${rows.length - succeeded.length}`,
    `- Average readiness: ${average((row) => row.readiness)}/100`,
    `- Strict-ready: ${succeeded.filter((row) => row.strictReady).length}/${succeeded.length}`,
    `- Average sections: ${average((row) => row.sections)} · average time: ${average((row) => Math.round(row.elapsedMs / 1000))}s`,
    "",
    summaryTable(rows),
    "",
    `Generated: ${new Date().toISOString()}`,
  ].join("\n");

  await Deno.writeTextFile(`${OUTPUT_DIR}/summary.md`, summary);
  await Deno.writeTextFile(`${OUTPUT_DIR}/benchmark.json`, JSON.stringify({ indexUrl, rows }, null, 2));
  console.log(`\n${summary}`);
}
