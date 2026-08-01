import Link from "next/link";
import type { ChatGPTUser } from "../chatgpt-auth";
import { chatGPTSignInPath, chatGPTSignOutPath } from "../chatgpt-auth";
import { BrandMark } from "./brand-mark";

type SiteHeaderProps = {
  user: ChatGPTUser | null;
  active?: "home" | "workspaces" | "nomologies";
};

export function SiteHeader({ user, active = "home" }: SiteHeaderProps) {
  return (
    <header className="site-header">
      <Link className="brand" href="/">
        <BrandMark />
        <span className="brand-words">
          <strong>MY NOMOS</strong>
          <small>LEGAL INTELLIGENCE</small>
        </span>
      </Link>

      <nav aria-label="Primary navigation">
        <Link className={active === "home" ? "active" : ""} href="/">Home</Link>
        <Link className={active === "workspaces" ? "active" : ""} href="/workspaces">Workspaces</Link>
        <Link className={active === "nomologies" ? "active" : ""} href="/workspaces/nomologies">Nomologies</Link>
      </nav>

      <div className="account-area">
        {user ? (
          <>
            <span className="account-name">{user.displayName}</span>
            <Link className="account-button" href={chatGPTSignOutPath("/")}>Sign out</Link>
          </>
        ) : (
          <Link className="account-button primary" href={chatGPTSignInPath("/")}>Sign in</Link>
        )}
      </div>
    </header>
  );
}
