const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const elements = {
  form: $("#parseForm"),
  accessKey: $("#accessKey"),
  sourceUrl: $("#sourceUrl"),
  pastedTitle: $("#pastedTitle"),
  pastedText: $("#pastedText"),
  fileTitle: $("#fileTitle"),
  sourceFile: $("#sourceFile"),
  uploadZone: $("#uploadZone"),
  fileName: $("#fileName"),
  sourceSummary: $("#sourceSummary"),
  modeSummary: $("#modeSummary"),
  parseButton: $("#parseButton"),
  serviceStatus: $("#serviceStatus"),
  emptyState: $("#emptyState"),
  processingState: $("#processingState"),
  errorState: $("#errorState"),
  resultsState: $("#resultsState"),
  processingTitle: $("#processingTitle"),
  elapsedTime: $("#elapsedTime"),
  progressBar: $("#progressBar"),
  stageList: $("#stageList"),
  errorTitle: $("#errorTitle"),
  errorMessage: $("#errorMessage"),
  retryButton: $("#retryButton"),
  newParse: $("#newParse"),
  downloadJson: $("#downloadJson"),
  resultTitle: $("#resultTitle"),
  resultMeta: $("#resultMeta"),
  metricStrip: $("#metricStrip"),
  resultContent: $("#resultContent"),
};

const state = {
  sourceMode: "url",
  uploadedText: "",
  uploadedName: "",
  envelope: null,
  startedAt: 0,
  timer: null,
  activeJobId: null,
  activeMode: null,
  pollToken: 0,
};

