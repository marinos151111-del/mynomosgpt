const $ = (selector) => document.querySelector(selector);

const elements = {
  form: $("#searchForm"),
  accessKey: $("#accessKey"),
  query: $("#query"),
  searchButton: $("#searchButton"),
  status: $("#status"),
  indexCount: $("#indexCount"),
  indexHint: $("#indexHint"),
  error: $("#error"),
  facets: $("#facets"),
  resultsTitle: $("#resultsTitle"),
  resultsMeta: $("#resultsMeta"),
  semanticBadge: $("#semanticBadge"),
  resultList: $("#resultList"),
  legalArea: $("#legalArea"),
  proceedingType: $("#proceedingType"),
  outcome: $("#outcome"),
  court: $("#court"),
  yearFrom: $("#yearFrom"),
  yearTo: $("#yearTo"),
};

function h(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setStatus(kind, text) {
  elements.status.className = `status ${kind || ""}`.trim();
  elements.status.querySelector("span").textContent = text;
}

function accessKey() {
  return elements.accessKey.value.trim();
}

function filters() {
  const output = {};
  for (const [key, value] of Object.entries({
    legalArea: elements.legalArea.value,
    proceedingType: elements.proceedingType.value,
    outcome: elements.outcome.value,
    court: elements.court.value.trim(),
    yearFrom: Number(elements.yearFrom.value) || undefined,
    yearTo: Number(elements.yearTo.value) || undefined,
  })) {
    if (value !== "" && value !== undefined) output[key] = value;
  }
  return output;
}

async function health() {
  try {
    const response = await fetch("./api/health", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error("health");
    elements.indexCount.textContent = String(payload.searchIndexSize || 0);
    elements.indexHint.textContent = payload.searchIndexSize
      ? "Ready for hybrid retrieval"
      : "Run Full Extraction to add cases";
    setStatus(payload.searchIndexSize ? "ready" : "", payload.searchIndexSize ? "Search index ready" : "Index empty");
  } catch {
    setStatus("error", "Backend unavailable");
  }
}

function showError(message) {
  elements.error.textContent = message;
  elements.error.classList.remove("hidden");
}

function clearError() {
  elements.error.classList.add("hidden");
  elements.error.textContent = "";
}

function scoreDisplay(hit, maximum) {
  if (!maximum) return "0";
  return String(Math.max(1, Math.min(100, Math.round(hit.score / maximum * 100))));
}

function breakdown(hit) {
  const row = hit.scoreBreakdown || {};
  const labels = [
    ["Exact", row.exactIdentity],
    ["Phrase", row.phrase],
    ["Lexical", row.lexical],
    ["Tags", row.smartTags],
    ["Semantic", row.semantic],
    ["Authority", row.authority],
  ];
  return labels
    .filter(([, value]) => Number(value) > 0.05)
    .map(([label, value]) => `<span>${h(label)} ${Math.round(Number(value) * 10) / 10}</span>`)
    .join("");
}

function resultCard(hit, maximum) {
  const doc = hit.document || {};
  const tags = Array.isArray(hit.matchedTags) ? hit.matchedTags.slice(0, 8) : [];
  const why = Array.isArray(hit.whyMatched) ? hit.whyMatched : [];
  const meta = [doc.court, doc.caseNumber || doc.citation, doc.decisionDate, doc.outcome]
    .filter(Boolean).join(" · ");
  return `<article class="case-card">
    <div class="case-top">
      <div>
        <div class="case-meta">${h(meta || "Νομολογία")}</div>
        <h3>${h(doc.shortTitle || doc.title || "Απόφαση")}</h3>
      </div>
      <div class="score" title="Relative relevance score">${scoreDisplay(hit, maximum)}</div>
    </div>
    <div class="snippet">${h(hit.snippet || "")}</div>
    ${tags.length ? `<div class="tags">${tags.map((tag) => `<span class="tag">${h(tag.label)}</span>`).join("")}</div>` : ""}
    <div class="why">
      ${why.length ? why.map((item) => `<div><b>✓</b> ${h(item)}</div>`).join("") : "<div>Evidence-weighted legal relevance</div>"}
      <div class="breakdown">${breakdown(hit)}</div>
    </div>
    ${doc.sourceUrl ? `<a class="open-source" href="${h(doc.sourceUrl)}" target="_blank" rel="noreferrer">Άνοιγμα επίσημης απόφασης ↗</a>` : ""}
  </article>`;
}

function facetGroup(title, rows) {
  if (!Array.isArray(rows) || !rows.length) return "";
  return `<section class="facet-group"><strong>${h(title)}</strong>${rows.slice(0, 10).map((row) => `<button type="button" class="facet-option" data-facet-value="${h(row.value)}"><span>${h(row.value)}</span><em>${h(row.count)}</em></button>`).join("")}</section>`;
}

function renderFacets(facets) {
  elements.facets.innerHTML = `<h2>Φίλτρα αποτελεσμάτων</h2>${[
    facetGroup("Νομικά πεδία", facets?.legalAreas),
    facetGroup("Διαδικασία", facets?.proceedingTypes),
    facetGroup("Δικαστήρια", facets?.courts),
    facetGroup("Δικαστές", facets?.judges),
    facetGroup("Έκβαση", facets?.outcomes),
    facetGroup("Νομοθεσία", facets?.lawIds),
    facetGroup("Έτος", facets?.years),
  ].filter(Boolean).join("") || '<div class="empty">Δεν υπάρχουν facet values για το ενεργό corpus.</div>'}`;
}

function render(payload) {
  const result = payload.result || {};
  const hits = Array.isArray(result.hits) ? result.hits : [];
  const maximum = Math.max(0, ...hits.map((hit) => Number(hit.score) || 0));
  elements.resultsTitle.textContent = hits.length ? `${hits.length} αποτελέσματα` : "Δεν βρέθηκαν αποτελέσματα";
  elements.resultsMeta.textContent = `${result.indexSize || 0} indexed cases · ${result.elapsedMs || 0} ms · intent: ${result.query?.intent || "general"}`;
  elements.semanticBadge.textContent = result.semanticUsed ? "Lexical + Semantic" : "Lexical + Smart Tags";
  elements.resultList.innerHTML = hits.length
    ? hits.map((hit) => resultCard(hit, maximum)).join("")
    : '<div class="empty"><b>Καμία ισχυρή αντιστοίχιση.</b>Δοκιμάστε αριθμό υπόθεσης, άρθρο νόμου, νομική αρχή ή πιο συγκεκριμένα πραγματικά γεγονότα.</div>';
  renderFacets(result.facets || {});
  elements.indexCount.textContent = String(result.indexSize || 0);
}

async function search() {
  clearError();
  const query = elements.query.value.trim();
  if (!accessKey()) return showError("Enter the Pipeline Lab password first.");
  if (!query) return showError("Enter a case number, legal principle, provision or factual scenario.");
  elements.searchButton.disabled = true;
  elements.searchButton.textContent = "Searching…";
  try {
    const response = await fetch("./api/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-lab-key": accessKey(),
      },
      body: JSON.stringify({ query, filters: filters(), semantic: true, limit: 30 }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.message || `Search failed with HTTP ${response.status}`);
    render(payload);
    history.replaceState(null, "", `#q=${encodeURIComponent(query)}`);
    setStatus("ready", "Search complete");
  } catch (error) {
    showError(error instanceof Error ? error.message : "Search failed.");
    setStatus("error", "Search failed");
  } finally {
    elements.searchButton.disabled = false;
    elements.searchButton.textContent = "Αναζήτηση";
  }
}

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  void search();
});

document.querySelectorAll(".example").forEach((button) => {
  button.addEventListener("click", () => {
    elements.query.value = button.textContent.trim();
    elements.query.focus();
  });
});

elements.accessKey.addEventListener("change", () => {
  if (accessKey()) sessionStorage.setItem("nomologies_lab_key", accessKey());
});

const savedKey = sessionStorage.getItem("nomologies_lab_key");
if (savedKey) elements.accessKey.value = savedKey;

const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
if (hash.get("q")) elements.query.value = hash.get("q");

void health();
setInterval(health, 20_000);
