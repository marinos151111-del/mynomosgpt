# mynomosaigpt — Consolidation Plan

This plan is deliberately non-destructive. It preserves the live service while converting the existing code and deployment into one auditable commercial asset.

## Phase 1 — Preserve and identify

- Record the single product name: `mynomosaigpt`.
- Preserve current Git history and Supabase deployment.
- Inventory the live Edge Functions, database schemas, buckets and frontend deployment.
- Identify the exact source of the current live ChatGPT Site.

## Phase 2 — Recover source

- Export the exact deployed Supabase Edge Function source into Git.
- Recover the current live frontend source and place it under `apps/mynomosaigpt/`.
- Preserve environment variable names in `.env.example` files without committing values.
- Generate a database migration/schema baseline.

## Phase 3 — Reconcile

- Compare Git source against deployed source by checksum and functionality.
- Select one Nomologies API, one worker and one search route.
- Select one legislation production route after regression testing.
- Classify remaining functions as production, canary, migration-only or retired.

## Phase 4 — Validate

- Build and type-check the frontend and backend.
- Test judgment intake, V2 extraction, search, case opening, legislation retrieval and publication.
- Confirm the live Site is deployed from the canonical commit.
- Record rollback tags.

## Phase 5 — Protect and commercialise

- Make the repository private.
- Complete contributor and IP assignments.
- Audit third-party licences.
- Tag a canonical production release.
- Prepare a buyer/investor technical and IP due-diligence pack.

## Prohibited shortcuts

- Do not replace the current frontend with an older GitHub prototype.
- Do not delete Supabase functions or buckets solely by name.
- Do not merge experimental branches into production without parity tests.
- Do not commit API keys, gateway keys or service-role credentials.
