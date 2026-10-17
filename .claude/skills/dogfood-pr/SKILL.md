---
name: dogfood-pr
description: Open a nitpickr PR and run the dogfood loop, where the live nitpickr reviews its own PR, each comment is triaged with facts, and an independent review runs before merge. Use when shipping a change to this repository.
---

# Dogfood a nitpickr PR

nitpickr reviews its own pull requests. The bot posts as `nitpickrai[bot]` and its
check run is `nitpickr / review`. Every review is data about its quality.

1. **Ship it ready.** Run the `verify` skill first. Branch off `main` and use a plain-English
   commit title that says what changed for the user. Open the PR with `gh pr create`, using
   `.github/pull_request_template.md`.
2. **Wait, don't ping.** A push already triggers a review, so never post `@nitpickr review` after
   pushing. Watch `gh pr checks <n>` until `nitpickr / review` and `checks` finish.
3. **Read everything it said:**
   - inline: `gh api repos/{owner}/{repo}/pulls/<n>/comments`
   - summary: `gh api repos/{owner}/{repo}/pulls/<n>/reviews`
   - other comments: `gh api repos/{owner}/{repo}/issues/<n>/comments`
4. **Triage each comment against the code, not the wording:**
   - Valid: fix it, rerun `pnpm check`, push, then reply with what changed and the commit.
   - Wrong or a nit: reply with the fact that shows why. Don't argue tone.
   - React 👍 (valid) or 👎 (wrong). nitpickr learns per repository from these reactions.
   - Resolve the thread once it's handled.
5. **Independent review.** Before merge, run a fresh code-review subagent over
   `gh pr diff <n>`. nitpickr has missed real bugs that this caught. Fix what it confirms.
6. **Log it.** Add a row to the dogfood scorecard in `tasks/todo.md`:
   comments, valid, nits, wrong, missed (found by the independent review), notes.
7. **Merge only with the owner's go-ahead,** unless they've already given it for this effort.
