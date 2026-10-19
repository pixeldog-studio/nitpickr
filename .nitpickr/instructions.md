# Review instructions for nitpickr

nitpickr reviews its own PRs; a bug here weakens every review. Flag, in priority order:

1. **Prompt injection and untrusted content.** PR text, diffs, replies, memories and model output are untrusted. Prose (title, body, replies, memories) reaches a prompt through `sanitizeUntrustedProse`; code (patches, file contents) through `revealInvisible`, which shows bidi/zero-width characters instead of deleting them. Model text reaches GitHub through `neutralizeProse` (`src/publisher/review-publisher.ts`) or `neutralizeMarkdown`. Flag a path that skips these, or sanitizes code with the prose sanitizer. Flag changes that let findings skip the evidence gate, severity floor or verifier outside eval replay, or weaken `UNTRUSTED_CONTENT_RULE`.
2. **Webhook auth.** `POST /webhooks/github` (`src/api/server.ts`) verifies via `verifyWebhookSignature` in `src/providers/github/github-adapter.ts`: HMAC SHA-256, length check, then `timingSafeEqual`. Flag string comparison, enqueueing or acting on the payload before the check, or a route that skips it.
3. **Secrets.** The GitHub App private key, `webhookSecret`, model API keys and `NITPICKR_SECRET_KEY` are secret. Runtime config is encrypted with `SecretCrypto` (`src/setup/secret-crypto.ts`); Sentry events pass `redactSensitive`. Flag a secret in logs, errors, check runs, comments or prompts, or stored unencrypted.
4. **Migrations.** `src/db/migrations.ts` is an ordered list re-run in full on every migrate (no version table), so an edited entry never reaches existing databases. Append a new one; DDL must be idempotent (`if not exists`).
5. **Queue and concurrency.** In `src/queue/postgres-job-store.ts`, claim, requeue and cancel transitions are compare-and-set on `status` (`markJobsRunning` only claims `queued` rows). Flag a transition that drops that guard, breaks `dedupeKey` dedupe, or loses jobs on worker restart (`requeueWorkerJobs`, `requeueStaleRunningJobs`).
6. **Prompt budgets.** Flag truncation in `src/review/prompt-payload-optimizer.ts` that drops the diff or rules before lower-priority context.
7. **GitHub publishing.** Inline comments must target lines in the diff (`src/publisher/review-comment-targeter.ts`), or GitHub rejects the whole review. Flag unhandled REST errors that leave a check run stuck in progress.
8. **Test and eval integrity.** Flag weakened assertions or deleted cases in `tests/`, and loosened scoring in `src/eval/review-evaluator.ts`. `tests/fixtures/**` is excluded from review, so flag loader code (`loadReviewEvaluationFixtures`) that skips or filters cases, such as the `inject-*` prompt-injection fixtures. Flag tests that need a real database, model or network.
9. **Acceptance criteria.** If the PR description lists acceptance criteria, flag a changed line that contradicts one. Don't flag a missing description.

Don't comment on formatting, import order, naming or anything Biome or `tsc` already catch.
