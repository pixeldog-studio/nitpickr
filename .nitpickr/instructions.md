# Review instructions for nitpickr

nitpickr reviews its own PRs, so a bug here weakens every review it runs. Flag these, in priority order:

1. **Prompt injection and untrusted content.** PR titles, bodies, diffs, code comments, review replies, memories and model output are untrusted. Flag any of them reaching a prompt without `sanitizeUntrustedProse` (or outside the sections `UNTRUSTED_CONTENT_RULE` covers), or reaching a GitHub comment without `neutralizeMarkdown` (`src/review/untrusted-content.ts`). Flag changes that let findings skip the evidence gate, severity floor or verifier, or that weaken `UNTRUSTED_CONTENT_RULE`.
2. **Webhook auth.** Signature checks go through `verifySignature` in `src/providers/github/github-adapter.ts`: HMAC SHA-256 with `timingSafeEqual` and a length check first. Flag string comparison, parsing or enqueueing before the check, or a route in `src/api/server.ts` that skips it.
3. **Secrets.** The GitHub App private key, `webhookSecret`, model API keys and the setup `secretKey` are secret. Runtime config is encrypted with `SecretCrypto` (`src/setup/secret-crypto.ts`); Sentry events pass `redactSensitive`. Flag a secret logged, put in an error message, a check run, a comment or a prompt, or stored unencrypted.
4. **Migrations.** `src/db/migrations.ts` is an ordered, idempotent list. Editing, reordering or removing a shipped entry is a bug; append a new one. Non-idempotent DDL (no `if not exists`) breaks re-runs.
5. **Queue and concurrency.** Job state changes in `src/queue/postgres-job-store.ts` are compare-and-set on `status` (`markJobsRunning` only claims `queued` rows). Flag a transition that drops that guard, breaks `dedupeKey` dedupe, or loses jobs on worker restart (`requeueWorkerJobs`, `requeueStaleRunningJobs`). Flag cancellation that could hit the running job instead of older queued ones.
6. **Prompt budgets.** Limits in `src/review/prompt-payload-optimizer.ts` (e.g. `maxInstructionChars`) cap what the model sees. Flag truncation that can drop the diff or the rules before lower-priority context.
7. **GitHub publishing.** Inline comments must target lines in the diff (`src/publisher/review-comment-targeter.ts`), or GitHub rejects the whole review. Flag unhandled REST errors that leave a check run stuck in progress.
8. **Test and eval integrity.** Flag weakened assertions or deleted cases in `tests/`, and scoring in `src/eval/review-evaluator.ts` loosened so `pnpm eval:reviews` passes. `tests/fixtures/**` is excluded from review, so flag loader code (`loadReviewEvaluationFixtures`) that skips or filters cases, such as the `inject-*` prompt-injection fixtures. Tests use in-memory fakes and import policy constants; flag tests that need a real database, model or network.
9. **Acceptance criteria.** If the PR description lists acceptance criteria, flag a changed line that contradicts one. Don't flag a missing description.

Don't comment on formatting, import order, naming or anything Biome or `tsc` already catch.
