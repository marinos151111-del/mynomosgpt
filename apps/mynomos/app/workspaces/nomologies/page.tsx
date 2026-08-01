import { getChatGPTUser } from "../../chatgpt-auth";
import { SiteHeader } from "../../components/site-header";
import { NomologiesConsole } from "./nomologies-console";

export const dynamic = "force-dynamic";

type NomologiesPageProps = {
  searchParams: Promise<{ q?: string }>;
};

export default async function NomologiesPage({ searchParams }: NomologiesPageProps) {
  const [user, query] = await Promise.all([
    getChatGPTUser(),
    searchParams.then((params) => params.q || ""),
  ]);

  return (
    <main className="site-shell nomologies-shell">
      <SiteHeader user={user} active="nomologies" />
      <NomologiesConsole initialQuery={query} />
    </main>
  );
}
