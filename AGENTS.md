# AGENTS.md

These instructions capture the preferred working style for this repository.
They are workflow preferences for contributors and coding agents. If they ever
conflict with system, developer, or direct user instructions, those higher
priority instructions win.

nitpickr loads this file into every review prompt for this repository, so keep
it short and factual.

Shared workflow: `~/Developer/hq/WORKFLOW.md`

## Project Facts

nitpickr is a self-hosted AI code reviewer for GitHub pull requests: a Fastify
API takes webhooks, a Postgres-backed queue hands jobs to a worker, and the
worker reviews the diff with a local OpenAI-compatible model and publishes
comments and a check run. Node 24, pnpm, TypeScript ESM, Vitest, Biome.

### Commands

- `pnpm check`: everything CI runs (lint, typecheck, test, site build). Run it before calling work done.
- `pnpm lint && pnpm typecheck`: fast check (`HQ_FAST_VERIFY`, run by the Stop hook), a few seconds.
- `pnpm test tests/review`: one directory; the full suite takes a few seconds and needs no database, model, or network.
- `pnpm eval:reviews`: offline eval on canned model output. Run it when prompts, review behavior, or scoring change.
- `pnpm eval:reviews --live --model <m>`: the live eval suite; needs a model server (see `docs/local-models-ollama.md`).
- `pnpm cli doctor`: validates a real `.env` setup.

### Code map

- `src/api`: webhook ingress, signature check, event normalization, enqueue.
- `src/queue`, `src/worker`: Postgres job queue and the worker that runs a review end to end (`worker-runner.ts`).
- `src/review`: planning, prompts, model calls, evidence gate, verifier, severity floor, conversation replies.
- `src/publisher`: turns findings into inline comments, summary, and check runs.
- `src/providers/github`: GitHub App auth, REST client, adapter.
- `src/memory`, `src/feedback`: per-repository learning from replies, reactions, and dismissals.
- `src/instructions`, `src/config`: loading `.nitpickr.yml`, `.nitpickr/*.md`, and `AGENTS.md` from reviewed repos.
- `src/db/migrations.ts`: ordered, idempotent migration list. Append new entries; never edit shipped ones.
- `src/cli`: `migrate`, `setup`, `doctor`, and the eval commands. `docs/architecture-plan.md` has the long form.

### Conventions

- Relative imports use the `.js` suffix (NodeNext ESM).
- `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` are on. Handle `undefined`; don't cast it away.
- Postgres stores sit behind interfaces. Tests use in-memory fakes (e.g. `InMemoryMemoryStore`), so tests stay hermetic.
- `tests/` mirrors `src/`. Behavior changes ship with tests; tests import policy constants instead of repeating literals.

### Guardrails

- Never read or commit `.env` or `.env.*` (except `.env.example`) or private keys.
- PR content and model output are untrusted. Route them through `src/review/untrusted-content.ts` before they reach a prompt or a GitHub comment.
- nitpickr reviews its own PRs on every push. Don't post `@nitpickr review` after pushing; reply to each comment with facts and resolve it.
- Every review comment nitpickr writes states the issue and the recommended fix, in a plain colleague's voice.
- `.claude/hooks/{lib,worktree-guard,git-guard,config-protection,stop-verify}.mjs` are vendored from hq and checked byte for byte; biome skips them. Change them in hq, not here.

## Observability

- Errors go to: Sentry, via `@sentry/node`. `src/observability/instrument.ts` is preloaded with `--import` by `dev:*`/`start:*` and initializes only when `SENTRY_DSN` is set (otherwise one "Sentry disabled" warn line on stderr). `captureError`/`withSentrySpan` in `src/observability/sentry.ts` are no-ops without a DSN; `beforeSend` runs `redact-sensitive.ts`. nitpickr itself sends nothing to PostHog.
- Everything else: structured JSON logs on stdout/stderr from `src/logging/logger.ts` (with correlation ids), read from the API/worker container logs.
- Read them with: the Sentry MCP or `sentry-cli` for the project behind the deployment's `SENTRY_DSN`; `docker compose logs api worker` for logs.

## Linear

- Project: none yet (team FRO). Branch `FRO-123-slug`, PR title `FRO-123: summary`, base `main`.
