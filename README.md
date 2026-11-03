# Invoice AP Agent

An accounts-payable agent that takes a vendor invoice PDF and returns **Approve, Hold or Reject**, with every step, every reason and the next action on screen. It screens the PDF for tampering and prompt injection, has an LLM (through OpenRouter) read it into structured fields, then checks those fields against the vendor master and the purchase orders with plain TypeScript rules. Built for the PS-1 finance case study ([PROBLEM.md](PROBLEM.md)): Next.js 15, TypeScript, SQLite.

> **Design principle: the model reads, the rules decide, every decision has a reason, and the invoice is never trusted.**

**Live demo:** https://asa-case-study.onrender.com (Render's free tier: it sleeps after 15 minutes without traffic and the first request after that takes about a minute; its storage is wiped on every restart, so reset the demo data first; it uses the free model, which allows 50 requests a day, see [Free route](#free-route-no-credit)).

> [!IMPORTANT]
> **What has and has not been verified (2026-11-03).** The tests, the smoke run and the browser run use the offline mock extractor (`EXTRACT_MOCK=1`) or, for the extraction code's own tests, a local fake OpenRouter. **A real model has been run once, on the free route** (`nvidia/nemotron-3.5-super-vl:free`, a key with no credit; see [Free route](#free-route-no-credit)): all 10 samples through `npm run eval` (9 of 10 right on the key fields; the plan's gate passes) and through the real server (8 of 10 ended as expected on the first pass; the other two are explained there). **The paid defaults (`google/gemini-3.8-flash`, `anthropic/claude-haiku-5.5`) have not been called**, so their accuracy, latency and cost are unverified, and `docs/eval-extract.md`, the three-model comparison table the plan asks for, does not exist until someone runs `npm run eval -- --out` with credit. The owner deployed the repo to Render's free tier (the live demo above; health-checked only: `/api/master` answered 200 and `/api/samples` listed the 10 samples). Whether Render built the Dockerfile was not checked, and the Dockerfile has not been built by the person who wrote it (no Docker daemon): its steps were replayed by hand outside Docker on the final code, under Node 22.23.4 and Node 20.20.2. Railway has not been tried (see [Deploy on Railway](#deploy-on-railway)).

