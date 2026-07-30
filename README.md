# MyNomos GPT — Nomologies V2 Lab

Independent, section-first, evidence-grounded extraction for Cyprus judgments.

This repository is deliberately isolated from the original `MyNomosAI` repository. It contains no MyNomos frontend, production corpus, Supabase credentials, live storage configuration, database code, or production deployment configuration.

## Extraction coverage

The pipeline extracts:

- formal case name, short name, citation, ECLI, docket, case number and joined cases;
- court, date, judges, authoring judge, parties, procedural roles and advocates;
- case family, legal areas, proceeding type, procedural posture and court level;
- material facts, chronology, witnesses, documents, admissions and forensic evidence;
- procedural history, lower-court result, grounds, relief and each party's submissions;
- legal issues, findings, holding, ratio decidendi, legal principles, obiter and legal tests;
- legislation, articles, paragraphs and correct instrument ownership;
- cited authorities, treatment and the proposition for which each authority was used;
- overall and component outcomes, orders, remedies, sentence, damages, interest, VAT, costs and remittal.

Every populated material field must contain exact paragraph-linked evidence from a legally permissible section and speaker.

## Test through GitHub Actions

1. Open **Settings → Secrets and variables → Actions** in this repository.
2. Add a repository secret named exactly `OPENAI_API_KEY`.
3. Open **Actions → Test Nomologies V2 extraction → Run workflow**.
4. Start with `sections` to inspect the section and speaker map.
5. Run `full` only after the section map is satisfactory.
6. Download `nomologies-v2-report.html` and `nomologies-v2-result.json` from the workflow artifact.

The test can also be triggered by changing `.github/nomologies-v2-test-request.json`.

## Local test

```bash
export OPENAI_API_KEY='your-project-key'
export SOURCE_URL='https://www.cylaw.org/cgi-bin/open.pl?file=/supreme/2026/202601-30-16PolEf.html'
export PIPELINE_MODE='sections'
deno task test
```

Never commit API keys or put them in browser code.