function h(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function field(value) {
  return isObject(value) && typeof value.status === "string" && "value" in value
    ? value
    : { status: "unavailable", value: "", confidence: 0, evidence: [], conflicts: [] };
}

function fieldIsAvailable(value) {
  const row = field(value);
  if (row.status !== "available") return false;
  if (typeof row.value === "string") return row.value.trim().length > 0;
  if (Array.isArray(row.value)) return row.value.length > 0;
  return row.value !== null && row.value !== undefined;
}

function formatTime(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function showState(name) {
  for (const [key, node] of Object.entries({
    empty: elements.emptyState,
    processing: elements.processingState,
    error: elements.errorState,
    results: elements.resultsState,
  })) {
    const visible = key === name;
    node.hidden = !visible;
    node.style.display = visible ? "" : "none";
    node.setAttribute("aria-hidden", visible ? "false" : "true");
  }
  if (name === "results") {
    elements.errorTitle.textContent = "";
    elements.errorMessage.textContent = "";
  }
  const activeIndex = name === "empty" || name === "error" ? 0 : name === "processing" ? 1 : 2;
  $$(".step").forEach((node, index) => {
    node.classList.toggle("is-active", index === activeIndex);
    node.classList.toggle("is-complete", index < activeIndex);
  });
}

function setServiceStatus(kind, text) {
  elements.serviceStatus.className = `service-status is-${kind}`;
  elements.serviceStatus.querySelector("span").textContent = text;
}

async function checkHealth() {
  try {
    const response = await fetch("./api/health", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error("health failed");
    if (!payload.openaiConfigured || !payload.accessKeyConfigured) {
      const missing = [
        !payload.openaiConfigured ? "OpenAI key" : "",
        !payload.accessKeyConfigured ? "lab password" : "",
      ].filter(Boolean).join(" + ");
      setServiceStatus("error", `Missing ${missing}`);
      return;
    }
    setServiceStatus("ready", payload.activeJobs ? `${payload.activeJobs} active job` : "Backend ready");
  } catch {
    setServiceStatus("error", "Backend unavailable");
  }
}

function updateSummary() {
  const sourceLabels = { url: "CyLaw URL", paste: "Pasted text", file: state.uploadedName || "Uploaded file" };
  elements.sourceSummary.textContent = sourceLabels[state.sourceMode];
  const mode = new FormData(elements.form).get("mode") || "full";
  elements.modeSummary.textContent = mode === "sections" ? "Section map" : "Full extraction";
}

function selectSource(mode) {
  state.sourceMode = mode;
  $$(".source-tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.source === mode));
  $$(".source-pane").forEach((pane) => {
    const active = pane.dataset.pane === mode;
    pane.classList.toggle("is-active", active);
    pane.hidden = !active;
  });
  updateSummary();
}

async function loadFile(file) {
  if (!file) return;
  if (file.size > 2_000_000) {
    showError("File too large", "Use a TXT, HTML or JSON judgment file below 2 MB.");
    return;
  }
  const allowed = /\.(txt|html?|json)$/i.test(file.name);
  if (!allowed) {
    showError("Unsupported file", "This first Pipeline Lab build accepts TXT, HTML and JSON files. PDF and DOCX ingestion will be added after the core extraction benchmark is stable.");
    return;
  }
  state.uploadedText = await file.text();
  state.uploadedName = file.name;
  elements.fileName.textContent = `${file.name} · ${Math.ceil(file.size / 1024).toLocaleString()} KB`;
  if (!elements.fileTitle.value) elements.fileTitle.value = file.name.replace(/\.[^.]+$/, "");
  updateSummary();
}

function modeValue() {
  return String(new FormData(elements.form).get("mode") || "full");
}

function buildPayload() {
  const mode = modeValue() === "sections" ? "sections" : "full";
  if (state.sourceMode === "url") {
    const sourceUrl = elements.sourceUrl.value.trim();
    if (!sourceUrl) throw new Error("Paste an official CyLaw judgment URL.");
    return { sourceUrl, mode };
  }
  if (state.sourceMode === "paste") {
    const text = elements.pastedText.value.trim();
    if (!text) throw new Error("Paste the complete judgment text.");
    return { text, sourceTitle: elements.pastedTitle.value.trim() || "Pasted judgment", mode };
  }
  if (!state.uploadedText.trim()) throw new Error("Select a judgment file first.");
  let text = state.uploadedText;
  if (/\.json$/i.test(state.uploadedName)) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "string") text = parsed;
      else if (typeof parsed.text === "string") text = parsed.text;
      else if (typeof parsed.judgmentText === "string") text = parsed.judgmentText;
      else throw new Error("missing text");
    } catch {
      throw new Error("The JSON file must contain a text or judgmentText string.");
    }
  }
  if (/\.html?$/i.test(state.uploadedName)) {
    const document = new DOMParser().parseFromString(text, "text/html");
    text = document?.body?.innerText || text.replace(/<[^>]+>/g, " ");
  }
  return { text: text.trim(), sourceTitle: elements.fileTitle.value.trim() || state.uploadedName, mode };
}

function setProcessingStage(index, progress, title) {
  const items = [...elements.stageList.children];
  items.forEach((item, itemIndex) => {
    item.classList.toggle("is-complete", itemIndex < index);
    item.classList.toggle("is-active", itemIndex === index);
  });
  elements.progressBar.style.width = `${Math.max(5, Math.min(96, progress))}%`;
  elements.processingTitle.textContent = title;
}

function startProgress(mode) {
  state.startedAt = Date.now();
  clearInterval(state.timer);
  const schedule = mode === "sections"
    ? [
        [0, 8, "Preparing judgment source"],
        [1600, 25, "Assigning atomic passage IDs"],
        [4200, 52, "Recognising legal sections and speakers"],
        [11000, 76, "Reconciling overlapping section windows"],
        [19000, 90, "Finalising section map"],
      ]
    : [
        [0, 6, "Preparing judgment source"],
        [2200, 18, "Recognising legal sections and speakers"],
        [19000, 35, "Running specialist legal extractors"],
        [70000, 60, "Validating exact evidence anchors"],
        [135000, 79, "Running independent legal review"],
        [205000, 91, "Calculating readiness and conflicts"],
      ];

  state.timer = setInterval(() => {
    const elapsed = Date.now() - state.startedAt;
    elements.elapsedTime.textContent = formatTime(elapsed);
    let stageIndex = 0;
    let progress = 8;
    let title = schedule[0][2];
    schedule.forEach((entry, index) => {
      if (elapsed >= entry[0]) {
        stageIndex = mode === "sections" ? Math.min(index, 4) : Math.min(index, 4);
        progress = entry[1];
        title = entry[2];
      }
    });
    if (mode === "sections" && stageIndex >= 2) stageIndex = 1;
    if (mode === "sections" && elapsed > 13000) stageIndex = 3;
    if (mode === "sections" && elapsed > 20000) stageIndex = 4;
    setProcessingStage(stageIndex, progress, title);
  }, 500);
}

function stopProgress(success = false) {
  clearInterval(state.timer);
  state.timer = null;
  if (success) {
    elements.progressBar.style.width = "100%";
    [...elements.stageList.children].forEach((item) => {
      item.classList.add("is-complete");
      item.classList.remove("is-active");
    });
  }
}

function showError(title, message) {
  stopProgress(false);
  elements.errorTitle.textContent = title;
  elements.errorMessage.textContent = message;
  showState("error");
  elements.parseButton.disabled = false;
}

function statusPill(status) {
  const safe = ["available", "unavailable", "indeterminate", "conflicted"].includes(status) ? status : "indeterminate";
  return `<span class="status-pill status-${safe}">${h(safe)}</span>`;
}

function evidenceHtml(rawField) {
  const row = field(rawField);
  const evidence = Array.isArray(row.evidence) ? row.evidence : [];
  if (!evidence.length) return "";
  return `<details class="evidence-details"><summary>${evidence.length} exact evidence anchor${evidence.length === 1 ? "" : "s"}</summary><div class="evidence-list">${evidence.map((anchor) => {
    const ids = Array.isArray(anchor.paragraphIds) ? anchor.paragraphIds.join(", ") : "";
    return `<article class="evidence-item"><code>${h(ids)} · ${h(anchor.sectionType || "")}${anchor.speakerRole ? ` · ${h(anchor.speakerRole)}` : ""}</code><blockquote>“${h(anchor.quote || "")}”</blockquote></article>`;
  }).join("")}</div></details>`;
}

function plainValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    if (!value.length) return "—";
    if (value.every((item) => typeof item === "string")) return value.join(" · ");
    return JSON.stringify(value, null, 2);
  }
  if (isObject(value)) return JSON.stringify(value, null, 2);
  return String(value);
}

