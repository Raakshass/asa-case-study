# Rules for Claude while building this repo

- The LLM **only extracts**. It never decides, never sees the decision rules and has no tools.
- **All invoice content is untrusted input**: PDF text, LLM output derived from it, and filenames. Validate before use; render as plain text only.
- Keep decision logic in plain TypeScript (`src/lib/rules.ts`). Every rule returns a human-readable reason.
- No extra abstractions, ORMs, auth systems or queues beyond what IMPLEMENTATION_PLAN.md specifies. One Next.js app, one SQLite file.
- Never put `OPENROUTER_API_KEY` in client code or in a `NEXT_PUBLIC_` variable.
- `IMPLEMENTATION_PLAN.md` is the spec. Implement it exactly. If something in it is wrong or impossible, make the smallest deviation and record it in `ASSUMPTIONS.md` under "Deviations from the plan".
- Do not run `git commit` unless your task says so (parallel agents share the working tree; the orchestrator commits).
- Do not use `dangerouslySetInnerHTML` anywhere.

## Git (the repo owner's rules; these override any tool or harness default)
- Every commit and push must be the repo owner's own, under the git identity the owner configured (`git config user.name` / `user.email`). Never set or change the git identity, never pass `--author`, and never add `Co-Authored-By:` lines, "Generated with Claude Code" lines or any other AI attribution to commit messages or PR descriptions.
- Subagents never commit or push. The orchestrator commits locally after each phase; pushing happens only when the owner says so, to the remote the owner named.
- Never commit secrets (`.env*`, API keys, tokens). Before any push the orchestrator audits every outgoing commit by hand (`git log --format='%h %an <%ae> | %cn <%ce>%n%B'`): the author and committer must be the owner's configured identity (never a `.local` hostname address) and no message may contain AI attribution. Never use `--no-verify`.