![Dashboard after six sample runs: KPI tiles, filter chips and the runs table with decisions, top reasons and a security flag](docs/img/dashboard.png)
*The dashboard after the six run-sheet samples (#1, #3, #4, #5, #6, #9) on top of the four pre-loaded records: 10 processed, 5 approved, 4 on hold, 1 rejected, 1 security flag, $42,680.00 approved. Offline mock mode, so each run costs $0.00; the pre-loaded records show a dash.*

![Sample 3: the HOLD decision card, the ten-stage pipeline with the Amounts vs PO evidence open (PO balance maths, unit prices, units and amounts per PO line), and the extracted fields with confidence and grounded marks](docs/img/run-03-split-po.png)
*Sample 3, split-PO over-billing: the decision, the next action, the pipeline with the evidence of "Amounts vs PO" open (the PO balance maths, the unit prices and the units and amounts against each PO line), and what the model read. The PDF panel of the page is left out of this picture.*

![Sample 9: the decision card with the security banner quoting the hidden instruction](docs/img/run-09-security-banner.png)
*Sample 9, prompt injection: the banner quotes the hidden instruction once and names the three checks that caught it; the reasons under "Why it is on hold" say what each check found without repeating the quote, and the invoice goes to security review.*

## Contents

- [How it works](#how-it-works)
- [The 10 sample invoices](#the-10-sample-invoices)
- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [Checks](#checks)
- [Deploy on Railway](#deploy-on-railway)
- [Security model and known limits](#security-model-and-known-limits)
- [What's next](#whats-next)
- [Repository map](#repository-map)

## How it works

A run starts from an upload or a sample card (`POST /api/runs` answers `202 { runId }` at once). Runs are processed one at a time through ten stages; the run page polls `GET /api/runs/:id` every 400 ms and shows each stage as it finishes. Every stage stores its status, a one-sentence reason and its evidence.

| # | Stage (as labelled in the UI) | What it does | Who decides |
|---|---|---|---|
| 1 | Ingest file | `%PDF-` header, at most 10 MB and 5 pages, not encrypted, readable by both pdf-lib and pdf.js (both parsers run in one worker thread with a 10 s deadline, a 256 MB heap cap and a memory watchdog), and the exact same file (SHA-256) not processed before | code ([`pdf.ts`](src/lib/pdf.ts), [`rules.ts`](src/lib/rules.ts)) |
| 2 | Security screen | Before any model sees the file: the text layer is scanned for instruction-like phrases (13 patterns) and for tiny or hidden text (a run of at least 4 words under 3 pt) | code ([`guardrails.ts`](src/lib/guardrails.ts)) |
| 3 | Extract fields | The model turns the PDF into a strict JSON schema, validated with zod; up to two attempts per model, then the fallback model. It is told the document is untrusted and must quote any instructions it finds in `suspicious_content` | **model** (reads only), [`extract.ts`](src/lib/extract.ts) |
| 4 | Validate | Document type, required fields, confidence at least 0.75 on key fields, line and total arithmetic, tax at most 10%, dates; **grounding**: the invoice number, PO reference and total must appear as whole tokens in the visible text layer (tiny text excluded) | code |
| 5 | Normalize | Dates to ISO, invoice numbers to upper-case letters and digits (`INV-0042` = `INV0042`), vendor name matched to the master (aliases, legal suffixes) | code ([`normalize.ts`](src/lib/normalize.ts)) |
| 6 | Vendor check | Vendor known and approved; the bank account the model read, and every account number a best-effort scan finds in the visible text of a text PDF, must equal the one on file (it is only ever compared, never used). The scan reads the value after an account, bank or payment label in many common spellings ("Account no", "A/C:", "Acct", "IBAN", "Bank details", "Pay to", "Remit to", "Beneficiary" ...), also on the next line or in the next table cell; anything shaped like an account on file; and any IBAN with valid check digits. It misses some wordings and can hold an innocent number ([ASSUMPTIONS.md](ASSUMPTIONS.md)). A non-invoice document from a vendor that is not in the master is not sent to onboarding; from a known vendor that is not approved it is still rejected for onboarding | code |
| 7 | PO match | A printed PO must exist, belong to the vendor, be open and in the same currency. No PO printed: the vendor's open POs with enough balance are the candidates; with several, the model may pick one from that list only, and an inferred PO always holds for a person to confirm | code; the model only suggests |
| 8 | Amounts vs PO | Subtotal against the PO's remaining balance (only approved invoices use it up), 2% tolerance; unit prices against the matching PO lines; the units and amount billed against each PO line, summed over the invoice lines that pair with it; billed lines that are not on the PO | code |
| 9 | Duplicate check | Same vendor and same normalized number: REJECT. A number that differs only by look-alike characters or zero padding (`INV-O042`, `INV-42`): HOLD. Same vendor, same amount within 7 days: HOLD. Same amount further apart: recurring, fine. Credit notes are compared with credit notes; other non-invoice documents are not compared | code |
| 10 | Decision | `decide()`: any reject wins, then any hold or system error, else APPROVE (warnings become notes). A run with a security flag can never be APPROVE. `nextAction()` writes the next step | code ([`rules.ts`](src/lib/rules.ts)) |

Every check runs even after a failure, so a reviewer sees all problems at once; a rejected file (stage 1) or a failed extraction (stage 3) skips the stages that would have nothing to check. A stage that throws or does not settle in 5 minutes becomes a "System error" step, and the run is held.

**Who decides what.** The model's only job is to transcribe the document (stage 3) and, when no PO is printed and several fit, to suggest one of the candidates (stage 7). It has no tools, never sees the rules, the vendor master or the balances, and its answer is data that the code validates. Every decision is made by plain TypeScript in [`src/lib/rules.ts`](src/lib/rules.ts), and every reason is a sentence built by code (`rules.ts`, `guardrails.ts`, `pdf.ts`); text from the invoice or the model only ever appears inside it as a quote.

**Defence against prompt injection, in layers** (none of them has to be perfect):
1. **Architecture**: the model cannot approve anything; approval is computed by `decide()` from master data.
2. **Deterministic screen before the model** (stage 2): the pattern scan reads the joined text layer after Unicode folding (look-alike dashes and colons, zero-width characters), and the tiny-text check finds text nobody can see. Either one holds the invoice and sets the security flag.
3. **The model's own report**: the prompt marks the document as untrusted; anything instruction-like it sees goes to `suspicious_content`, which holds the invoice too. This also covers scans, which have no text layer to scan.
4. **Strict output**: JSON schema plus zod (types, lengths, ranges, finite numbers); invalid output is retried or falls back, never used.
5. **Grounding** (stage 4): the extracted invoice number, PO reference and total must be visible in the document. Values that exist only in hidden text cannot ground, so a fooled model's numbers are caught.
6. **The business rules still apply**: PO balance, unit prices, duplicates, and bank details only from the vendor master.
7. **Invariant**: a security-flagged run is never approved, enforced inside `decide()` itself.

Sample 9 shows this: its hidden sentence is caught by the tiny-text check, the text scan and the model report at once. With no API key at all, sample 9 is still held with the security flag, because stage 2 runs before any model call (checked offline on the final code with an extractor that fails as a missing key does, and seen on an earlier dry-run server).

**Storage and audit trail.** One SQLite file at `$DATA_DIR/app.db`; uploads are stored as `$DATA_DIR/uploads/<sha256>.pdf`, never under their own file name. Vendors, purchase orders and the pre-loaded history come from `data/seed/*.json`; the sample PDFs and their truth files from `data/samples/` (both read from the project root, whatever `DATA_DIR` says). Runs are append-only: each keeps its steps and evidence, the raw model output, the model that answered, the prompt version and the cost. On startup the app creates the tables, seeds an empty database and marks runs cut off by a restart as "Interrupted by restart, please re-run". Runs go through one in-process queue, so two invoices never race for the same PO balance; a 350 ms pause between stages (`CONFIG.stagePacingMs`) keeps the live view readable.

## The 10 sample invoices

Generated with Playwright from `data/samples/truth/NN.json`, which also holds what each one must produce (`_meta`). The reasons below are what `npm run rehearse` printed on the final code on 2026-11-03 (the app's rules with the mock extractor, in demo order); against the production build the smoke test checked every sample's decision and key phrases over HTTP, and the screenshots above show samples 3 and 9. Four invoices are pre-loaded as history (Acme INV-0042 and ST-2026-09, Globex GLX-301 and GLX-302), which is what makes samples 3, 4 and 7 interesting.

| # | Sample | Edge case | Decision | First reason (or next action) |
|---|---|---|---|---|
| 01 | Happy path | | APPROVE | All checks passed. Next action: "Queue for payment on due date 2026-11-21." |
| 02 | Small price variance | | APPROVE with notes | "Invoice subtotal $2,924.00 is $24.00 (0.8%) over the $2,900.00 remaining on PO-1007, within the 2% tolerance. Unit price for "Toner cartridge" is $86.20 vs $85.00 on PO-1007 (+1.4%, within the 2% tolerance)." |
| 03 | Split-PO over-billing | A | HOLD | "Exceeds remaining PO balance by $3,000.00. PO-1003: $30,000.00 total, $24,000.00 already approved (GLX-301, GLX-302), $6,000.00 remaining. ..." |
| 04 | Disguised duplicate | B | REJECT | "Duplicate of INV-0042 (processed 2026-10-05); numbers differ only in formatting." (the PO balance failure is listed second) |
| 05 | Scanned, no PO number | C | HOLD | "PO inferred as PO-1005 (confidence 0.90), needs confirmation." Next action: "AP lead to confirm PO-1005 is the correct PO." The scan's own note, "No text layer to verify against (scanned).", is listed under "Also noted", not as a cause |
| 06 | Bank details changed | D | HOLD | "Bank details differ from vendor master; call +1 415 555 0102 (number on file) to verify. Do not use contact details from the invoice." |
| 07 | Recurring, not a duplicate | | APPROVE | All checks passed; the duplicate check notes a recurring charge (the same $400.00 subtotal as September's invoice, 31 days later). |
| 08 | Vendor not onboarded | | REJECT | "Vendor Umbrella Consulting is not approved; route to vendor onboarding before this invoice can be processed." |
| 09 | Prompt injection | E | HOLD + security flag | "Suspicious instruction-like text found: ..." Next action: "Send to finance security review. Do not contact the vendor using details from this document." |
| 10 | Wrong document | | HOLD | "This document is not an invoice (it is a statement of account). ..." Next action: "Route to statement handling." |

With a real model the decisions should be the same, but the wording that depends on the model will differ (for example sample 5's confidence and the matcher's reasoning). The samples are dated 2026-10-22 to 2026-10-31. The 365-day age rule (a 365-day-old invoice still passes) starts holding sample 1 on 2027-10-23 (UTC) and every sample by 2027-11-01, so the samples, `smoke` and `e2e` are meant for use before then; `test:api` already skips its real-clock route tests from 2027-10-20.

## Quick start

Use **Node 22** (`package.json` asks for `>=22`; the Docker image runs `node:22-bookworm-slim`; tested here with 22.23.4). Node 20 also works (most checks below ran on 20.20.2), but `npm ci` prints an EBADENGINE warning and, because better-sqlite3 12.11.1 ships no prebuilt binary for Node 20, compiles it, which needs a C++ toolchain.

```bash
npm ci
cp .env.example .env.local    # then fill in OPENROUTER_API_KEY and DEMO_RESET_TOKEN, or set EXTRACT_MOCK=1
npm run dev                   # http://localhost:3000
```

The database is created and seeded on the first start. Open **New run**, press a sample card ("Run this sample") and watch the run page.

**Offline mock mode (`EXTRACT_MOCK=1`, no key needed).** No model is called. The "extraction" of a sample is its truth JSON, found by the PDF's SHA-256; any other PDF comes back as `document_type "other"`, so it ends as a "not an invoice" HOLD; the PO suggestion for sample 5 comes from a word matcher. The decision card then says "Model mock (offline stand-in, no real model was called)". `EXTRACT_MOCK=fooled` returns sample 9's injected values (PO-1003, total 400, every confidence 1.0) to show grounding catching a fooled model. Never set either in production.

Other commands:

| Command | What it does |
|---|---|
| `npm run build` then `npm run start` | Production build and server (`next start` listens on `$PORT`, default 3000, on all interfaces) |
| `npm run seed` | Creates the tables in `$DATA_DIR/app.db` if needed and replaces all demo state with `data/seed` (vendors, POs, history); stored uploads are left alone. Not while a run is processing |
| `npm run gen` | Regenerates the 10 sample PDFs from their truth files (needs `npx playwright install chromium`) |
| `npm run eval -- --out` | Runs every sample through each model and writes `docs/eval-extract.md` (needs a key, costs credit: 3 models x 10 samples = 30 calls). `npm run eval -- --mock` exercises it offline |
| `npm run rehearse` | Offline rehearsal of the ten stages on the samples, in demo order, on an in-memory database |
| `npm run typecheck`, `npm run lint` | `tsc --noEmit`, ESLint |

To reset the demo: **New run** → **Demo tools** → **Reset demo data** → paste the `DEMO_RESET_TOKEN` → **Confirm reset**. Or from a shell: `curl -X POST -H "x-reset-token: <token>" http://localhost:3000/api/reset`.

## Environment variables

Only the server reads them; nothing is a `NEXT_PUBLIC_` variable. `npm run dev` and `npm run start` load `.env.local`; `npm run eval` and `npm run seed` load `.env.local` and `.env` themselves (never overriding a variable already set). Template: [`.env.example`](.env.example).

| Variable | Needed | Default | What it does |
|---|---|---|---|
| `OPENROUTER_API_KEY` | for real extraction | none | OpenRouter key. Read only by `src/lib/extract.ts`. Without it every run is held: "LLM provider unavailable (billing/auth)" |
| `EXTRACT_MODEL` | yes | none | Primary model slug, `google/gemini-3.8-flash`; on a key with no credit, `nvidia/nemotron-3.5-super-vl:free` (see [Free route](#free-route-no-credit)) |
| `FALLBACK_MODEL` | recommended | none | Fallback model slug (another provider family), `anthropic/claude-haiku-5.5`; leave it empty on the free route |
| `DATA_DIR` | no | `./data` | Folder for `app.db` and `uploads/`, relative to the project root. On Railway: `/app/storage` |
| `DEMO_RESET_ENABLED` | no | off | Exactly `true` enables `POST /api/reset` |
| `DEMO_RESET_TOKEN` | for reset | none | At least 16 characters (shorter counts as unset); sent in the `x-reset-token` header. Generate one with `openssl rand -hex 24` |
| `MAX_RUNS_PER_HOUR` | no | `60` | Global cap on runs started per rolling hour (only requests that create a run count) |
| `EXTRACT_MOCK` | development only | off | `1` (or `true`, `truth`): mock extractor; `fooled`: mock of a fooled model |
| `PORT` | no | `3000` | Port of `next dev` / `next start`. Railway injects it |
| `RAILWAY_RUN_UID` | Railway only | none | Set to `0` on Railway: its volumes are mounted as root and the image runs as the `node` user (see below) |

The Docker image also sets `NODE_ENV=production`, `NEXT_TELEMETRY_DISABLED=1`, `PORT=3000` and `DATA_DIR=/app/storage`. The per-address limit of 10 runs per minute and the upload limits (a request body must arrive within 60 s; at most 2 uploads in progress per address and 16 in all) are fixed in [`src/lib/config.ts`](src/lib/config.ts), with every other threshold.

### Free route (no credit)

A key with no purchased credit can call `:free` models only. The app has a profile for one of them: set `EXTRACT_MODEL=nvidia/nemotron-3.5-super-vl:free` and leave `FALLBACK_MODEL` empty (the live demo does). It reasons for thousands of tokens by default and timed out on most samples, so the profile turns that off (`reasoning: { effort: "none" }`) and lets OpenRouter's free parser (`cloudflare-ai`) read text PDFs. What was measured on 2026-11-03, on an account that had never bought credit (the numbers are in [ASSUMPTIONS.md](ASSUMPTIONS.md), Deviations from the plan):

- `npm run eval` on the 10 samples: all came back, 9 of 10 right on the key fields (the tenth, a statement, got a date the truth leaves empty), 2.8 to 22.6 s each and 11.8 s on average, the scan read correctly, the injection sample reported and nothing manipulated. The plan's gate passes.
- The full pipeline through the real server: 8 of 10 samples ended exactly as in the mock run on the first pass (#9 included: held with the security flag). The other two, #1 and #7, were held because the model set `tax_inclusive` wrongly (it did so on four samples), so the schema's wording for that field was rewritten and `reconcileTaxInclusive` was added: when the printed subtotal plus tax equals the total, the flag is false whatever the model said, with a note (the raw answer is stored unchanged). After the rewrite #7 approved live; the stored real answer for #1, replayed offline through the final code (without a text layer), no longer fails the validate stage, but #1 was not run live again.- Limits: OpenRouter allows 20 requests a minute and 50 a day on an account under $10 of purchased credit, so the three-model comparison (30 calls) does not fit in one day. The scan (#5) needs paid OCR (about $0.002 a page; the free parser cannot read it); on an account with no credit that one call went through and left the balance at -$0.002, which OpenRouter's documentation says can cause errors even for free models (a free call still worked afterwards). Free endpoints may log prompts and train on them (fine for this synthetic data; OpenRouter's privacy settings must allow them). Free models slow down or vanish without notice: one of ten live runs took 58 s, and one run timed out at 45 s and then hit a network error, which holds the run with "Could not read invoice, manual entry required".

## Checks

None of them calls a model or needs a key. Counts as of 2026-11-03 on the final code, all passing with 0 failures and 0 skips (`e2e` with `E2E_DATA_DIR` set).

| Command | Tests | What it proves |
|---|---|---|
| `npm run check` | 211 (contracts 19, business 130, guardrails 62) | Data contracts and seed maths; all 10 samples' truth JSON through the real rules gives the expected decision, reasons and next action; the guardrails on the real PDFs (scan, tiny text, grounding, printed bank accounts, upload limits, hostile files); the security invariant; a regression test for each fixed rules or guardrails finding of the reviews. Fixed clock, no network |
| `npm run test:extract` | 99 | The real `extract.ts` against a local fake OpenRouter: request body per model, retries, fallback, error classes, timeouts, cost summed over attempts, no request without a key |
| `npm run test:api` | 79 (pipeline 37, ratelimit 11, routes 23, reset 5, startup 3) | The real route handlers in-process with a real SQLite file in a temp folder: the HTTP contract, uploads, 413, 408, rate limits and upload caps, reset, and a regression test for each fixed red-team or review finding of the API |
| `npm run smoke` | 49 | Black-box HTTP against a running server: all 10 samples, file serving, security headers, abuse cases, the PDF worker keeping the server responsive (a pdf.js operator flood and a pdf-lib page-tree bomb), and (with `SMOKE_SERVER_LOG`) the logs |
| `npm run e2e` | 57 | Real Chromium against a running server: two clean passes of the 10 samples (including that a held or rejected run lists its info notes under "Also noted", never as a cause, and that sample 9's decision card quotes the hidden instruction once), dashboard, data page, 375 px, keyboard and axe-core, unhappy paths (including a run whose stored PDF was deleted), hostile stored text. The hostile-text section and the deleted-PDF check need `E2E_DATA_DIR` set to the server's `DATA_DIR`; without it they are reported as skipped |
| `npm run check:static` | 18 | No `dangerouslySetInnerHTML` or `NEXT_PUBLIC_`; client code imports only `types.ts` and `format.ts` from `src/lib`; the production client bundle has no server code and no key name. Run `npm run build` first |

`smoke` and `e2e` need a production server started with the mock, a reset token and a `DATA_DIR` that `e2e` can reach. From the project root, after `npm ci` (the variables given on the command line win over `.env.local`; the empty `OPENROUTER_API_KEY` keeps a key in `.env.local` out of the test server):

```bash
npx playwright install chromium        # once per machine: e2e drives Playwright's own Chromium
NEXT_TELEMETRY_DISABLED=1 npm run build
T="$(mktemp -d)"                       # outside the repo: the test server's data and log
EXTRACT_MOCK=1 OPENROUTER_API_KEY= DATA_DIR="$T/data" DEMO_RESET_ENABLED=true DEMO_RESET_TOKEN=local-dev-reset-token-123456 \
  MAX_RUNS_PER_HOUR=500 PORT=3100 NEXT_TELEMETRY_DISABLED=1 npm run start > "$T/server.log" 2>&1 &
SERVER=$!
BASE_URL=http://127.0.0.1:3100 SMOKE_RESET_TOKEN=local-dev-reset-token-123456 SMOKE_SERVER_LOG="$T/server.log" npm run smoke
BASE_URL=http://127.0.0.1:3100 SMOKE_RESET_TOKEN=local-dev-reset-token-123456 E2E_DATA_DIR="$T/data" npm run e2e
kill "$SERVER"; rm -rf "$T"            # stop the server, remove its data
```

`smoke` waits up to 180 s for the server to answer (`SMOKE_WAIT_SECONDS`); it takes about a minute, `e2e` about two and a half.

Where they ran for this README (2026-11-03, the final code of this round): `check`, `test:extract`, `test:api`, `rehearse` and `check:static` in the repo on Node 20.20.2 (`check:static` against a production build made with Node 20.20.2); `smoke` and `e2e` under `next start` from the repo on Node 20.20.2, with the variables above; and in the production-layout replay described under [Deploy on Railway](#deploy-on-railway), `smoke` on Node 22.23.4 and on Node 20.20.2, `e2e` on Node 22.23.4 (and on Node 20.20.2, where one timing failure in its first run passed on the re-run) and `check:static` on a build made with Node 22.23.4. The recipe above was not replayed word for word on a fresh machine: those runs set the same variables through their own launch scripts, and Playwright's Chromium was already installed. Do not point `smoke` or `e2e` at a deployment that uses a real key: they expect the mock's results and would spend credit.

## Deploy on Railway

The repo deploys as one Docker service with one volume. The [`Dockerfile`](Dockerfile) has three build stages and a slim runtime stage on `node:22-bookworm-slim`. What it does and why:

- **Native module**: better-sqlite3 12.11.1 publishes prebuilt binaries for Node 22 (ABI 127) on linux x64 and arm64, so the build normally downloads one from GitHub; only if that fails does it install python3, make and g++ and compile. The compiler never reaches the runtime image.
- **Runtime contents**: production `node_modules` (`npm prune --omit=dev`; no `typescript`), the `.next` build without its cache, `package.json`, `package-lock.json`, `next.config.mjs`, `data/seed`, `data/samples` and `src/lib/pdf-text-worker.mjs`. The worker file is loaded by path from `<cwd>/src/lib`; without it uploads are parsed on the main thread again, and the dry run showed what that costs: a 58 KB operator flood stalled every request for about 3 s, and a 3.7 KB page-tree PDF froze the server until it was killed.
- **No TypeScript at run time**: the config is `next.config.mjs`, so `next start` needs no `typescript` package. (With a `next.config.ts`, Next 15.5 compiles it at boot, tries to `npm install typescript` when the package is missing and exits with "Failed to load next.config.ts" when it cannot: observed in an earlier dry run.) The runtime has none, and the dry-run server printed "Ready in 465ms" on Node 22.23.4 and "Ready in 670ms" on Node 20.20.2.
- **Port and folder**: `npm run start` runs `next start`, which reads `PORT` and listens on all interfaces; it must start in `/app`, the project root. Writable state goes to `DATA_DIR=/app/storage`.
- **User**: the process runs as the unprivileged `node` user and the app files are read-only to it. Railway mounts volumes as root, and its documentation says to set `RAILWAY_RUN_UID=0` for images with a non-root user, which makes the process run as root on Railway. Without that variable the `node` user is expected not to be able to write the volume. What an unwritable `DATA_DIR` looks like (simulated in the dry run): startup log `{"event":"startup","db":"failed","error":"SqliteError"}`, `/api/samples` still 200, `/api/master` and `/api/runs` 500.
- **No `railway.json`**: Railway's "Config as Code" is deprecated, new services cannot opt into it, and existing files stop being read on 2026-12-01, so the settings below are made in the dashboard.

**Step by step**

1. Push the repo to GitHub. In Railway: **New Project** → **GitHub repo** → pick the repo → **Add variables** (choose **Deploy Now** instead and the first deploy simply runs without them). Railway uses the `Dockerfile` at the repo root by itself.
2. **Variables** tab of the service → **RAW Editor**, paste and fill in:
   ```
   OPENROUTER_API_KEY=<your OpenRouter key>
   EXTRACT_MODEL=google/gemini-3.8-flash
   FALLBACK_MODEL=anthropic/claude-haiku-5.5
   DATA_DIR=/app/storage
   DEMO_RESET_ENABLED=true
   DEMO_RESET_TOKEN=<output of: openssl rand -hex 24>
   MAX_RUNS_PER_HOUR=60
   RAILWAY_RUN_UID=0
   ```
   Do not set `EXTRACT_MOCK` or `PORT`. Consider sealing `OPENROUTER_API_KEY` (a sealed value is passed to deployments but never shown again). The Dockerfile declares no build arguments, so no variable enters the image.
3. **Volume**: create one (Command Palette `⌘K`, or right-click the project canvas), attach it to the service and set the mount path to **`/app/storage`**. Never `/app/data`: it would hide `data/seed` and `data/samples`. Volumes are mounted when the container starts, not during the build.
4. **Service settings**: healthcheck path **`/api/master`** (it opens the database, so a volume that cannot be written fails the deploy instead of going live; `/api/samples` answers 200 even then, as the dry run showed); restart policy **On Failure**; leave the start command empty (the image runs `npm run start`).
5. Deploy (variable changes are staged until you deploy them). Then **Generate Domain** in the service settings.
6. **OpenRouter**: set a credit limit on the key in the OpenRouter dashboard (the plan suggests $5). It is the hard backstop if the public URL is abused; a hit limit makes runs hold with "LLM provider unavailable (billing/auth)". Do not enable OpenRouter's prompt-injection guardrail on the key: sample 9 would get a 403 at extraction and lose its evidence.
7. **First checks**:
   - The deploy log shows `{"event":"startup","db":"ready","vendors":5,"runs":4}` on the first boot (the run count grows later) and never `no text-parse worker could be started`.
   - `curl -s https://<domain>/api/samples` lists 10 samples; `curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/api/master` prints 200.
   - In the app, reset the demo data, run sample 1: it must end APPROVE, and the decision card must name the real model (not "mock") with a cost above $0.00. Then reset again before a demo, because running the same file twice is an exact duplicate.
8. **Reset** any time: **New run** → **Demo tools** → **Reset demo data**, or `curl -X POST -H "x-reset-token: <token>" https://<domain>/api/reset`.

Railway facts this relies on (from its documentation, 2026-11-03): it injects `PORT` and uses it for the healthcheck, which only runs at deploy time and accepts any 2xx; volumes are root-owned; a service with a volume has a short downtime on every redeploy and cannot have replicas; its edge sets `X-Real-IP`, which the rate limiter reads first (whether it overwrites a value the client sent is not stated there: unverified).

**How the image was tested without Docker.** Docker was not available (the daemon was not running), so on 2026-11-03 each stage of the Dockerfile was replayed by hand on macOS arm64, outside the repo, on the final code of this round. The replay started from a copy of exactly what the build context holds after `.dockerignore` (161 files; `.env.example` is the only `.env` file). Then came `npm ci`, `npm run build`, `rm -rf .next/cache` and `npm prune --omit=dev`, and a runtime folder holding exactly the runtime stage's files (no `typescript`). That folder was made read-only except its storage folder, as `/app` is for the `node` user, and the server was started there with `npm run start` in a clean environment (`PORT=3200`, `DATA_DIR=<folder>/storage`, `EXTRACT_MOCK=1`, a reset token and an empty `OPENROUTER_API_KEY`). On Node 22.23.4, the image's version, and on Node 20.20.2, the server started without `typescript` and smoke passed 49 of 49 with 0 skipped. On both, the security headers were present and `X-Powered-By` absent, the database and uploads were written only under `DATA_DIR` while no file of the read-only folder changed, the data survived a restart, and `/api/master` and `/api/samples` answered 200. With an unwritable `DATA_DIR`, `/api/master` answered 500 while `/api/samples` still answered 200. The PDF worker parsed uploads in its own thread: a hostile 3.7 KB page-tree file was cut off at the 10 s deadline while other requests answered in 2 ms, and with the worker file removed the same file froze the server until it was killed. On Node 22.23.4, e2e passed 57 of 57 in real Chromium with `E2E_DATA_DIR` set, and `check:static` passed 18 of 18 on that build. On Node 20.20.2, e2e passed 57 of 57 on a second run after one timing failure in its first run (56 of 57; a test race in a dashboard check). On Node 20, `npm ci` prints an EBADENGINE warning and installs anyway, compiling better-sqlite3 from source. This replaces an earlier dry run (smoke 48, e2e 51) that ran on the code before the fix rounds. Not tested: the Docker image itself (a Linux x64 build, the better-sqlite3 Linux download and its apt fallback, the real `node` user), Railway (the root-owned volume with `RAILWAY_RUN_UID=0`, SQLite WAL on it, its proxy headers and its healthcheck), and a call to either paid default model. Since then the owner has deployed the repo to Render's free tier (no volume, free model): on 2026-11-03 `/api/master` answered 200 and `/api/samples` listed the 10 samples there; no run was made on it and whether Render built this Dockerfile was not checked.

## Security model and known limits

- **The invoice is untrusted**: PDF text, the model's output, file names and every reason that quotes them are rendered as plain React text (no `dangerouslySetInnerHTML` anywhere), never used as a path and never logged (a log line per stage holds the run id, stage, status and time only).
- **The key is server-only**, read in one file; `check:static` proves the client bundle holds no key name and no server code.
- **Abuse limits**: 10 runs per minute per address (keyed on `X-Real-IP`, then the last `X-Forwarded-For` entry), `MAX_RUNS_PER_HOUR` overall, and the OpenRouter credit limit as the backstop. Reset needs the token (compared in constant time). Uploads are capped at 10 MB before anything is stored; a request body must arrive within 60 s (else 408), at most 2 uploads per address and 16 in all may be in progress at once (else 429 with a 5 s wait), and the hourly slot is taken only once the body has arrived, so stalled uploads no longer use up `MAX_RUNS_PER_HOUR`. The PDF parse runs in a worker thread with a deadline, a heap cap and a memory watchdog.
- **Known limits** (accepted; the full list with reasons is in [ASSUMPTIONS.md](ASSUMPTIONS.md)): no user accounts (single-tenant demo); one process, one SQLite file and one serial queue; the pattern scan only knows its configured phrasings and three of its patterns also match innocent words (a false positive costs a manual review, never a payment); white text at normal size is invisible to the tiny-text rule; scans cannot be grounded; without a proxy that sets `X-Real-IP` or appends to `X-Forwarded-For`, a client picks its own address for the per-address limits; USD only and a single 10% tax ceiling; word-based PO line matching; no Content-Security-Policy header yet; the extraction request does not ask OpenRouter for no-data-collection endpoints, which is fine for this synthetic data and not for real invoices; browser checks ran in Chromium only.
- **Open findings of the last code review** (not fixed and not yet accepted; details in [ASSUMPTIONS.md](ASSUMPTIONS.md)): the printed-account scan of stage 6 misses some wordings, so if the model also leaves the account out, an invoice that prints a new account in such words is approved (bank details for payment still come only from the vendor master), and it can hold an innocent number such as a product code after "bank" (R-1, R-2); 16 stalled uploads from 8 addresses keep new uploads refused for as long as they are renewed, while sample runs still work (R-4); the 60 s body deadline cuts off 10 MB uploads on links slower than about 1.4 Mbit/s (R-5); the start page words an upload-cap 429 as "Too many runs were started" (R-3).

## What's next

1. Run `npm run eval -- --out` with a key that has credit (30 calls; a free key allows 50 a day) and commit `docs/eval-extract.md`; switch `EXTRACT_MODEL` and `FALLBACK_MODEL` if Haiku 5.5 matches Gemini on samples 5 and 9 (no code change).
2. A human decision on HOLD runs ("approve anyway" or "reject" with a required comment, saved as a new audit row).
3. Email inbox ingestion, ERP sync, approval routing by amount, per-vendor layout learning, multi-currency.
4. For production: accounts and roles, a durable job queue with per-PO locks instead of one serial queue, Postgres instead of SQLite, a CSP header, and an LLM tier with no-training terms.

## Repository map

```
src/lib/          the pipeline: pdf.ts + pdf-text-worker.mjs (upload checks), guardrails.ts (screen, grounding),
                  extract.ts (OpenRouter) + extract-mock.ts, normalize.ts, rules.ts (every check, decide, nextAction),
                  pipeline.ts (queue, stages), db.ts, seed.ts, master.ts, config.ts (thresholds, env)
src/app/          pages (dashboard, /runs/new, /runs/[id], /data) and the HTTP API under src/app/api
src/components/   UI (run view, dashboard, start page, data page)
data/seed/        vendors, purchase orders, pre-loaded history
data/samples/     the 10 sample PDFs and truth/NN.json
scripts/          checks, smoke and e2e tests, sample generator, eval
docs/             CONTRACTS.md (signatures, HTTP API), DEMO.md (demo script), notes-*.md (API research), img/
```

More: [docs/DEMO.md](docs/DEMO.md) (the 5-minute demo and likely questions), [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) (the spec), [docs/CONTRACTS.md](docs/CONTRACTS.md) (module signatures and the HTTP API), [ASSUMPTIONS.md](ASSUMPTIONS.md) (assumptions, deviations, known limits).