function detail(label, rawField, wide = false) {
  const row = field(rawField);
  return `<div class="detail${wide ? " wide" : ""}"><label>${h(label)} · ${statusPill(row.status)}</label><div class="value">${h(plainValue(row.value))}</div>${evidenceHtml(row)}</div>`;
}

function resultSection(title, subtitle, body) {
  return `<section class="result-section"><header><h3>${h(title)}</h3><span>${h(subtitle || "")}</span></header><div class="result-section-body">${body}</div></section>`;
}

function itemCards(items, renderer, empty = "No populated items.") {
  if (!Array.isArray(items) || !items.length) return `<div class="list-card"><p>${h(empty)}</p></div>`;
  return `<div class="list-cards">${items.map(renderer).join("")}</div>`;
}

function fieldList(title, rawField, renderer, subtitle = "") {
  const row = field(rawField);
  return resultSection(title, subtitle || `${row.status} · ${Math.round(Number(row.confidence || 0) * 100)}% confidence`, `${itemCards(Array.isArray(row.value) ? row.value : [], renderer)}${evidenceHtml(row)}`);
}

function sectionMapHtml(map) {
  const spans = Array.isArray(map?.spans) ? map.spans : [];
  return resultSection("Section map", `${spans.length} legal spans`, `<div class="table-wrap"><table><thead><tr><th>Passages</th><th>Section</th><th>Speaker</th><th>Quoted</th><th>Confidence</th><th>Heading</th><th>Rationale</th></tr></thead><tbody>${spans.map((span) => `<tr><td><code>${h(span.startParagraphId)}–${h(span.endParagraphId)}</code></td><td><b>${h(span.sectionType)}</b></td><td>${h(span.speakerRole)}</td><td>${span.isQuotedMaterial ? h(span.quotedSourceType || "yes") : "no"}</td><td>${Math.round(Number(span.confidence || 0) * 100)}%</td><td>${h(span.heading || "—")}</td><td>${h(span.rationale || "")}</td></tr>`).join("")}</tbody></table></div>`);
}

function metric(label, value, kind = "") {
  return `<div class="metric${kind ? ` is-${kind}` : ""}"><span>${h(label)}</span><b>${h(value)}</b></div>`;
}

