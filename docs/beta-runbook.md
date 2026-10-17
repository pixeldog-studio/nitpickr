# nitpickr Beta Runbook

## First-Run Checklist

1. Run `pnpm cli doctor`.
2. Start the stack with `docker compose up --build`.
3. Verify `curl http://localhost:3000/healthz` returns `{"ok":true}`.
4. Verify the GitHub App webhook URL ends with `/webhooks/github`.
5. Open a PR and confirm:
   - `api` logs a queued webhook
   - `worker` logs a claimed job
   - GitHub shows a `nitpickr/review` status

## Logs to Watch

- `Queued GitHub review job.`
  - Webhook was accepted and enqueued.
- `Claimed worker job.`
  - A worker picked up the review.
- `Published pending review status.`
  - GitHub status checks are active.
- `Generated review result.`
  - The model server returned a usable review payload.
- `Published review result.`
  - GitHub review body and inline comments were posted.
- `Published failed review status.`
  - The run failed and GitHub was updated.
- `Superseded queued review jobs for newer head SHA.`
  - Older queued work was canceled after a new push.

## Common Failure Modes

### Webhook reaches GitHub but nothing happens

- Run `docker compose logs -f api`.
- Check for:
  - invalid signature
  - ignored webhook event
  - missing bot mention/command
  - repository not in `NITPICKR_REPOSITORY_ALLOWLIST` (answered `202` and
    ignored, with no mention reaction)

### Worker never publishes a review

- Run `docker compose logs -f worker`.
- Check for:
  - `config_setup`
  - `github_api`
  - `model_output`
  - `publish_failure`

### Local model (Ollama) reviews fail or never finish

- Boot fails naming `NITPICKR_*` replacements: the `.env` still uses the old
  `OPENAI_*` names. Rename them (see `.env.example`) and set
  `NITPICKR_REVIEW_MODEL`.
- `model.chat_completion failed` with status 404: the model tag in
  `NITPICKR_REVIEW_MODEL` / `NITPICKR_MEMORY_MODEL` is not pulled — compare
  with `curl $NITPICKR_MODEL_BASE_URL/models`.
- `model.chat_completion invalid_json` twice in a row: the model is not
  honouring structured (JSON Schema) output; the job is retried automatically
  with exponential backoff (30 s base, capped at 15 min). Try a larger model or
  `NITPICKR_MODEL_REASONING_EFFORT=none`.
- `model.chat_completion transport_error ... TimeoutError`: raise
  `NITPICKR_MODEL_REQUEST_TIMEOUT_MS`, lower
  `NITPICKR_REVIEW_CHUNK_MAX_TOTAL_CHARS`.
- `memory_embedder.embed dimension_mismatch`: `NITPICKR_EMBEDDING_DIMENSIONS`
  does not match `NITPICKR_EMBEDDING_MODEL`; fix it and re-run `migrate`.
- `memory_embedder.model_load_failed`: the in-process embedding model could not
  load (not baked into the image, or no network on a native run); rebuild the
  image or set `NITPICKR_EMBEDDING_MODEL=off`.
- Full guide: [local-models-ollama.md](local-models-ollama.md).

### GitHub review appears twice

- Confirm the review body contains the hidden `nitpickr:review-run` marker.
- Check worker logs for retries or duplicate webhook delivery.

### Status check missing

- Run `pnpm cli doctor`.
- Confirm the GitHub App has pull request write permission and correct webhook settings.

## Recovery Steps

- Bad env/config: fix `.env`, rerun `pnpm cli doctor`, restart Compose.
- Stuck containers: `docker compose down && docker compose up --build`.
- Schema drift after upgrade: `pnpm cli migrate`.
- New push not reviewed: trigger `@nitpickr recheck` on the PR.
