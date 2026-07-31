(() => {
  const legacySubmit = typeof submit === "function" ? submit : null;
  if (legacySubmit) elements.form.removeEventListener("submit", legacySubmit);

  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  async function responsePayload(response) {
    const raw = await response.text();
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = null;
    }
    if (!payload || typeof payload !== "object") {
      throw new Error(`The backend returned HTTP ${response.status} without a valid response.`);
    }
    if (!response.ok) {
      const message = payload.message || payload.error?.message || `The backend returned HTTP ${response.status}.`;
      const error = new Error(message);
      error.code = payload.code || payload.error?.code || "BACKEND_ERROR";
      throw error;
    }
    return payload;
  }

  function applyServerProgress(job) {
    const progress = Math.max(3, Math.min(99, Number(job.progress || 0)));
    const stageIndex = progress < 15 ? 0 : progress < 38 ? 1 : progress < 62 ? 2 : progress < 83 ? 3 : 4;
    setProcessingStage(stageIndex, progress, job.stage || "Processing judgment");
    setServiceStatus("ready", job.status === "queued" ? "Job queued" : "1 active job");
  }

  async function pollJob(jobId, accessKey) {
    const deadline = Date.now() + 20 * 60 * 1000;
    let consecutiveNetworkErrors = 0;

    while (Date.now() < deadline) {
      try {
        const response = await fetch(`./api/jobs/${encodeURIComponent(jobId)}`, {
          method: "GET",
          headers: { "x-lab-key": accessKey },
          cache: "no-store",
        });
        const job = await responsePayload(response);
        consecutiveNetworkErrors = 0;
        applyServerProgress(job);

        if (job.status === "completed") {
          stopProgress(true);
          renderResult({
            ok: true,
            elapsedMs: Number(job.elapsedMs || 0),
            generatedAt: job.generatedAt || job.completedAt || new Date().toISOString(),
            result: job.result,
          });
          elements.parseButton.disabled = false;
          await checkHealth();
          return;
        }

        if (job.status === "failed") {
          const failure = job.error || {};
          throw new Error(failure.message || "The full extraction failed.");
        }
      } catch (error) {
        consecutiveNetworkErrors += 1;
        if (consecutiveNetworkErrors >= 5) throw error;
      }

      await sleep(2_000);
    }

    throw new Error("The extraction is still running after 20 minutes. Start a new test or inspect the backend logs.");
  }

  async function submitAsync(event) {
    event.preventDefault();
    const accessKey = elements.accessKey.value;
    if (!accessKey) {
      showError("Password required", "Enter the Pipeline Lab password.");
      return;
    }

    let payload;
    try {
      payload = buildPayload();
    } catch (error) {
      showError("Source required", error instanceof Error ? error.message : "Provide a judgment source.");
      return;
    }

    elements.parseButton.disabled = true;
    showState("processing");
    startProgress(payload.mode);

    try {
      const response = await fetch("./api/parse", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lab-key": accessKey,
        },
        body: JSON.stringify(payload),
      });
      const created = await responsePayload(response);

      if (created.result) {
        stopProgress(true);
        renderResult(created);
        elements.parseButton.disabled = false;
        return;
      }

      if (!created.jobId) throw new Error("The backend did not return an extraction job ID.");
      await pollJob(created.jobId, accessKey);
    } catch (error) {
      showError("Parse failed", error instanceof Error ? error.message : "The extraction failed.");
      await checkHealth();
    }
  }

  elements.form.addEventListener("submit", submitAsync);
})();
