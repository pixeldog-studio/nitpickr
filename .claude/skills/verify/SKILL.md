---
name: verify
description: Prove a nitpickr change works before calling it done. Runs the same checks as CI and, when review behavior changed, the offline eval compared against main. Use before committing, opening a PR, or claiming a task is complete.
---

# Verify a nitpickr change

1. Run `pnpm check`. It runs exactly what CI runs: lint, typecheck, tests, site build.
   If it fails, fix the cause and rerun. Don't report success with a red step.
2. List changed files with `git diff --name-only origin/main...HEAD` plus `git status --short`.
3. If anything under `src/review/`, `src/eval/`, `src/memory/`, or the prompt text changed, run
   `pnpm eval:reviews` on this branch and on `origin/main` (a temporary `git worktree add`)
   and compare the metrics. Report any metric that got worse.
4. If a behavior changed, confirm a test covers it: break the change briefly, check that a test fails,
   then restore it.
5. Report the commands you ran and paste their summary lines (test counts, eval metrics).
   Say plainly what you did not verify, for example the live model eval or a real GitHub round trip.