function renderSectionsResult(envelope, result) {
  const source = result.source || {};
  const map = result.sectionMap || {};
  elements.resultTitle.textContent = source.sourceTitle || "Section recognition result";
  elements.resultMeta.textContent = `${source.paragraphs?.length || 0} passages · ${(source.characterCount || 0).toLocaleString()} characters · ${Math.round(envelope.elapsedMs / 100) / 10}s`;
  elements.metricStrip.innerHTML = [
    metric("Coverage", map.coverageComplete ? "Complete" : "Incomplete", map.coverageComplete ? "good" : "bad"),
    metric("Overlap", map.overlapFree ? "None" : "Detected", map.overlapFree ? "good" : "bad"),
    metric("Sections", String(map.spans?.length || 0)),
    metric("Review flags", String(map.reviewFlags?.length || 0), map.reviewFlags?.length ? "warn" : "good"),
    metric("Elapsed", `${Math.round(envelope.elapsedMs / 100) / 10}s`),
  ].join("");
  elements.resultContent.innerHTML = sectionMapHtml(map) + resultSection("Review flags", `${map.reviewFlags?.length || 0} flags`, itemCards(map.reviewFlags || [], (flag) => `<article class="list-card"><b>${h(flag)}</b></article>`, "No structural review flags.")) + resultSection("Raw structured result", "Developer view", `<pre class="raw-json">${h(JSON.stringify(result, null, 2))}</pre>`);
}

