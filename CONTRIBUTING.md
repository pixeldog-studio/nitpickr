# Contributing

Thanks for contributing to `nitpickr`.

This repository is small enough to move quickly, but it still expects production
discipline: accurate docs, reproducible setup, tests for behavior changes, and a
clear explanation of why a change exists.

## Before you start

- Read [README.md](README.md) for the product overview and setup paths.
- Read [docs/github-app.md](docs/github-app.md) if your change needs a real
  GitHub App.
- Read [docs/railway-deploy.md](docs/railway-deploy.md) if your change affects
  hosted deployment.
- Read [AGENTS.md](AGENTS.md). It captures repository-specific workflow
  expectations and is part of the review surface for this project.

## Local setup

1. Install the toolchain.

   ```bash
   corepack enable
   pnpm install
   ```

2. Create your local config.

   ```bash
   cp .env.example .env
   ```

3. Fill in the required values:
   - a local model server (e.g. Ollama) and `NITPICKR_REVIEW_MODEL` (see
     [docs/local-models-ollama.md](docs/local-models-ollama.md))
   - GitHub App ID
   - GitHub App private key
   - GitHub webhook secret
   - public HTTPS base URL and webhook URL

4. Validate the environment.

   ```bash
   set -a
   source .env
   set +a
   pnpm cli doctor
   ```

   Windows note: if you are using PowerShell, prefer the Docker Compose flow or
   load the variables with a PowerShell-specific env import before running the
   CLI commands.

5. Start the stack.

   ```bash
   docker compose up --build
   ```

Use Docker Compose when you want the closest thing to a real deployment. It
starts Postgres, runs migrations, and launches both services.

## Fast development workflow

For faster iteration, export `.env` into your shell and run the processes
directly.

Terminal 1:

```bash
set -a
source .env
set +a
pnpm migrate
pnpm dev:api
```

Terminal 2:

```bash
set -a
source .env
set +a
pnpm dev:worker
```

Useful health endpoints while developing:

- `GET /healthz`
- `GET /readyz`
- `GET /setup`
- `GET /setup/status`

## What to test

Run the full quality bar before opening a PR. `pnpm check` runs exactly what CI
runs (lint, typecheck, tests, site build):

```bash
pnpm check
```

Also run this when you change prompt construction, review behavior, or scoring:

```bash
pnpm eval:reviews
```

If your change affects docs, setup, or deployment, verify the instructions you
wrote against the actual commands and config in the repository.

## Change expectations

- Keep changes scoped. Separate documentation work from unrelated refactors.
- Add or update tests for behavior changes.
- Update docs when the setup story, env surface, or operational behavior
  changes.
- Prefer small, reviewable pull requests over broad sweeps.
- Do not commit secrets, `.env`, generated keys, or real webhook URLs.

## Pull requests

Each PR should explain:

- what changed
- why it changed
- how it was verified
- any follow-up work or known limitations

If the change affects runtime behavior, include the exact commands you ran for
verification.

## Repository instructions

`nitpickr` can read instructions from repositories it reviews. When you change
that behavior, test against the instruction sources the product already supports:

- `.nitpickr.yml`
- `.nitpickr/`
- `AGENTS.md`

If you change review commands, permissions, or environment variables, update the
README and supporting docs in the same PR.

## Contribution license

By submitting a contribution, you confirm that:

- you have the right to submit the work
- you are allowing it to be distributed under this repository's license
- you are granting the maintainer the right to use, sublicense, and relicense
  your contribution as part of `nitpickr`, including separately licensed
  commercial offerings

That contributor grant is broader than the repository's public
Elastic License 2.0 terms and exists so the maintainer can operate hosted,
commercially licensed, or separately branded versions of `nitpickr`.

If that is not acceptable, do not submit a code contribution.
