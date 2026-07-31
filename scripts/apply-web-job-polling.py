from pathlib import Path

app_path = Path("web/app.js")
app = app_path.read_text(encoding="utf-8")

old_state = '''const state = {
  sourceMode: "url",
  uploadedText: "",
  uploadedName: "",
  envelope: null,
  startedAt: 0,
  timer: null,
};'''
new_state = '''const state = {
  sourceMode: "url",
  uploadedText: "",
  uploadedName: "",
  envelope: null,
  startedAt: 0,
  timer: null,
  activeJobId: null,
  activeMode: null,
  pollToken: 0,
};'''
if old_state not in app:
    raise SystemExit("state block not found")
app = app.replace(old_state, new_state, 1)

old_render = '''function renderResult(envelope) {
  state.envelope = envelope;
  const result = envelope.result || {};
  if (result.mode === "sections") renderSectionsResult(envelope, result);
  else renderFullResult(envelope, result);
  showState("results");
}'''
new_render = '''function renderResult(envelope, expectedMode = state.activeMode) {
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
}'''
if old_render not in app:
    raise SystemExit("renderResult block not found")
app = app.replace(old_render, new_render, 1)

submit_start = app.index('async function submit(event) {')
reset_start = app.index('function resetLab() {', submit_start)
old_submit = app[submit_start:reset_start]
new_submit = r'''function sleep(milliseconds) {
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

'''
app = app[:submit_start] + new_submit + app[reset_start:]

old_reset = '''function resetLab() {
  stopProgress(false);
  state.envelope = null;
  elements.resultContent.innerHTML = "";
  elements.metricStrip.innerHTML = "";
  showState("empty");
  window.scrollTo({ top: 0, behavior: "smooth" });
}'''
new_reset = '''function resetLab() {
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
}'''
if old_reset not in app:
    raise SystemExit("resetLab block not found")
app = app.replace(old_reset, new_reset, 1)

app_path.write_text(app, encoding="utf-8")

index_path = Path("web/index.html")
index = index_path.read_text(encoding="utf-8")
old_note = '<div class="processing-note"><b>Do not close this tab.</b> A full extraction can take several minutes because every material field is independently verified.</div>'
new_note = '<div class="processing-note"><b>The job now runs independently on the server.</b> This page polls the active run every two seconds and will never display a result from an older Section Map test.</div>'
if old_note not in index:
    raise SystemExit("processing note not found")
index_path.write_text(index.replace(old_note, new_note, 1), encoding="utf-8")

print("Applied asynchronous job polling, run binding and stale-result protection.")