function renderFullResult(envelope, result) {
  const record = result.record || {};
  const source = record.source || {};
  const identity = record.identity || {};
  const classification = record.classification || {};
  const facts = record.facts || {};
  const procedure = record.procedure || {};
  const analysis = record.analysis || {};
  const authorities = record.authorities || {};
  const outcome = record.outcome || {};
  const conflicts = Array.isArray(record.conflicts) ? record.conflicts : [];
  const evidence = Array.isArray(record.allEvidence) ? record.allEvidence : [];
  const map = record.sectionMap || {};

  const caseName = field(identity.caseName).value || source.sourceTitle || "Judgment extraction";
  elements.resultTitle.textContent = caseName;
  elements.resultMeta.textContent = `${field(identity.court).value || "Court unavailable"} · ${field(identity.decisionDate).value || "Date unavailable"} · ${Math.round(envelope.elapsedMs / 100) / 10}s`;
  const readiness = Number(record.readinessScore || 0);
  elements.metricStrip.innerHTML = [
    metric("Readiness", `${readiness}/100`, readiness >= 90 ? "good" : readiness >= 70 ? "warn" : "bad"),
    metric("Strict-ready", record.strictReady ? "Yes" : "No", record.strictReady ? "good" : "warn"),
    metric("Evidence", String(evidence.length), evidence.length ? "good" : "bad"),
    metric("Conflicts", String(conflicts.length), conflicts.some((item) => item.severity === "critical") ? "bad" : conflicts.length ? "warn" : "good"),
    metric("Sections", String(map.spans?.length || 0)),
  ].join("");

  const identityBody = `<div class="detail-grid">
    ${detail("Formal case name", identity.caseName, true)}
    ${detail("Short name", identity.shortName)}
    ${detail("Case number", identity.caseNumber)}
    ${detail("Court", identity.court)}
    ${detail("Decision date", identity.decisionDate)}
    ${detail("Jurisdiction", identity.jurisdiction)}
    ${detail("Judges", identity.judges, true)}
    ${detail("Authoring judge(s)", identity.authoringJudges)}
    ${detail("Parties", identity.parties, true)}
    ${detail("Appearances", identity.appearances, true)}
    ${detail("Case family", classification.caseFamily)}
    ${detail("Primary legal area", classification.primaryLegalArea)}
    ${detail("Legal areas", classification.legalAreas)}
    ${detail("Proceeding type", classification.proceedingType)}
    ${detail("Procedural posture", classification.proceduralPosture)}
    ${detail("Subject matter", classification.subjectMatter, true)}
  </div>`;

  const factsBody = `<div class="detail-grid">
    ${detail("Πραγματικά γεγονότα / Facts summary", facts.summary, true)}
    ${detail("Procedural history", procedure.proceduralHistory, true)}
    ${detail("Originating proceeding", procedure.originatingProceeding, true)}
    ${detail("Lower-court decision", procedure.lowerCourtDecision, true)}
    ${detail("Disputed facts", facts.disputedFacts, true)}
    ${detail("Undisputed facts", facts.undisputedFacts, true)}
  </div>`;

  const analysisBody = `<div class="detail-grid">
    ${detail("Κυρίαρχη νομική αρχή", analysis.legalPrincipleSummary, true)}
    ${detail("Holding / Κρίση", analysis.holding, true)}
    ${detail("Dominant issue", analysis.dominantIssue, true)}
    ${detail("Legal tests and standards", analysis.legalTestsAndStandards, true)}
    ${detail("Credibility findings", analysis.credibilityFindings, true)}
  </div>`;

  const outcomeBody = `<div class="detail-grid">
    ${detail("Overall outcome", outcome.overallOutcome)}
    ${detail("Scope", outcome.scope)}
    ${detail("Operative disposition", outcome.dispositionText, true)}
    ${detail("Orders", outcome.orders, true)}
    ${detail("Remedies", outcome.remedies, true)}
    ${detail("Costs", outcome.costs, true)}
    ${detail("Monetary awards", outcome.monetaryAwards, true)}
    ${detail("Remittal instructions", outcome.remittalInstructions, true)}
  </div>`;

  const conflictHtml = conflicts.length
    ? conflicts.map((item) => `<article class="conflict"><strong class="severity-${h(item.severity)}">${h(item.severity)}</strong><div><b>${h(item.code || "Conflict")}</b><p>${h(item.message || "")}</p><code>${h(item.fieldPath || "")}</code></div></article>`).join("")
    : `<article class="list-card"><p>No conflicts returned.</p></article>`;

  elements.resultContent.innerHTML = [
    resultSection("Identity and classification", "Case metadata", identityBody),
    resultSection("Facts and procedure", "Narrative separated from submissions and outcome", factsBody),
    fieldList("Material facts", facts.materialFacts, (item) => `<article class="list-card"><b>${h(item.fact || "")}</b><p>${h(item.significance || "")}</p></article>`),
    fieldList("Chronology", facts.chronology, (item) => `<article class="list-card"><b>${h(item.date || "Date unavailable")}</b><p>${h(item.event || "")}</p><small>${h((item.actors || []).join(" · "))}</small></article>`),
    fieldList("Witnesses and evidence", facts.witnessesAndEvidence, (item) => `<article class="list-card"><b>${h(item.name || item.type || "Evidence")}</b><p>${h(item.summary || "")}</p><small>Court treatment: ${h(item.treatmentByCourt || "—")}</small></article>`),
    fieldList("Grounds and issues", procedure.groundsOrIssues, (item) => `<article class="list-card"><b>${h(item.number ? `Ground ${item.number}: ${item.title || ""}` : item.title || "Issue")}</b><p>${h(item.description || "")}</p><small>Raised by ${h(item.raisedBy || "—")} · Result: ${h(item.result || "unknown")}</small></article>`),
    fieldList("Party submissions", procedure.submissionsByParty, (item) => `<article class="list-card"><b>${h(item.party || "Party")}</b><p>${h(item.summary || "")}</p></article>`),
    resultSection("Judicial analysis", "Present court only", analysisBody),
    fieldList("Legal issues determined", analysis.legalIssues, (item) => `<article class="list-card"><b>${h(item.issue || "")}</b><p>${h(item.determination || "")}</p><small>${h(item.centrality || "")}</small></article>`),
    fieldList("Ratio decidendi", analysis.ratioDecidendi, (item) => `<article class="list-card"><b>${h(item.principle || "")}</b><p>${h(item.applicationToFacts || "")}</p><small>Conditions: ${h((item.conditions || []).join(" · ") || "—")} · Exceptions: ${h((item.exceptions || []).join(" · ") || "—")}</small></article>`),
    fieldList("Secondary legal principles", analysis.secondaryPrinciples, (item) => `<article class="list-card"><b>${h(item.principle || "")}</b><p>${h(item.applicationToFacts || "")}</p><small>${h(item.type || "")}</small></article>`),
    fieldList("Judicial findings", analysis.findings, (item) => `<article class="list-card"><b>${h(item.finding || "")}</b><small>${h(item.type || "")}</small></article>`),
    fieldList("Legislation and provisions", authorities.legislation, (item) => `<article class="list-card"><b>${h(item.instrumentName || item.lawLabel || item.lawId || "Instrument")}</b><p>${h(item.proposition || "")}</p><small>${h(item.role || "")} · ${item.primary ? "Primary" : "Secondary"} · ${h((item.provisions || []).map((provision) => provision.display || provision.article).filter(Boolean).join(" · ") || "No provision")}</small></article>`),
    fieldList("Cited authorities", authorities.authorities, (item) => `<article class="list-card"><b>${h(item.name || "Authority")}</b><p>${h(item.legalPoint || "")}</p><small>${h(item.citation || "")} · ${h(item.treatment || "unknown")} · ${h(item.citationContext || "unknown context")}</small></article>`),
    resultSection("Outcome, orders and money", "Operative result", outcomeBody),
    fieldList("Component outcomes", outcome.components, (item) => `<article class="list-card"><b>${h(item.target || item.groundOrIssue || "Component")}</b><p>${h(item.orderText || item.remedy || "")}</p><small>${h(item.result || "unknown")}</small></article>`),
    resultSection("Conflicts and review gate", `${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}`, conflictHtml),
    sectionMapHtml(map),
    resultSection("Raw structured result", "Developer view", `<pre class="raw-json">${h(JSON.stringify(result, null, 2))}</pre>`),
  ].join("");
}

