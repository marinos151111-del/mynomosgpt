# My Nomos GPT

Production frontend for the rebuilt My Nomos legal workspace. This application is independent of the earlier Figma/MyNomosAI prototype.

## Product flow

- Home workspace and global navigation
- Workspaces and practice areas
- Nomologies V2 global search
- Single-link judgment intake
- Text/HTML upload and CyLaw index bulk intake
- Human review queue, live corpus, and system health

The interface contains no seeded or fallback demo cases. Search stays empty until real judgments are reviewed and published.

## Production architecture

- Next.js-compatible Sites application built with Vinext
- Owner-restricted access through the hosting platform
- Server-only proxy at `app/api/nomologies/[...path]/route.ts`
- Supabase V2 API, worker, Postgres schema, and private Storage buckets
- OpenAI-backed legal extraction pipeline
- Human approval required before a processed case enters the live corpus

The browser never receives the Nomologies gateway secret. The server proxy reads:

```text
NOMOLOGIES_API_URL
NOMOLOGIES_GATEWAY_KEY
```

Copy `.env.example` for local development and provide the gateway key through the runtime secret manager. Never commit it.

## Commands

- `npm run dev` — local preview
- `npm run build` — production build and artifact validation
- `npm run lint` — static checks
- `npm test` — build and rendered metadata tests

## Repository layout

This frontend is preserved under `apps/mynomos/` on the production application branch. The repository-root V2 engine and Supabase functions remain the backend source of truth.
