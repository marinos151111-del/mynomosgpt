import Link from "next/link";
import { getChatGPTUser } from "./chatgpt-auth";
import { BrandMark } from "./components/brand-mark";
import { SiteHeader } from "./components/site-header";

const workspaces = [
  {
    eyebrow: "Case law",
    title: "Nomologies",
    description:
      "Evidence-grounded Cyprus judgments, global legal search and production intake.",
    href: "/workspaces/nomologies",
    accent: "wine",
    status: "V2 live",
  },
  {
    eyebrow: "Legislation",
    title: "Laws & Codes",
    description:
      "Consolidated laws, amendments, provisions and authority-linked research.",
    href: "/workspaces",
    accent: "ink",
    status: "Workspace",
  },
  {
    eyebrow: "Practice",
    title: "Legal Workspace",
    description:
      "Research, drafting and matter tools organised by Cyprus practice area.",
    href: "/workspaces",
    accent: "gold",
    status: "Workspace",
  },
];

export default async function Home() {
  const user = await getChatGPTUser();
  const firstName = user?.fullName?.split(/\s+/)[0] || "Marino";

  return (
    <main className="site-shell">
      <SiteHeader user={user} active="home" />

      <section className="home-hero">
        <div className="hero-copy">
          <p className="kicker">Cyprus legal intelligence</p>
          <h1>
            Good morning, <span>{firstName}.</span>
          </h1>
          <p className="hero-lede">
            Your legal research system is ready. Enter a workspace or search
            the verified case-law corpus.
          </p>

          <form action="/workspaces/nomologies" className="global-search">
            <BrandMark size="small" />
            <input
              aria-label="Search Cyprus law and case law"
              name="q"
              placeholder="Ask a Cyprus legal question or cite a case…"
            />
            <button type="submit" aria-label="Search">
              <span>Search</span>
              <span aria-hidden="true">↗</span>
            </button>
          </form>

          <div className="hero-meta" aria-label="System status">
            <span><i className="status-dot" /> Evidence-bound V2</span>
            <span>Official-source intake</span>
            <span>No demo cases</span>
          </div>
        </div>

        <aside className="daily-brief" aria-label="Daily legal brief">
          <div className="brief-head">
            <span>System brief</span>
            <time dateTime="2026-08-01">01 August 2026</time>
          </div>
          <div className="brief-mark"><BrandMark size="large" /></div>
          <h2>Production corpus</h2>
          <p>
            The corpus begins empty by design. Every published result must pass
            source, evidence and reviewer gates.
          </p>
          <dl>
            <div><dt>Engine</dt><dd>Nomologies V2</dd></div>
            <div><dt>Source</dt><dd>CyLaw · Official</dd></div>
            <div><dt>Storage</dt><dd>Private</dd></div>
          </dl>
        </aside>
      </section>

      <section className="workspace-section">
        <div className="section-heading">
          <div>
            <p className="kicker">Your desk</p>
            <h2>Workspaces</h2>
          </div>
          <Link href="/workspaces" className="text-link">View all workspaces <span>→</span></Link>
        </div>

        <div className="workspace-grid">
          {workspaces.map((workspace, index) => (
            <Link
              className={`workspace-card accent-${workspace.accent}`}
              href={workspace.href}
              key={workspace.title}
            >
              <div className="card-topline">
                <span>{String(index + 1).padStart(2, "0")}</span>
                <span className="workspace-status">{workspace.status}</span>
              </div>
              <p className="workspace-eyebrow">{workspace.eyebrow}</p>
              <h3>{workspace.title}</h3>
              <p>{workspace.description}</p>
              <span className="card-enter">Enter workspace <b>↗</b></span>
            </Link>
          ))}
        </div>
      </section>

      <footer className="site-footer">
        <BrandMark size="small" />
        <span>My Nomos GPT</span>
        <small>Evidence before assertion.</small>
      </footer>
    </main>
  );
}