function renderResult(envelope, expectedMode = state.activeMode) {
  const result = envelope?.result || {};
  if (!result.mode || (expectedMode && result.mode !== expectedMode)) {
    const error = new Error(`The backend returned ${result.mode || "unknown"} output for the active ${expectedMode || "unknown"} run.`);
    error.code = "STALE_OR_MISMATCHED_RESULT";
    throw error;
  }
  state.envelope = envelope;
  if (result.mode === "sections") renderSectionsResult(envelope, result);
  else renderFullResult(envelope, result);
  showState("results");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    const error = new Error(`The backend returned HTTP ${response.status} without a valid JSON response.`);
    error.code = "INVALID_BACKEND_RESPONSE";
    throw error;
  }
}

function jobStageIndex(progress) {
  const value = Number(progress || 0);
  if (value < 15) return 0;
  if (value < 38) return 1;
  if (value < 66) return 2;
  if (value < 84) return 3;
  return 4;
}

function applyJobProgress(job) {
  const progress = Math.max(2, Math.min(99, Number(job.progress || 2)));
  const elapsed = Number(job.elapsedMs || (Date.now() - state.startedAt));
  elements.elapsedTime.textContent = formatTime(elapsed);
  setProcessingStage(jobStageIndex(progress), progress, job.stage || "Extraction is running");
  setServiceStatus("ready", job.status === "running" ? "1 active job" : "Backend ready");
}

async function pollJob({ jobId, pollUrl, accessKey, mode, token }) {
  const started = Date.now();
  let consecutiveNetworkFailures = 0;
  const clientDeadlineMs = 13 * 60 * 1000;

  while (token === state.pollToken && state.activeJobId === jobId) {
    if (Date.now() - started > clientDeadlineMs) {
      const error = new Error("The backend did not finalise the extraction within 13 minutes. The active job was stopped instead of leaving the page waiting indefinitely.");
      error.code = "JOB_CLIENT_DEADLINE";
      throw error;
    }

    let response;
    try {
      response = await fetch(pollUrl || `./api/jobs/${encodeURIComponent(jobId)}`, {
        method: "GET",
        headers: { "x-lab-key": accessKey },
        cache: "no-store",
      });
      consecutiveNetworkFailures = 0;
    } catch (error) {
      consecutiveNetworkFailures += 1;
      if (consecutiveNetworkFailures >= 8) {
        const failure = new Error("The page lost contact with the extraction backend. No stale result was displayed.");
        failure.code = "JOB_POLL_NETWORK_FAILURE";
        throw failure;
      }
      await sleep(Math.min(5000, 800 * consecutiveNetworkFailures));
      continue;
    }

    const job = await responseJson(response);
    if (!response.ok || !job.ok) {
      const error = new Error(job.message || `Job polling returned HTTP ${response.status}.`);
      error.code = job.code || "JOB_POLL_FAILED";
      throw error;
    }
    if (job.jobId !== jobId || job.mode !== mode) {
      const error = new Error("The backend returned status for a different run. The result was rejected rather than mixing runs.");
      error.code = "JOB_ID_OR_MODE_MISMATCH";
      throw error;
    }
    if (token !== state.pollToken || state.activeJobId !== jobId) return;

    applyJobProgress(job);

    if (job.status === "completed") {
      if (!job.result || job.result.mode !== mode) {
        const error = new Error("The completed job returned a stale or mismatched extraction result.");
        error.code = "COMPLETED_JOB_RESULT_MISMATCH";
        throw error;
      }
      const envelope = {
        ok: true,
        jobId,
        mode,
        elapsedMs: Number(job.elapsedMs || 0),
        generatedAt: job.generatedAt || job.completedAt || new Date().toISOString(),
        result: job.result,
      };
      stopProgress(true);
      renderResult(envelope, mode);
      state.activeJobId = null;
      state.activeMode = null;
      return;
    }

    if (job.status === "failed" || job.status === "cancelled") {
      const error = new Error(job.error?.message || `The extraction job ended with status ${job.status}.`);
      error.code = job.error?.code || job.status.toUpperCase();
      state.activeJobId = null;
      state.activeMode = null;
      throw error;
    }

    await sleep(1800);
  }
}

