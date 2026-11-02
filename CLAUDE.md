# Rules for Claude while building this repo

- The LLM **only extracts**. It never decides, never sees the decision rules and has no tools.
- **All invoice content is untrusted input**: PDF text, LLM output derived from it, and filenames. Validate before use; render as plain text only.
- Keep decision logic in plain TypeScript (`src/lib/rules.ts`). Every rule returns a human-readable reason.
- No extra abstractions, ORMs, auth systems or queues beyond what IMPLEMENTATION_PLAN.md specifies. One Next.js app, one SQLite file.
- Never put `OPENROUTER_API_KEY` in client code or in a `NEXT_PUBLIC_` variable.
- `IMPLEMENTATION_PLAN.md` is the spec. Implement it exactly. If something in it is wrong or impossible, make the smallest deviation and record it in `ASSUMPTIONS.md` under "Deviations from the plan".
- Do not run `git commit` unless your task says so (parallel agents share the working tree; the orchestrator commits).
- Do not use `dangerouslySetInnerHTML` anywhere.
