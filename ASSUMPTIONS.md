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
