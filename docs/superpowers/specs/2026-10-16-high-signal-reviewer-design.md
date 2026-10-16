# nitpickr: high-signal, conversational, self-improving reviewer

Date: 2026-10-16. Status: approved for implementation via `/goal` (same day).

## Intent

nitpickr should post only comments a good teammate would post: real defects,
security, performance, reliability, design and outdated-API issues, each tied to
a concrete failure. Style is a linter's job. It should answer questions about
the repo, learn from conversations per project, sound like a person, and reach
an explicit end state on every PR. Everything runs on local models on the Mac
mini (Ollama, one request at a time), so every extra model call is wall-clock.

## Evidence this design rests on

- Developers rate defect, validation and edge-case comments "very useful"; the
  dominant cause of a useless comment is that it is wrong (Bosu, Greiler & Bird,
  MSR 2015). AI review comments are rejected 56% of the time, mostly false
  positives, redundancy, or ignoring intentional design (arXiv 2607.03316).
  Comments with inline suggestions get resolved most (arXiv 2607.21997).
- Prompt instructions like "skip nits" barely move output (Greptile, Graphite,
  cubic). Filters after generation work: a decision-first verifier (BitsAI-CR:
  77% precision at 1.7 s/finding vs 66% at 31 s reasoning-first) and an
  embedding filter over past up/downvoted comments per repo (Greptile: acted-on
  rate 19% -> 55%).
- Adversarial verification works when the verifier gets different evidence, not
  just a different persona (OpenCodeReview; Refute-or-Promote). Pure pushback
  makes models flip ~46% of answers (arXiv 2311.08596); debate does not beat
  voting (arXiv 2311.17371); asking the verifier for a fix inflates false alarms
  (arXiv 2603.00539).
- Review bots are being prompt-injected through PR titles/comments (CamoLeak,
  "Comment and Control", 2026). PR content is untrusted.
