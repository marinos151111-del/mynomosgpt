# mynomosaigpt — Canonical Architecture Register

## Product identity

The single commercial product is **mynomosaigpt**.

“Nomologies V2” is an internal case-law engine. It is not a separate product or frontend.

## Confirmed components

| Layer | Location | Status |
|---|---|---|
| Live frontend | `https://mynomosgpt.marino-shalida180384.chatgpt.site/` | Current published application |
| Nomologies V2 source | `src/nomologies-v2/` | Core evidence-first legal extraction engine |
| Search source | `src/nomologies-search/` on production/search branches | Legal retrieval, concepts, tags and embeddings |
| Running backend | Supabase project `btfggtdysjgdjgmvqdbt` | Active |
| Running Nomologies API | Supabase Edge Function `nomologies-api` | Active |
| Running worker | Supabase Edge Function `nomologies-worker` | Active |
| Running search | Supabase Edge Function `nomologies-search` | Active |
| Legislation services | Supabase Edge Functions `legislation-*` | Active |

## Material finding: frontend source gap

The GitHub branch `agent/full-mynomos-production` contains an `apps/mynomos/` frontend, but that frontend is an English administrative console and does **not** match the current live lawyer-facing interface displayed at the ChatGPT Site URL.

Accordingly, that branch must not be declared the canonical live frontend or merged into `main` as though it were the current application.

The exact source of the current live ChatGPT Site must be exported or recovered and committed under a dedicated path such as:

```text
apps/mynomosaigpt/
```

Only after source parity is confirmed should the live frontend be connected to the canonical repository.

## Naming rule

- Product: `mynomosaigpt`
- Current GitHub repository holding backend and pipeline work: `marinos151111-del/mynomosgpt`
- Current live URL slug: `mynomosgpt`
- Do not use the deleted `my` repository.
- Do not use the separate experimental Site called `Nomologies Elite`.
- Do not describe V2 as another app.

## Target architecture

```text
apps/mynomosaigpt
Current lawyer-facing frontend source
        ↓
One documented server/API boundary
        ↓
Supabase project btfggtdysjgdjgmvqdbt
        ↓
Nomologies V2 + search + legislation + storage + database
```

## Safety rule

No branch, bucket, Edge Function, database object, or Site may be deleted merely because its name appears old. Retirement requires:

1. identification of all production references;
2. preservation of source in Git;
3. a verified replacement;
4. build and functional checks;
5. live parity verification; and
6. a recorded rollback point.