async function cancelActiveJob() {
  const jobId = state.activeJobId;
  const accessKey = elements.accessKey.value;
  if (!jobId || !accessKey) return;
  try {
    await fetch(`./api/jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
      headers: { "x-lab-key": accessKey },
      cache: "no-store",
    });
  } catch {
    // Resetting the page must not block on cancellation transport.
  }
}

async function submit(event) {
  event.preventDefault();
  const accessKey = elements.accessKey.value;
  if (!accessKey) {
    showError("Password required", "Enter the LAB_ACCESS_KEY configured on the deployment.");
    return;
  }

  let payload;
  try {
    payload = buildPayload();
  } catch (error) {
    showError("Intake incomplete", error.message || String(error));
    return;
  }

  state.pollToken += 1;
  const token = state.pollToken;
  state.activeJobId = null;
  state.activeMode = payload.mode;
  state.envelope = null;
  elements.resultContent.innerHTML = "";
  elements.metricStrip.innerHTML = "";
  elements.parseButton.disabled = true;
  showState("processing");
  startProgress(payload.mode);

  try {
    const response = await fetch("./api/jobs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lab-key": accessKey,
      },
      body: JSON.stringify(payload),
    });
    const created = await responseJson(response);
    if (!response.ok || !created.ok) {
      const error = new Error(created.message || `The backend returned HTTP ${response.status}.`);
      error.code = created.code || "JOB_CREATION_FAILED";
      throw error;
    }
    if (!created.jobId || created.mode !== payload.mode) {
      const error = new Error("The backend did not create a valid job for the selected extraction mode.");
      error.code = "INVALID_JOB_RECEIPT";
      throw error;
    }

    state.activeJobId = created.jobId;
    state.activeMode = payload.mode;
    await pollJob({
      jobId: created.jobId,
      pollUrl: created.pollUrl || `./api/jobs/${encodeURIComponent(created.jobId)}`,
      accessKey,
      mode: payload.mode,
      token,
    });
  } catch (error) {
    if (token === state.pollToken) {
      state.activeJobId = null;
      state.activeMode = null;
      showError(error.code || "Parse failed", error.message || String(error));
    }
  } finally {
    if (token === state.pollToken) {
      elements.parseButton.disabled = false;
      checkHealth();
    }
  }
}

function resetLab() {
  void cancelActiveJob();
  state.pollToken += 1;
  state.activeJobId = null;
  state.activeMode = null;
  stopProgress(false);
  state.envelope = null;
  elements.resultContent.innerHTML = "";
  elements.metricStrip.innerHTML = "";
  showState("empty");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function downloadCurrentJson() {
  if (!state.envelope) return;
  const source = state.envelope.result?.mode === "full"
    ? state.envelope.result.record?.identity?.shortName?.value
    : state.envelope.result?.source?.sourceTitle;
  const filename = String(source || "nomologies-v2-result")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9Α-Ωα-ω]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "nomologies-v2-result";
  const blob = new Blob([JSON.stringify(state.envelope, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${filename}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

$$(".source-tab").forEach((tab) => tab.addEventListener("click", () => selectSource(tab.dataset.source)));
$$('input[name="mode"]').forEach((input) => input.addEventListener("change", () => {
  $$(".mode-option").forEach((option) => option.classList.toggle("is-selected", option.contains(input) && input.checked));
  updateSummary();
}));
elements.sourceFile.addEventListener("change", () => loadFile(elements.sourceFile.files?.[0]));
elements.uploadZone.addEventListener("dragover", (event) => { event.preventDefault(); elements.uploadZone.classList.add("is-dragging"); });
elements.uploadZone.addEventListener("dragleave", () => elements.uploadZone.classList.remove("is-dragging"));
elements.uploadZone.addEventListener("drop", (event) => {
  event.preventDefault();
  elements.uploadZone.classList.remove("is-dragging");
  const file = event.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});
elements.form.addEventListener("submit", submit);
elements.retryButton.addEventListener("click", resetLab);
elements.newParse.addEventListener("click", resetLab);
elements.downloadJson.addEventListener("click", downloadCurrentJson);

updateSummary();
showState("empty");
checkHealth();
setInterval(checkHealth, 30000);
