import Link from "next/link";
import { getChatGPTUser } from "../chatgpt-auth";
import { SiteHeader } from "../components/site-header";

const practiceAreas = [
  ["Criminal", "Criminal Code, procedure and sentencing"],
  ["Civil Litigation", "Civil Procedure Rules 2023 and authorities"],
  ["Corporate", "Companies Law, governance and transactions"],
  ["Tax", "Income tax, VAT, SDC and 2026 reform"],
  ["Property", "Land, title, contracts and specific performance"],
  ["Family", "Marriage, custody, maintenance and estates"],
  ["Immigration", "Residence, citizenship and free movement"],
  ["Employment", "Employment rights, dismissal and social insurance"],
];

export default async function WorkspacesPage() {
  const user = await getChatGPTUser();
  return (
    <main className="site-shell interior-shell">
      <SiteHeader user={user} active="workspaces" />
      <section className="interior-hero">
        <div>
          <p className="kicker">Research architecture</p>
          <h1>Legal workspaces</h1>
          <p>Choose the body of law first. The system keeps sources, tools and matter history within that legal context.</p>
        </div>
        <Link className="primary-action" href="/workspaces/nomologies">Open Nomologies <span>↗</span></Link>
      </section>

      <section className="practice-grid" aria-label="Practice areas">
        {practiceAreas.map(([title, description], index) => (
          <article className="practice-card" key={title}>
            <span className="practice-number">{String(index + 1).padStart(2, "0")}</span>
            <div>
              <h2>{title}</h2>
              <p>{description}</p>
            </div>
            <span className="practice-arrow" aria-hidden="true">→</span>
          </article>
        ))}
      </section>

      <section className="nomologies-banner">
        <div>
          <p className="kicker">Case-law engine</p>
          <h2>Nomologies V2</h2>
          <p>Search, intake, review and publish Cyprus judgments through one evidence-controlled corpus.</p>
        </div>
        <Link href="/workspaces/nomologies">Enter production system <span>→</span></Link>
      </section>
    </main>
  );
}
