# Local models via Ollama

nitpickr is local-models-only: it calls its model through the
`/v1/chat/completions` protocol (the OpenAI-compatible chat API), so any server
that speaks it works: Ollama, vLLM, LM Studio, llama.cpp server. Memory
embeddings run inside the worker and need nothing from the model server. This
page covers Ollama on the same machine (or LAN) as the nitpickr worker.

## What the worker needs from the model server

| Call | Endpoint | Used for | Requirements |
| --- | --- | --- | --- |
| Review | `POST /chat/completions` | Findings + summary per review chunk | `response_format: {type: "json_schema", strict: true}` honoured (falls back to lenient JSON extraction); a chat model that returns valid JSON |
| Memory classifier | `POST /chat/completions` | Turning discussion into memory entries | Same as review; small prompts |

Memory embeddings do **not** use the model server: the worker runs
`nomic-ai/nomic-embed-text-v1.5` in-process (transformers.js, ONNX on CPU) —
see [In-process embeddings](#in-process-embeddings).

Only the **worker** talks to the model server; the API only enqueues jobs.

## Recommended settings

```dotenv
NITPICKR_MODEL_BASE_URL=http://host.docker.internal:11434/v1  # worker in Docker → host Ollama
# NITPICKR_MODEL_BASE_URL=http://localhost:11434/v1           # worker running natively (default)
# NITPICKR_MODEL_API_KEY=                                     # only for servers that need a bearer token
NITPICKR_REVIEW_MODEL=qwen3.8:27b-nvfp4                       # required; also runs the verifier
NITPICKR_MODEL_REASONING_EFFORT=none                          # thinking models: none|low|medium|high
# NITPICKR_MEMORY_MODEL=                                      # classifier; defaults to the review model
# NITPICKR_EMBEDDING_MODEL=nomic-ai/nomic-embed-text-v1.5     # in-process; or "off"
# NITPICKR_EMBEDDING_DIMENSIONS=768                           # nomic-embed-text-v1.5 = 768 (default)
NITPICKR_MODEL_REQUEST_TIMEOUT_MS=600000                      # 10 min; output is capped at 6k tokens
NITPICKR_MODEL_MAX_CONCURRENT_REQUESTS=1               # Ollama serves one request at a time
NITPICKR_REVIEW_CHUNK_MAX_TOTAL_CHARS=160000           # ≈40k tokens per chunk
NITPICKR_JOB_STALE_AFTER_MS=120000                     # recover a dead worker's job after 2 min
# NITPICKR_INLINE_POLICY=confirmed                     # default: only verifier-confirmed findings go inline; the rest are listed in the summary
NITPICKR_WORKER_CONCURRENCY=1
```

Why each matters:

- **`NITPICKR_MODEL_REASONING_EFFORT`** — Ollama enables thinking by default on models
  that support it. `none` gives the fastest reviews; `high` costs 3–10× more
  output tokens. Compare with the eval below before choosing.
- **`NITPICKR_JOB_STALE_AFTER_MS`** — how long a running job must be held by a
  worker that stopped sending heartbeats before it is re-queued. The worker
  beats on a timer during reviews, so this is not a review deadline; a
  stopping worker (deploy) also hands its job back on SIGTERM.
- **`NITPICKR_MODEL_MAX_CONCURRENT_REQUESTS=1`** — nitpickr splits large PRs
  into chunks and reviews them in parallel by default. Against a single-request
  server that only adds queueing; run them sequentially.
- **`NITPICKR_REVIEW_CHUNK_MAX_TOTAL_CHARS`** — bounds prompt size (patch +
  full-file context) per chunk. Lower it for models with small context windows
  or slow prefill (e.g. 120000 ≈ 30k tokens).
- **Embeddings** — the `memories.embedding` column width is set from
  `NITPICKR_EMBEDDING_DIMENSIONS` at migrate time. It defaults to 768, which
  matches the default embedding model; set it together with
  `NITPICKR_EMBEDDING_MODEL` when you switch models. Changing it re-shapes the
  column and clears stored vectors (memory falls back to keyword/recency
  ranking until re-embedded).

## In-process embeddings

The worker embeds memories itself with transformers.js (ONNX Runtime on CPU),
so the model server only ever holds the review model.

- Default model: `nomic-ai/nomic-embed-text-v1.5`, q8-quantized, 768
  dimensions, with nomic's `search_document:` / `search_query:` task prefixes
  applied automatically.
- The Docker image bakes the model in at build time
  (`ARG NITPICKR_EMBEDDING_MODEL`, cached at `/app/models` via
  `NITPICKR_EMBEDDING_CACHE_DIR`), so containers never download it at runtime.
  To use a different model in Docker, rebuild with
  `--build-arg NITPICKR_EMBEDDING_MODEL=<hf-model-id>` and set
  `NITPICKR_EMBEDDING_MODEL` / `NITPICKR_EMBEDDING_DIMENSIONS` to match.
- Cost on the worker: ~146 MB model, ~5 s cold load on the first embed, ~15 ms
  per embedding, ~420 MB RSS.
- `NITPICKR_EMBEDDING_MODEL=off` disables embeddings; memory is then ranked by
  keyword + recency only.

## Ollama-side settings

- `OLLAMA_MAX_LOADED_MODELS=1` is fine: embeddings run in the worker, so
  nothing evicts the review model. (Raise it only if you also set a separate
  `NITPICKR_MEMORY_MODEL`.)
- Set `OLLAMA_KEEP_ALIVE=24h` (or `-1`) so the first review of the day does
  not pay a cold load.
- Keep `OLLAMA_NUM_PARALLEL=1` unless you have VRAM to spare, and mirror it
  with `NITPICKR_MODEL_MAX_CONCURRENT_REQUESTS`.
- Pull only the review model (`ollama pull <tag>`); no embedding model is
  needed on the server.
- Watch memory: model + KV cache at your `NITPICKR_REVIEW_CHUNK_MAX_TOTAL_CHARS`
  must fit; unified-memory Macs hard-crash when they exceed available RAM.

## Docker Compose notes

- The bundled `docker-compose.yml` uses `pgvector/pgvector:pg16` — the memory
  feature needs the `vector` extension.
- The worker service declares `extra_hosts: host.docker.internal:host-gateway`
  so `http://host.docker.internal:11434/v1` resolves on Linux too (Docker
  Desktop resolves it out of the box).

## Model server quirks nitpickr handles

- Ollama's `/v1` responses omit `completion_tokens_details`; nitpickr only
  reads `prompt_tokens`/`completion_tokens`/`total_tokens`, so token logging
  still works.
- Requests ask for strict JSON Schema output. Servers or models that ignore it
  occasionally wrap JSON in code fences or prose; the review client strips
  fences/`<think>` blocks and re-prompts once, and if the reply is still not
  JSON the job fails as *retryable* so the queue tries again (backing off
  30 s, doubling per attempt, capped at 15 min).
- Client timeouts (`NITPICKR_MODEL_REQUEST_TIMEOUT_MS`) also surface as
  retryable failures with a `neutral` check run.
- Node's default `fetch` gives up after ~300 s of waiting for response headers,
  and non-streaming model servers send none until generation is done. nitpickr
  routes model calls through an HTTP agent whose header/body timeouts follow
  `NITPICKR_MODEL_REQUEST_TIMEOUT_MS`, so slow local generations (5–20 min) work.

## Comparing local models: `pnpm eval:reviews --live`

The default `pnpm eval:reviews` replays canned model output and never calls a
model. Live mode runs real diffs through the review engine and scores published
findings against hand-annotated expectations:

```bash
# fixtures live in tests/fixtures/review-evals/live/*.json
NITPICKR_MODEL_BASE_URL=http://localhost:11434/v1 \
  pnpm eval:reviews --live --model qwen3.8:27b-nvfp4 --reasoning-effort none \
  --out reports/qwen36-coding-none.json

# other flags: --base-url, --api-key, --fixtures <dir>, --filter <substring>, --timeout-ms
```

Scoring: a published finding matches an expectation when it is on the same
path within ±2 lines of the expected range (and the expected category, if
given). The report prints recall/precision per case, wall-clock, chunk count
and tokens, and the JSON contains every raw finding and summary so you can read
the actual review text.

Add cases from your own repositories:

```bash
GITHUB_TOKEN=$(gh auth token) pnpm cli eval:capture owner/repo#123
# then fill expectedFindings in tests/fixtures/review-evals/live/<name>.json
```

Run each model/effort combination sequentially (the server handles one
request at a time), and stop the previous model (`ollama stop <model>`) before
switching if two chat models would not fit in memory together.