- Baseline evidence from dogfooding: nitpickr's review of PR #13 posted 15
  inline comments, mostly nits ("Node 24 LTS upgrade in CI", "rename
  variable"), including two contradicting comments on the same line.

## Goals (from `/goal`)

1. Eval suite >= 30 cases from active repos (Swift/SwiftUI, TS/Node/Astro,
   Python, Postgres) incl. clean, multi-round and prompt-injection PRs; one
   command on the mini; baseline recorded.
2. Precision >= 80% for medium+ findings; recall >= baseline; zero
   style/nitpick comments on the suite.
3. Adversarial verifier on every medium+ finding.
4. Median review time <= 2x baseline.
5. `@nitpickr <question>` answered by the model, grounded in the repo; first
   review comment lists commands.
6. Thread replies become repo-scoped pgvector memories; an eval proves a
   learning changes a later review.
7. Concise, human voice (owner approves a 20-comment sample).
8. Bugs fixed (see Milestone 1).

Non-goals: new SCM or cloud model providers; the marketing website; Railway.
Anti-goals: a reviewer that approves malicious PRs; a reviewer slower than a
human; comments that are right but not worth reading.

## Decisions

- **End state, not approval** (my call, reversible): when a round has no
  publishable findings and no open nitpickr threads, nitpickr posts a short
  "No further comments" review and a green check. No GitHub APPROVE event, so
  prompt injection cannot produce an approval.
- **Baseline = commit `e7aecec`** (main before this work). The eval suite is
  built in Milestone 2 and run against that commit in a worktree, so the
  baseline predates every behavior change even though Milestone 1 lands first.
- **Precision bar** stays at 80% as the goal states; Milestone 2 reports the
  baseline so we can see the distance.
- **Same model for verifier** (qwen3.6 35B-A3B), fresh context. A second model
  family is optional and only if evals show correlated blind spots, given the
  36 GB loaded-model ceiling.
- **Dogfood loop**: every milestone is a GitHub PR on this repo, reviewed by the
  live nitpickr. I triage each comment (fix + reply, or reply with a
  fact-based rebuttal citing the research, react 👍/👎), log a per-PR
  scorecard in `tasks/todo.md`, and turn notable comments into eval cases. No
  manual `@nitpickr review` after pushes. I never merge.

## Architecture changes

### Pipeline (worker review job)

```
context -> plan -> gather (memory, feedback, prior threads, file contents,
related symbols) -> generate (per chunk, lens-focused prompt) -> normalize ->
gate (scope, anchoring, type, severity floor, feedback, lint-class filter) ->
verify (medium+, one call each, capped) -> embedding feedback filter ->
budget -> reconcile prior threads (explicit verdicts) -> publish (inline +
summary + tips + end state) -> record
```

- Budget is applied last (after every filter).
- `#processReviewJob` is split into named stages as these change.

### Generation

- Lenses: security, performance, reliability, concurrency/correctness,
  design, data & migrations, modern usage, testing; checklists live in
  `src/review/lenses/` with stack-specific questions (Swift 6 concurrency,
  SwiftUI, SwiftData, Fastify/Node, Next.js server actions, Supabase RLS,
  Postgres migrations, Python asyncio). A lens is included when the chunk's
  file types make it relevant, keeping prompts short.
- Every finding must carry `evidence` (quoted lines from the patch/file) and a
  `failureScenario`. Findings without them are dropped deterministically.
- `style` category is removed from the schema; lint-class findings (naming,
  formatting, import order, comment wording, version bumps) are filtered.
- PR title/body/comments/diff are wrapped as untrusted data; HTML comments and
  invisible Unicode are stripped before prompting.

### Verifier

- Input: one finding's claim, the full current file, related definitions; not
  the generator's reasoning. Output, decision first:
  `{verdict: confirmed|refuted|uncertain, quotedLines, failureScenario,
  refutationReason, confidence: low|medium|high}`.
- Quote mismatch with the file -> refuted deterministically.
- confirmed -> publish; refuted with a concrete reason -> drop; uncertain ->
  downgrade one severity level (may fall under the floor).
- Only findings at/above the round floor and medium+, max 6 per review.

### Multi-round

- Prior threads get stable ids in the prompt; the model returns
  `priorThreadVerdicts: [{threadId, verdict: fixed|still_applies|obsolete}]`
  for threads whose lines changed (deterministic pre-check). Only `fixed` and
  `obsolete` threads are resolved; only `fixed` records positive feedback.
  Threads with no verdict stay open.

### Conversation

- `@nitpickr <free text>` (no recognized command) and replies in nitpickr
  threads go to a model-backed responder grounded in: the thread's finding,
  the file at HEAD, the PR diff, repo instructions and relevant memories.
- `reconsider` re-runs the verifier on that finding and replies with the
  verdict; `why`/`teach`/`fix` collapse into the free-form responder.
- First review summary ends with a collapsible "Talk to nitpickr" tips block.

### Learning

- Replies in nitpickr threads and answered conversations are queued as
  `memory_ingest` (the path exists but has no producer today); the classifier
  extracts learnings scoped to tenant + repository; replies say what was
  remembered.
- Human-resolved threads with no change on their lines record
  `resolved_without_code_change`.
- Embedding filter: before publishing, a finding similar (cosine >= 0.85) to
  >= 3 downvoted/dismissed past comments in the same repo is dropped; similar
  to upvoted ones is ranked up.

### Voice

- Comment template: one-line headline that states the problem, one or two
  sentences of impact with the failure scenario, optional suggestion block,
  collapsed "Prompt for AI agents". No "Where:" line (GitHub already anchors
  it), no emoji stacks, no hedging, no praise.
- Summary: two sentences max plus findings table; diagram only on full
  reviews of multi-file PRs.

## Milestones (one PR each, stacked if main lags)

1. **Bugs + end state**: budget after filtering (incl. severity floor);
   evidence gate scoped to publishable files; supersession only cancels
   automatic jobs for older commits; dedupe must not swallow a newer commit
   while an older one runs; explicit thread verdicts; "No further comments"
   end state.
2. **Eval suite + baseline**: pipeline-level live eval (gate, floor, budget,
   verifier, multi-round), >= 30 captured cases, injection cases, metrics
   (precision medium+, recall, nit count, latency), baseline on `e7aecec`.
3. **Verifier + lenses + lint filter + untrusted-content hardening.**
4. **Conversation.**
5. **Learning** (memory producer, resolved-without-change, embedding filter,
   learning eval case).
6. **Voice** (templates; 20-comment sample for owner approval).

## Left to the builder

Exact thresholds (verifier cap, cosine cutoffs) are tuned against the eval;
file/module layout follows existing conventions.
