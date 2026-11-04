# Reviewer guide

## What it does

The Invoice AP Agent takes a vendor invoice PDF and returns **Approve, Hold or Reject**, with the ten stages it went through, a reason for each and the next action, on one screen. A language model only reads the document; plain TypeScript rules decide, and nothing that comes from the invoice is trusted. A person can then resolve a hold, and optional automations route what was decided to people and tools.

## The 5-minute path

Follow [docs/DEMO.md](docs/DEMO.md): reset, run samples 1, 3, 4, 5, 6 and 9 from **New run**, then read the dashboard. The page for sample 3 (over-billing) and sample 9 (hidden instruction) show the most. Optional extras there: resolving sample 5's hold, and the Automations page.

## Where decisions are made

All of them in [`src/lib/rules.ts`](src/lib/rules.ts): every check returns a status and a human-readable reason, `decide()` combines them (any reject wins, then any hold or system error, else approve; a security flag can never approve), and `nextAction()` writes the next step. A reviewer's hold resolution is in [`src/lib/review.ts`](src/lib/review.ts) and only checks that what a person asks is allowed. Automations run after the decision and cannot change it (`scripts/check-static.ts` check 4b; `test-api` "automations invariant").

## What the model does and does not do

It transcribes the document into a strict JSON schema (stage 3) and, when no PO is printed and several fit, may suggest one from a list the code built (stage 7). It has no tools, never sees the rules, the vendor master or the balances, and its answer is validated data: values must appear in the document's own text (grounding), and anything instruction-like it sees is reported and holds the invoice. It cannot approve, and the app works without it for everything but reading (`EXTRACT_MOCK=1` answers from the samples' truth files).

## The edge cases and how each is caught

| Sample | Edge case | Stage that catches it | Result |
|---|---|---|---|
| 01 | Happy path | none needed | Approve |
| 02 | Price 1.4% above the PO (inside 2%) | 8, Amounts vs PO | Approve with a note |
| 03 | Two invoices each fine, together over the PO | 8, Amounts vs PO | Hold |
| 04 | Same invoice, different formatting (`INV0042`) | 9, Duplicate check | Reject |
| 05 | Scanned, no PO number | 7, PO match (an inferred PO needs a person) | Hold |
| 06 | New bank account for a known vendor | 6, Vendor check | Hold |
| 07 | Same amount a month later (a subscription) | 9, Duplicate check lets it through | Approve |
| 08 | Vendor not in the master | 6, Vendor check | Reject |
| 09 | Hidden text telling the AI to approve | 2 (screen), 3 (the model's report), 4 (grounding) | Hold + security flag |
| 10 | Not an invoice | 4, Validate | Hold |

## What is not verified

- **A live evaluation with a paid model key.** The suites run on the mock and on a fake OpenRouter; the free route was exercised by hand and 8 of 10 samples matched the mock on the first pass (see the README's "Free route"). The plan's B1 (a scored run with a credit-limited key) has not been done.
- **The PDF frame in a real Chrome window under the Content-Security-Policy.** The browser tests use Chromium through Playwright; a person should open a run page once in Chrome.
- **Screen readers.** Roles, labels, focus and keyboard paths are tested in a browser, but no screen reader was used.
- **A real webhook.** Sending is tested with injected fakes; no request has gone to a real host (the plan's one optional manual send).
- **The reviewer's identity.** There are no user accounts: the operator token is shared, and a review records what was written, not who wrote it.

## How to run it

```bash
npm install
cp .env.example .env.local        # leave the key empty and set EXTRACT_MOCK=1 to run offline
npm run dev                       # http://localhost:3000
npm run typecheck && npm run lint && npm run check && npm run test:extract && npm run test:api && npm run rehearse
npm run build && npm run check:static
EXTRACT_MOCK=1 DEMO_RESET_ENABLED=true DEMO_RESET_TOKEN=local-demo-token-1234 PORT=3100 npm run start
SMOKE_RESET_TOKEN=local-demo-token-1234 npm run smoke   # and npm run e2e, against the running server
```
