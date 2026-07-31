# Deploy the Nomologies V2 Pipeline Lab

The repository now contains a normal dynamic web application:

```text
server.ts
web/index.html
web/app.js
web/styles.css
```

It serves both the browser interface and the server-side parsing API. The OpenAI key is never sent to the browser.

## Deno Deploy

1. Open `https://console.deno.com` and sign in.
2. Create an organization if the account does not already have one.
3. Select **New App**.
4. Connect the GitHub repository:

   ```text
   marinos151111-del/mynomosgpt
   ```

5. Use the repository root as the application directory.
6. The `deno.json` file configures a dynamic deployment with `server.ts` as the entrypoint.
7. Add these environment variables to both Production and Development contexts:

   ```text
   OPENAI_API_KEY=<your OpenAI project API key>
   LAB_ACCESS_KEY=<a strong password used to open the parse endpoint>
   NOMOLOGIES_V2_MODEL=gpt-5.4-mini
   ```

   `NOMOLOGIES_V2_MODEL` is optional. It is pinned for predictable test performance; remove it to let the pipeline choose an available model automatically.

8. Create the app and wait for the first build to complete.
9. Open the deployment URL returned by Deno Deploy.
10. Enter the value of `LAB_ACCESS_KEY`, paste an official CyLaw judgment URL, and run either **Section map** or **Full extraction**.

## Supported intake in the first web build

- official CyLaw judgment URL;
- pasted judgment text;
- TXT file;
- HTML/HTM file;
- JSON file containing a `text` or `judgmentText` string.

PDF and DOCX ingestion are intentionally not enabled in this first deployment. They will be added after the section and full-extraction benchmarks are stable.

## Security

- `OPENAI_API_KEY` remains server-side.
- `/api/parse` requires `LAB_ACCESS_KEY` through the `x-lab-key` header.
- The server allows at most two concurrent extraction jobs and applies a per-client hourly rate limit.
- No result is automatically written to the MyNomos production corpus.
- The repository and deployment are isolated from the original `MyNomosAI` repository.
