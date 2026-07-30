# MyNomos GPT — Nomologies V2 Lab

Independent, section-first extraction pipeline for Cyprus judgments.

This repository is intentionally isolated from `MyNomosAI`. It contains no production corpus, Supabase project credentials, frontend code, or live deployment configuration.

## Purpose

The pipeline maps every judgment into legally meaningful sections before extracting identity, facts, procedure, holdings, ratio decidendi, legislation, authorities, outcomes, remedies, damages, sentence and costs. Every populated material field must carry exact paragraph-linked evidence.

## Safety

- Human-review-first; no automatic publication.
- `OPENAI_API_KEY` is read only from GitHub Actions or server environment secrets.
- No API key is committed to this repository.
- Tests operate on official HTTPS CyLaw judgments.

The first runnable test workflow will be available under **Actions → Test Nomologies V2 extraction**.
