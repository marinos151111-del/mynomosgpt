"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type View = "search" | "intake" | "bulk" | "review" | "corpus" | "system";
type JsonRecord = Record<string, unknown>;

type SearchCase = {
  case_id?: string;
  id?: string;
  title?: string;
  name?: string;
  short_title?: string;
  citation?: string;
  case_number?: string;
  decision_date?: string;
  court?: string;
  outcome?: string;
  readiness_score?: number;
  score?: number;
  matched_fields?: string[];
};

const navItems: Array<{ id: View; label: string; hint: string }> = [
  { id: "search", label: "Global search", hint: "Corpus" },
  { id: "intake", label: "New judgment", hint: "URL or text" },
  { id: "bulk", label: "Bulk intake", hint: "CyLaw index" },
  { id: "review", label: "Review queue", hint: "Evidence gate" },
  { id: "corpus", label: "Live corpus", hint: "Published" },
  { id: "system", label: "System health", hint: "Backend" },
];

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function asCases(value: unknown): SearchCase[] {
  return Array.isArray(value) ? (value as SearchCase[]) : [];
}

async function api(path: string, init?: RequestInit): Promise<JsonRecord> {
  const response = await fetch(`/api/nomologies/${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
    cache: "no-store",
  });
  const payload = asRecord(await response.json().catch(() => ({})));
  if (!response.ok || payload.ok === false) {
    throw new Error(String(payload.message || payload.code || `Request failed (${response.status})`));
  }
  return payload;
}

export function NomologiesConsole({ initialQuery = "" }: { initialQuery?: string }) {
  const [view, setView] = useState<View>(initialQuery ? "search" : "search");
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<SearchCase[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [health, setHealth] = useState<JsonRecord | null>(null);
  const [healthError, setHealthError] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [activity, setActivity] = useState<JsonRecord | null>(null);
  const [queue, setQueue] = useState<SearchCase[]>([]);
  const [corpus, setCorpus] = useState<SearchCase[]>([]);
  const [loadingList, setLoadingList] = useState(false);

  const runSearch = useCallback(async (searchText: string) => {
    const trimmed = searchText.trim();
    if (!trimmed) return;
    setSearching(true);
    setSearched(true);
    setError("");
    try {
      const payload = await api("search", {
        method: "POST",
        body: JSON.stringify({ query: trimmed, limit: 30 }),
      });
      setResults(asCases(payload.cases));
    } catch (cause) {
      setResults([]);
      setError(cause instanceof Error ? cause.message : "Search failed.");
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    api("health")
      .then((payload) => { setHealth(payload); setHealthError(""); })
      .catch((cause) => setHealthError(cause instanceof Error ? cause.message : "Backend unavailable."));
  }, []);

  useEffect(() => {
    if (!initialQuery) return;
    const timer = window.setTimeout(() => void runSearch(initialQuery), 0);
    return () => window.clearTimeout(timer);
  }, [initialQuery, runSearch]);

  async function loadCaseList(targetView: "review" | "corpus") {
    const status = targetView === "review" ? "review" : "published";
    setLoadingList(true);
    setError("");
    try {
      const payload = await api(`cases?status=${status}`);
      const rows = asCases(payload.cases);
      if (targetView === "review") setQueue(rows);
      else setCorpus(rows);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Cases could not be loaded.");
    } finally {
      setLoadingList(false);
    }
  }

  const backendReady = Boolean(health?.databaseConfigured && health?.openaiConfigured);
  const casesForView = view === "review" ? queue : corpus;

  function selectView(next: View) {
    setView(next);
    setError("");
    setNotice("");
    if (next === "review" || next === "corpus") void loadCaseList(next);
  }

  async function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runSearch(query);
  }

  async function submitIntake(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    const form = new FormData(event.currentTarget);
    const sourceUrl = String(form.get("sourceUrl") || "").trim();
    const sourceTitle = String(form.get("sourceTitle") || "").trim();
    const file = form.get("sourceFile");
    let text = String(form.get("text") || "").trim();
    if (file instanceof File && file.size) text = await file.text();
    if (!sourceUrl && !text) {
      setError("Add an official CyLaw judgment URL, paste the judgment text, or choose a text file.");
      return;
    }
    try {
      const payload = await api("intake", {
        method: "POST",
        body: JSON.stringify({ sourceUrl, sourceTitle, text }),
      });
      setActivity(payload);
      setNotice("Judgment accepted. The V2 evidence pipeline has started.");
      event.currentTarget.reset();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Intake failed.");
    }
  }

  async function submitBulk(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    const form = new FormData(event.currentTarget);
    const discoverUrl = String(form.get("discoverUrl") || "").trim();
    const name = String(form.get("name") || "").trim();
    if (!discoverUrl) {
      setError("Add the official CyLaw index URL to discover its judgments.");
      return;
    }
    try {
      const payload = await api("bulk/discover", {
        method: "POST",
        body: JSON.stringify({ discoverUrl, name }),
      });
      setActivity(payload);
      setNotice("Bulk batch created. Discovered judgments are now entering the production queue.");
      event.currentTarget.reset();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Bulk intake failed.");
    }
  }

  const activityId = useMemo(() => {
    if (!activity) return "";
    return String(activity.batchId || activity.batch_id || activity.runId || activity.run_id || activity.id || "");
  }, [activity]);

  return (
    <div className="nomologies-app">
      <aside className="nomologies-rail">
        <div className="rail-title">
          <p>Case-law workspace</p>
          <h1>Νομολογίες</h1>
          <span>Nomologies V2</span>
        </div>
        <nav aria-label="Nomologies tools">
          {navItems.map((item) => (
            <button
              className={view === item.id ? "active" : ""}
              key={item.id}
              onClick={() => selectView(item.id)}
              type="button"
            >
              <span>{item.label}</span>
              <small>{item.hint}</small>
            </button>
          ))}
        </nav>
        <div className="rail-status">
          <span className={backendReady ? "health-light ready" : "health-light"} />
          <div><strong>{backendReady ? "Production connected" : "Checking backend"}</strong><small>No seed data · private storage</small></div>
        </div>
      </aside>

      <section className="nomologies-main">
        {view === "search" && (
          <>
            <header className="console-heading">
              <p className="kicker">Global legal search</p>
              <h2>Search the verified corpus.</h2>
              <p>Exact identity, legal concepts, provisions, authorities, smart tags and semantic meaning—ranked together.</p>
            </header>
            <form className="corpus-search" onSubmit={submitSearch}>
              <input
                aria-label="Search the case-law corpus"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="e.g. intention in murder appeals, Cap. 113 s. 178, certiorari…"
                value={query}
              />
              <button disabled={searching} type="submit">{searching ? "Searching…" : "Search corpus"}</button>
            </form>
            <div className="search-guidance">
              <span>Case number</span><span>Greek or English</span><span>Natural-language issue</span><span>Provision or authority</span>
            </div>
            {error && <div className="console-message error">{error}</div>}
            {searched && !searching && !error && results.length === 0 && (
              <EmptyState title="No verified cases matched" text="The production corpus contains no fake or fallback results. Upload judgments through New judgment or Bulk intake." />
            )}
            {results.length > 0 && <CaseList cases={results} />}
          </>
        )}

        {view === "intake" && (
          <>
            <header className="console-heading compact">
              <p className="kicker">Official-source intake</p>
              <h2>Add one judgment.</h2>
              <p>Submit an official CyLaw URL or judgment text. Identity and legal conclusions are accepted only with paragraph-linked evidence.</p>
            </header>
            <form className="intake-form" onSubmit={submitIntake}>
              <label><span>Official CyLaw judgment URL</span><input name="sourceUrl" placeholder="https://www.cylaw.org/cgi-bin/open.pl?file=…" type="url" /></label>
              <label><span>Internal title <small>optional</small></span><input name="sourceTitle" placeholder="e.g. Supreme Court judgment — intake 001" /></label>
              <div className="form-divider"><span>or provide text</span></div>
              <label><span>Judgment text</span><textarea name="text" placeholder="Paste the full judgment text here…" rows={8} /></label>
              <label className="file-field"><span>Text or HTML file</span><input accept=".txt,.html,.htm,.md,.json,text/plain,text/html" name="sourceFile" type="file" /><small>PDF intake will be added through the document extraction route; do not convert evidence manually.</small></label>
              <button className="submit-intake" type="submit">Start V2 extraction <span>→</span></button>
            </form>
            <Feedback notice={notice} error={error} activityId={activityId} />
          </>
        )}

        {view === "bulk" && (
          <>
            <header className="console-heading compact">
              <p className="kicker">Production batch intake</p>
              <h2>Discover a CyLaw collection.</h2>
              <p>The system reads the official index, deduplicates source URLs and creates a staged extraction task for each judgment.</p>
            </header>
            <form className="intake-form bulk-form" onSubmit={submitBulk}>
              <label><span>CyLaw index URL</span><input name="discoverUrl" placeholder="https://www.cylaw.org/nomoi/… or official decisions index" type="url" /></label>
              <label><span>Batch name <small>optional</small></span><input name="name" placeholder="e.g. Supreme Court 2026 — batch 01" /></label>
              <div className="production-note"><strong>Production controls</strong><p>Maximum 2,500 judgments per batch. Duplicate sources are not republished. Storage and extracted artifacts remain private until reviewer approval.</p></div>
              <button className="submit-intake" type="submit">Discover and queue <span>→</span></button>
            </form>
            <Feedback notice={notice} error={error} activityId={activityId} />
          </>
        )}

        {(view === "review" || view === "corpus") && (
          <>
            <header className="console-heading compact">
              <p className="kicker">{view === "review" ? "Evidence gate" : "Published authorities"}</p>
              <h2>{view === "review" ? "Reviewer queue." : "Live corpus."}</h2>
              <p>{view === "review" ? "Cases remain outside global search until an authorised reviewer approves the evidence record." : "Only approved and published cases appear here and in global search."}</p>
            </header>
            {error && <div className="console-message error">{error}</div>}
            {loadingList ? <div className="loading-line">Reading production records…</div> : casesForView.length ? <CaseList cases={casesForView} /> : <EmptyState title={view === "review" ? "Review queue is empty" : "Live corpus is empty"} text={view === "review" ? "New extractions will appear here after the automated evidence checks finish." : "No case has yet passed the reviewer publication gate."} />}
          </>
        )}

        {view === "system" && (
          <>
            <header className="console-heading compact">
              <p className="kicker">Deployment status</p>
              <h2>Production health.</h2>
              <p>Frontend, database, private storage, AI extraction and the evidence pipeline are checked independently.</p>
            </header>
            <div className="health-grid">
              <HealthCard label="Supabase project" ready={Boolean(health?.databaseConfigured)} detail="Nomologies V2 Lab" />
              <HealthCard label="AI extraction" ready={Boolean(health?.openaiConfigured)} detail={String(health?.model || "Configured model")} />
              <HealthCard label="Private storage" ready={Boolean(health)} detail="Sources · artifacts · exports" />
              <HealthCard label="Gateway" ready={Boolean(health)} detail="Server-side owner access" />
            </div>
            {healthError && <div className="console-message error">{healthError}</div>}
            <div className="system-record"><span>Service</span><strong>{String(health?.service || "nomologies-api")}</strong><span>Project</span><strong>{String(health?.projectRef || "btfggtdysjgdjgmvqdbt")}</strong><span>Demo data</span><strong>Disabled</strong></div>
          </>
        )}
      </section>
    </div>
  );
}

function Feedback({ notice, error, activityId }: { notice: string; error: string; activityId: string }) {
  if (!notice && !error) return null;
  return <div className={`console-message ${error ? "error" : "success"}`}><strong>{error ? "Intake stopped" : "Accepted"}</strong><span>{error || notice}</span>{activityId && <small>Production reference: {activityId}</small>}</div>;
}

function HealthCard({ label, ready, detail }: { label: string; ready: boolean; detail: string }) {
  return <article className="health-card"><span className={ready ? "health-light ready" : "health-light"} /><div><p>{label}</p><strong>{ready ? "Operational" : "Not confirmed"}</strong><small>{detail}</small></div></article>;
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className="empty-state"><span>∅</span><h3>{title}</h3><p>{text}</p></div>;
}

function CaseList({ cases }: { cases: SearchCase[] }) {
  return <div className="case-list">{cases.map((item, index) => {
    const id = item.case_id || item.id || `${index}`;
    return <article className="case-result" key={id}>
      <div className="case-score"><strong>{Math.round(Number(item.score || item.readiness_score || 0))}</strong><span>{item.score ? "match" : "evidence"}</span></div>
      <div className="case-copy"><p>{item.court || "Cyprus court"} {item.decision_date ? `· ${item.decision_date}` : ""}</p><h3>{item.title || item.name || item.short_title || "Untitled judgment"}</h3><div><span>{item.citation || item.case_number || "Citation pending review"}</span>{item.outcome && <span>{item.outcome}</span>}</div>{Array.isArray(item.matched_fields) && item.matched_fields.length > 0 && <small>Matched: {item.matched_fields.join(" · ")}</small>}</div>
      <button aria-label={`Open ${item.title || item.name || "case"}`} type="button">→</button>
    </article>;
  })}</div>;
}
