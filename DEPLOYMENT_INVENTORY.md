# mynomosaigpt — Deployment Inventory

Snapshot date: 13 August 2026

## Supabase project

- Name: `Nomologies V2 Lab`
- Project ref: `btfggtdysjgdjgmvqdbt`
- Region: `eu-central-1`
- Status: active and healthy

The project name is historical. It does not create a separate product. The commercial product remains `mynomosaigpt`.

## Active Edge Functions

| Function | Role | Current treatment |
|---|---|---|
| `nomologies-health` | Health/status endpoint | Keep |
| `nomologies-intake` | Judgment intake | Keep |
| `nomologies-worker` | Durable V2 pipeline worker | Keep |
| `nomologies-api` | Nomologies API and case administration | Keep |
| `nomologies-search` | Case-law search | Keep |
| `nomologies-reset-current-manifest` | Operational recovery/reset function | Keep pending security review |
| `legislation-api` | Existing legislation service | Keep pending consolidation review |
| `legislation-answer-original-canary` | Legislation canary | Test/canary; do not delete until production routing is verified |
| `legislation-api-next` | Newer legislation service | Keep pending production routing review |
| `make-server-3acdf682` | Historical Make server | Unclassified; do not delete until all frontend and storage references are traced |

## Required reconciliation

For every active function:

1. recover the exact deployed source;
2. compare it to GitHub;
3. commit any missing source under `supabase/functions/<function>/`;
4. record environment variable names without values;
5. run build/type checks;
6. designate one production route; and
7. retire duplicates only after live traffic and frontend references are confirmed.

## Frontend deployment

- Live URL: `https://mynomosgpt.marino-shalida180384.chatgpt.site/`
- Exact live source repository path: not yet verified
- Historical Sites project ID found in a candidate branch: `appgprj_6a6d9de2b0588191908a26b979334811`

The candidate GitHub frontend under `apps/mynomos/` does not visually match the current live lawyer-facing frontend. It must not be substituted for the live application without parity review.

## No-deletion rule

This inventory is a preservation step. It authorises no deletion of functions, buckets, schemas or Sites. Deletion requires a separate reference and rollback review.
