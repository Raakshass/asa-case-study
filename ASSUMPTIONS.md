# Assumptions

Running list; referenced in the interview.

- USD only (single currency).
- PO amounts are pre-tax; invoices are compared to PO on **subtotal**.
- Held invoices do **not** consume PO balance (only APPROVE does).
- Price tolerance is 2% over the PO (remaining balance, and per-line unit price).
- Demo tax rate is 10%, shown separately unless a sample says otherwise.
- Inferred POs (invoice has no PO reference) always require a human to confirm.
- Security flags always HOLD. A security-flagged run can never be APPROVE.
- Demo has no user auth (single tenant). The reset endpoint is token-guarded.
- Bank details are only ever taken from the vendor master; the invoice's bank account is only compared.
- Runs are append-only; re-processing creates a new run.

## Deviations from the plan

(Add an entry here whenever the implementation deliberately differs from IMPLEMENTATION_PLAN.md, with the reason.)

- Project lives in `asa-case-study/` under the workspace root.
- No OpenRouter key was available in the build environment, so live extraction could not be run during the build. An offline **mock extractor** (`EXTRACT_MOCK=1`, truth-JSON driven) exists purely so the pipeline/UI can be exercised end to end; it is never the default and the run's `model` column shows `mock`.
- Railway deploy could not be executed from the build environment; deploy config + instructions are prepared instead.
- Phase 0: `.gitignore` also has `!.env.example` after `.env*` so the example env file stays tracked (the plan only says to ignore `.env*`). It also ignores `data/app.db-*` (SQLite WAL/SHM files) and keeps `data/uploads/.gitkeep`.
- Phase 0: create-next-app refuses a non-empty directory, so it was run in a scratch dir and the files moved in (no existing file overwritten). Scaffolded with `--no-turbopack` (plain webpack `next dev` / `next build`).
- Phase 0: the current shadcn CLI (4.x) was initialised with `--base radix --preset nova` (style `radix-nova`, neutral base colour, lucide icons). It writes `src/lib/utils.ts` as `export { cn } from "cn"` and adds the `cn` npm package (maintained by shadcn, repo shadcn-ui/cn) instead of `clsx` + `tailwind-merge`. Left as generated.
- Phase 0: the Geist font CSS variable in `src/app/layout.tsx` was renamed from `--font-geist-sans` to `--font-sans`, because the generated `globals.css` maps `--font-sans: var(--font-sans)` and would otherwise be self-referential.
- Phase 0: `unpdf` and `pdf-lib` do not need `serverExternalPackages`; a throwaway route importing both plus `better-sqlite3` built and ran under `next start`. Only `better-sqlite3` is listed.
- Contracts: `suspicious_content` items may be up to 500 characters (max 20 items) instead of the general 200-character string limit, so a verbatim quote of an injection (sample #9's is about 190 characters) never turns into "invalid output" and loses the evidence.
- Contracts: a confidence outside 0..1 is invalid output (retry, then fallback); the plan's "clamped" is read as "bounded". Clamping would silently turn a percentage like 85 into 1.0 and weaken the low-confidence check.
- Contracts: `decide()` treats a `warn` with severity `hold` as HOLD. The plan lists the inferred PO (stage 7) as a warning that HOLDs, but its precedence list only mentions fails; this reconciles the two.
- Contracts: decision reasons are ordered decisive first (reject, then hold/error, then info notes), stage order within each group, so `reasons[0]` (the dashboard's top reason) explains the decision, e.g. the duplicate for #4 rather than the PO balance.
- Contracts: each pre-loaded history invoice gets a synthetic `done` run (model `history`, deterministic RFC 9562 UUID, no steps) so dashboard rows link to a run view; `invoices.id` equals the run id for every row.
- Contracts: a run interrupted by a restart keeps `decision` NULL (it never decided); its running step becomes `error` and its pending steps `skipped`. It writes no invoices row, so a re-run is not a duplicate.
- Contracts: owner-password-only PDFs (they open without a password) are still detected as encrypted and HOLD. Conservative, matches plan 6.1.
- Contracts: `DEMO_RESET_TOKEN` shorter than 16 characters counts as unset, so `/api/reset` is refused (an empty token must never match an empty header).
- Contracts: seed, samples and fixtures are read from `<project root>/data` regardless of `DATA_DIR`; only `app.db` and `uploads/` live under `DATA_DIR`. On Railway the volume should therefore be mounted outside `/app/data` (Phase 8).
