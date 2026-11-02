# Contract changes

Append-only log of changes to anything frozen in `docs/CONTRACTS.md` (an exported signature or type, a JSON shape, a row convention, a file's ownership) and of requests for such changes (including new npm dependencies). Make the smallest change that works, add an entry here, and mention it in your phase report. Never edit or delete an earlier entry.

Entry format:

```
## <YYYY-MM-DD> <phase> - <file or shape>
- Before: <old signature / shape>
- After: <new signature / shape>  (or "Requested, not applied")
- Why: <one or two sentences>
- Affects: <phases / files that must adapt>
```

## 2026-11-03 contracts step - initial contracts
- Before: (none)
- After: `docs/CONTRACTS.md` sections 0-10; real modules `src/lib/{types,json-schema,format,config,db,seed,master,samples}.ts`; typed stubs for `pdf` (validateUpload), `guardrails`, `extract`, `extract-mock`, `normalize`, `rules`, `pipeline`, `ratelimit`; `scripts/check.ts` with groups `contracts`, `business`, `guardrails`.
- Why: lets Phases 1-6 work in parallel.
- Affects: everyone.

## 2026-11-03 Phase 2 - src/lib/extract.ts (options of extractInvoice / suggestPO, new exports)
- Before: `extractInvoice(pdf: Uint8Array, opts?: ExtractOptions)`; `interface SuggestPoOptions { models?: readonly string[] }`.
- After: `extractInvoice(pdf: Uint8Array, opts?: ExtractCallOptions)` with `interface ExtractCallOptions extends ExtractOptions, LlmCallHooks {}` and `interface LlmCallHooks { endpoint?: string; timeoutMs?: number; sleep?: (ms: number) => Promise<void> }`; `interface SuggestPoOptions extends LlmCallHooks { models?: readonly string[] }`. Both functions are still assignable to `ExtractFn` / `SuggestPoFn`. `endpoint` is refused (result `unreadable` / `failed`, no fetch) unless it is the OpenRouter URL or an http(s) loopback URL, so the key can never be aimed at another host. New exports: `hasApiKey()`, `MODEL_PROFILES`, `ModelProfile`, `ChatRequestBody`, `OPENROUTER_URL`, `SUGGEST_PO_SYSTEM_PROMPT`, `pdfEngineFor`, `pdfDataUrl`, `buildExtractRequestBody`, `buildSuggestPoRequestBody`.
- Why: `scripts/test-extract.ts` must aim the real code path at a local fake OpenRouter with a short timeout and a no-wait sleep, and `ExtractOptions` lives in `types.ts` (frozen), so the optional hooks are declared in `extract.ts`. `hasApiKey()` lets `eval-extract.ts` explain a missing key without reading `OPENROUTER_API_KEY` outside `extract.ts`.
- Affects: nobody (every existing call still type-checks; the pipeline never sets the hooks).

## 2026-11-03 Phase 2 - src/lib/extract-mock.ts (behaviour of mockExtractInvoice; new export)
- Before (JSDoc written by the contracts step): bytes that are not a generated sample -> `{ ok: false, kind: "unreadable", message: "Mock extractor: not one of the generated samples" }`; `EXTRACT_MOCK=fooled` applied `_meta.injectedValues`, cleared `suspicious_content` and set every confidence to 1.0.
- After (as the Phase 2 task specified): unknown bytes -> `ok: true` with a clean `{ document_type: "other" }` extraction (every confidence 0.1, a note that the file is not a generated sample, `model: "mock"`, cost 0), so the pipeline HOLDs it as "not an invoice"; `ok: false, kind: "unreadable"` only when the truth data itself cannot be loaded. `fooled` applies `_meta.injectedValues` and sets every confidence to 1.0 but KEEPS `suspicious_content`. The hash index is rebuilt on a miss (PDFs may appear after the first call). New export `resetMockIndex()` (tests).
- Why: an upload that is not a sample should end in the normal "not an invoice" HOLD instead of an extraction error while `EXTRACT_MOCK` is set; keeping `suspicious_content` in fooled mode makes #9 fail the extract stage exactly as in the truth case, on top of the screen and the grounding check.
- Affects: Phase 5 (pipeline checks with `EXTRACT_MOCK`) and Phase 7 demos. The one-line switch to the old fooled behaviour is in `applyInjection()` (`extract-mock.ts`).

## 2026-11-03 Phase 3 - src/lib/normalize.ts (new export, no change to a frozen signature)
- Before: exports `VENDOR_SUFFIXES`, `normalizeInvoiceNumber`, `normalizeDate`, `normalizeVendorName`, `resolveVendor`, `normalizePoReference`, `normalizeCurrency`, `normalizeInvoice`.
- After: the same, plus `findVendorMatches(name: string | null, vendors: readonly Vendor[]): Vendor[]` (every distinct vendor whose normalized name or alias equals the normalized name; 2+ entries = ambiguous). `resolveVendor` is unchanged in signature and now returns null for an ambiguous name. Step `detail` objects of `rules.ts` carry extra evidence fields beyond the types.ts detail interfaces (additive: `lines`, `within_tolerance`, `price_within_tolerance`, `amount_source` on amounts; `problem`, `printed_po` on po_match; `days_apart`, `original_decision` on duplicate; `document_type`, `line_sum`, `expected_total`, `today` on validate).
- Why: `checkVendor` must tell "no such vendor" (reject, onboarding) from "two vendors match" (hold) without guessing; the evidence fields are what the run view shows as key-value pairs.
- Affects: nobody has to adapt. docs/CONTRACTS.md section 5 (generated from the code) may list `findVendorMatches` under normalize.ts.

## 2026-11-03 Phase 4 - src/lib/pdf.ts and src/lib/guardrails.ts (new exports; JSDoc behaviour made precise; no frozen signature changed)
- Before: `pdf.ts` exported the tested primitives plus a `validateUpload` stub; `guardrails.ts` exported nine stubs.
- After: every existing export keeps its signature. New exports in `pdf.ts`: `UPLOAD_TIMEOUT_MS` (10 s), `MAX_TEXT_ITEMS` (100,000), `MAX_TEXT_CHARS` (1,000,000), `UPLOAD_REASONS`, `tooLargeReason()`, `tooManyPagesReason()`, `validateUploadWithin(buf, timeoutMs, limits?)` (what `validateUpload` calls with `UPLOAD_TIMEOUT_MS`) and `uploadFailureFromError()`. `validateUpload` never throws and, besides the JSDoc's reasons, answers "PDF is damaged or unreadable" (code `damaged`, REJECT) for a PDF with no pages, a pdf-lib / pdf.js page-count disagreement, a text layer over the two caps, and a parse that outlives its budget. `getTextItems` returns the same items as before but reads pdf.js's chunked stream. `screenPdf` / `buildGroundingText` put a newline between pages; `injectionHits` snippets whose context overlaps share one snippet (at most 20, each at most 200 characters) and `hiddenText` keeps at most 10 runs of at most 500 characters; `isImageOnly` / `textChars` ignore zero-width, format and control characters. Details and measurements are in ASSUMPTIONS.md ("Phase 4" bullets).
- Why: the plan's 6.1 / 6.2 / 6.4 controls had to hold against hostile files (decompression-style text floods, quadratic regexes, parser disagreement), and the screen result is stored as a step detail that the UI polls.
- Affects: Phase 5 only as information: stage 1 can now take up to `UPLOAD_TIMEOUT_MS` on a hostile file (the result is still an ordinary `UploadValidation`), and nothing in `rules.ts` changes. Requested, not applied: move the three limits into `CONFIG` (`config.ts` is frozen); until then they live next to their only user.

## 2026-11-03 integration - src/lib/config.ts (new CONFIG key)
- Before: `CONFIG` had no tax threshold.
- After: `CONFIG.maxTaxRate: 0.1` (additive; every existing key and value unchanged). Read by `rules.ts` checkValidate: tax above this share of the pre-tax amount (+ `arithmeticTolerance`), or any tax on a pre-tax amount of $0 or less, is a validate problem (HOLD).
- Why: red-team finding RT-RULES-04: the tax line was never bounded, so a 20% or 100% "tax", or $500 of tax on $0 of goods, was approved for the full total. The threshold belongs with the other business thresholds.
- Affects: nobody has to adapt. Requested, not applied: docs/CONTRACTS.md section 5 (generated from the code) does not list `maxTaxRate` yet; regenerate it.

## 2026-11-03 integration - src/lib/pdf.ts + new src/lib/pdf-text-worker.mjs (validateUpload's text read isolated; new exports)
- Before: `validateUpload` read the pdf.js text layer in-process (`readPdfText`).
- After: same signatures and the same results (scripts/checks/guardrails.ts compares the worker's items with `getTextItems` on every sample). The pdf.js read inside `validateUpload` runs in a worker thread started from `src/lib/pdf-text-worker.mjs` (plain JS, loaded by path: `<__dirname>` or `<cwd>/src/lib`), terminated at the deadline; heap cap `TEXT_WORKER_HEAP_MB` (256) and an RSS growth watchdog `TEXT_WORKER_MAX_GROWTH_MB` (256), both new exports. A file stopped by a cap is "PDF is damaged or unreadable" (code `damaged`, REJECT), like the other limits. Text reads are queued and run one at a time on one warm worker (unref'd, so scripts still exit); a queued read keeps its own deadline, so concurrent `validateUpload` calls still work, they just read one after another. No worker available -> the old in-process read, logged once. `getTextItems` is unchanged (in-process, no limits).
- Why: red-team finding RG-1: a 157 KB in-limit PDF of non-text operators blocked the whole event loop for 8.5 s (26.7 s for a 468 KB one) and grew the process to ~600-900 MB; the deadline timer could not fire until pdf.js finished.
- Affects: Phase 5/8: nothing to change in code; the deploy image must contain `src/lib/pdf-text-worker.mjs` and `node_modules/unpdf` at run time (a normal `next start` from the repo does). Unverified under `next build` / `next start` (not allowed in this step).

## 2026-11-03 integration - src/lib/rules.ts (behaviour + additive step-detail fields; no signature changed)
- Before: see the Phase 3 entry.
- After: new HOLD conditions from the red-team review: line arithmetic (RT-RULES-01), lines not on the PO and billed $0 PO lines (RT-RULES-03), the tax ceiling (RT-RULES-04), exact unit-price ratios (RT-RULES-05). Soft duplicates compare like with like (RT-RULES-02). `nextAction()` gives "Manual data entry required." only for extraction-type validate problems (RT-RULES-07). Additive detail fields: validate `problem_kinds`, `pretax_amount`; amounts `unmatched_lines`, `unmatched_total`, `unmatched_within_tolerance`, `approved_invoice_count`, `lines[].price_source`, and `lines[].over_pct` may be null (a PO line priced $0). `detail.approved_invoices` (AmountsDetail) is capped at 20 entries and the over-billing reason names at most 5 (RT-RULES-08). The plan's reason phrases (docs/CONTRACTS.md 3.3) are unchanged; all 10 samples keep their expected decisions.
- Why: the red-team repros (critical: padded line amounts, unmatched lines, subtotal-vs-total duplicates; high: unbounded tax, sub-cent rounding) each approved money that should not be paid.
- Affects: Phase 6 (run view) may show the new evidence fields; nothing else has to adapt.

## 2026-11-03 integration - src/lib/normalize.ts and src/lib/guardrails.ts (behaviour only)
- Before / After: `normalizeVendorName` also folds "limited liability company/co", "proprietary limited" and "proprietary" (RT-RULES-06). `scanInjection` reads dash and colon look-alikes as "-" and ":" and, for a text with invisible characters, scans the invisibles-removed text once more with every pattern space optional (RG-3). Signatures unchanged.
- Why: red-team findings RT-RULES-06 (an approved vendor's full legal name was rejected for onboarding) and RG-3 (mixed invisible characters and punctuation look-alikes evaded the scan).
- Affects: nobody.

## 2026-11-03 integration - check files (tests changed where they asserted the defect)
- `scripts/checks/business.ts`: `consulting()` (balance-only fixture) now has no line items (its single unmatched line would hold on its own since RT-RULES-03); the pairing test asserts "not paired" through `unmatched_lines` instead of a `pass` status; the duplicate test that asserted "400 is not 440" (subtotal vs total, the RT-RULES-02 defect) now expects a soft duplicate and adds a different-total negative case; the AmountsDetail deep-equal lists the new fields. Eight `red team RT-RULES-0n` tests added.
- `scripts/checks/guardrails.ts`: the late-deadline test asserted `late.ms > 50` (the in-process run could not return before pdf.js finished); with the worker it returns AT the deadline, so it now asserts 40 <= ms < 400. Five tests added (worker items equal the in-process reader's; an op flood does not block the loop; a decompression bomb stays bounded in time and memory; 16 concurrent uploads all pass; RG-3 evasions with false-positive controls).
- New: `scripts/rehearse.ts` (offline end-to-end rehearsal of CONTRACTS 4.1/4.2 on the 10 samples, truth and fooled mock).
