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
