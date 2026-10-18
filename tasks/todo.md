# High-signal reviewer (goal set 2026-10-16)

Design: `docs/superpowers/specs/2026-10-16-high-signal-reviewer-design.md`.
Baseline commit: `e7aecec`. One PR per milestone; never merge; nitpickr reviews each PR.

## Milestone 1 — bugs + end state
- [x] Budget applied after gate + severity floor (engine owns the floor)
- [x] Evidence gate scoped to files the publisher can anchor to
- [x] Job payload carries headSha; supersession cancels only automatic jobs for older commits
- [x] Enqueue dedupe does not swallow a newer commit while an older review runs
- [x] Explicit prior-thread verdicts; resolve only fixed/obsolete
- [x] "No further comments" end state
- [x] Gate findings that repeat a still-open thread (seen live: model re-raised an open thread)
- [x] lint, typecheck, tests; PR opened; nitpickr comments triaged + scorecard (#14, merged fbbd447)
- [x] Independent review found 4 bugs nitpickr missed (outdated threads, full review skipped, cancel race, broad duplicate filter); fixed before merge

## Milestone 2 — eval suite + baseline
- [x] Pipeline-level live eval (gate, floor, budget, multi-round, verdicts)
- [x] 47 cases: 22 synthetic (Swift, TS, SQL, Python planted/clean, injection, multi-round) + 25 captured from ai-automation, user-management, ai-plant-scanner(-web), rouleur-ios, nitpickr
- [x] Metrics: precision (medium+), recall, nit count, clean-case FPs, verdict accuracy, median latency, per stack/kind
- [x] Baseline on `e7aecec` (full suite): precision(medium+) 34%, recall 53%, 59 nits, 35 clean-case findings, median 16.7 s
- Gap: no captured real SQL/RLS bug within the size limit; SQL coverage is synthetic only

## Milestone 3 — verifier + lenses + lint filter + untrusted content
- [x] Adversarial verifier (fresh context, full file, related code, quotes checked, decision-first); uncertain/refuted demoted, not deleted
- [x] Evidence gate, collapse of nearby findings, untrusted-content hardening
- [x] Confirmed-only inline comments, the rest in a "Second look" list (owner chose option C)
- [x] 6k output-token cap: model repetition loops had caused 30-minute hangs
- [x] Model: qwen3.8 27b for review and verification (owner's choice; criteria 2 and 4 accepted at 83% inline precision, 3.2x median)
- [x] Independent review: 7 issues fixed (budget counted second-look items, failed checks went inline, truncation failed the whole review, floor skipped demotions, end state ignored second look, unescaped prose, comment-only refutations)
- [x] Merged as #16 (e890360); separate fix #17 for jobs orphaned by worker restarts (d7b94c7)
## Milestone 4 — conversation
- [x] `@nitpickrai <question>` answered by the model, grounded in the PR; `reconsider` re-runs the verifier; command tips in the first review
- [x] Two independent reviews: 7 + 6 issues fixed (answers were requested in JSON mode, unescaped answers, non-retried posts, untrusted headings, human threads, edits)
- [x] Merged as #18 (19a8621)
- [x] Live check (#22, 2026-10-17 15:29 UTC): "@nitpickrai why does a severe finding in a different file need 0.92…?" got a model answer citing `src/memory/dismissal-policy.ts:14-16` with the correct rationale. Two earlier tries failed visibly: the mention wasn't at a line start (fixed in #22), then Ollama stopped serving the model (watchdog in #25).

## Production fixes found while dogfooding (2026-10-17)
- [x] #17 worker ids unique per start (orphaned job blocked the queue 15 h)
- [x] #19 queued `nitpickr / review` check at enqueue; job payloads stored as jsonb objects (supersede never matched before)
- [x] #20 skip reviews of PRs merged into any branch or closed
- [x] #21 heartbeats during reviews; requeue on shutdown; 2-minute stale recovery
- [ ] Follow-up: ownership-guard completeJob/failJob; escalate repeated heartbeat failures
## Milestone 5 — learning
## Milestone 6 — voice
- [x] Voice sample (20 comments + summary) approved by the owner on 2026-10-17, with one requirement: every comment is clear, reads like a colleague, and states the issue and the recommended fix (now in the review prompt)
- [x] Inline comments: bold problem, one label line, no "Where:" line; first review leads with one headline; multi-chunk summaries are one short paragraph
- [x] Eval reports keep the fix prompt and failure scenario so the final sample shows real output
- [ ] Final full eval on the stack; regenerate the sample from it

## Dogfood scorecard

| PR | comments | valid | nits | wrong | missed | notes |
|---|---|---|---|---|---|---|
| #13 (pre-work) | 15 | ? | most | 1 contradiction pair | ? | baseline sample |
| #14 r1 (old build) | 9 | 0 | 5 | 4 (all ⚠️ medium) | 0 known | wrong ones misread code (one inverted a filter); trimmer cut a body at `'a'.`; 3-paragraph summary from chunk joins |
| #14 r2 (old build) | 1 | 0 | 1 | 0 | — | refactor nit |
| #14 r3 (old build) | 1 | 0 | 1 | 1 (suggestion inapplicable) | 4 (found by independent review) | body cut at `expect(.` again |
| #16 r1 (old build, qwen3.6) | 8 | 0 | 5 | 3 (misread the code: resume skip, regex, a `splice` that does not exist) | 7 (found by independent review) | 15 h queue stall delayed it; summary stacked 4 chunk paragraphs |
| #18 r1 (new build, qwen3.8) | 0 inline + 4 second look | 0 | 0 | 4 second-look items, all unfounded (already sanitized; non-empty tuple) | 6 (found by independent review: JSON-mode answers, unescaped answers, non-retried post, untrusted headings, human threads, edits) | ~20 min for a large PR; summary still stacks chunk paragraphs; no visible check while queued (fixed in #19) |

# Website Metadata + SEO Refresh

## Plan

- [x] Update homepage and imprint metadata for canonical URLs, robots directives, richer OG/Twitter tags, and `WebSite` JSON-LD.
- [x] Add crawl/discovery files for the new canonical host, including `robots.txt`, `sitemap.xml`, and custom-domain support.
- [x] Replace the share thumbnail and ship a simplified favicon/icon family plus expanded web manifest entries.
- [x] Build and verify the static site output, then document the results.

## Results

- Updated the homepage and imprint head metadata to use the canonical `https://nitpickr.rubenspessoa.dev/` host, richer Open Graph and Twitter card fields, explicit robots directives, root favicon links, and homepage `WebSite` JSON-LD.
- Tightened the homepage hero copy so the above-the-fold messaging now explicitly includes `self-hosted`, `AI code review`, and `GitHub pull requests`, while preserving the in-progress responsive navigation work.
- Added and committed root-level crawl and host files:
  - `website/robots.txt`
  - `website/sitemap.xml`
  - `website/CNAME`
- Expanded `website/site.webmanifest` for root-scope install metadata and shipped a new root icon family:
  - `favicon.svg`
  - `favicon.ico`
  - `favicon-96x96.png`
  - `apple-touch-icon.png`
  - `icon-192.png`
  - `icon-512.png`
  - `icon-maskable-512.png`
- Replaced the social preview with a new branded `1200x630` share card at `website/assets/og-preview.jpg` and kept the editable SVG source at `website/assets/og-preview.svg`.
- Verification completed:
  - `pnpm site:build`
  - `pnpm lint`
  - `pnpm typecheck`
  - local metadata validation against `dist/site` for canonical, robots, OG image, JSON-LD, and required output files


# Responsive Website Hardening

## Plan

- [x] Replace the shared website header with a semantic primary nav and mobile hamburger menu on both pages.
- [x] Update the shared stylesheet for phone and tablet breakpoints, including a clean mobile header row and tighter small-phone spacing.
- [x] Extend the shared site script with accessible mobile-nav open and close behavior while preserving reveal animations.
- [x] Rebuild the static site, verify the responsive states, and document the results.

## Results

- Updated `website/index.html` and `website/imprint/index.html` with a shared primary nav, current-page state, and an accessible hamburger toggle for phone widths.
- Updated `website/styles.css` to:
  - keep the mobile header on a single horizontal row
  - collapse the nav into a JS-enhanced dropdown at `720px` and below
  - tighten spacing and sizing again at `480px` and below
  - reduce overflow risk in shared grids and long legal links
- Extended `website/script.js` so the mobile nav:
  - opens and closes via the toggle
  - closes on `Escape`, nav-link click, and resize back above the mobile breakpoint
  - returns focus to the toggle after keyboard dismissal
- Verification completed:
  - `pnpm site:build`
  - `pnpm lint`
  - built-site contract checks against `dist/site`
  - mocked DOM execution of `dist/site/script.js` covering toggle, `Escape`, link-click, and resize-close behavior
- Follow-up nitpickr pass:
  - added `rel="noopener noreferrer"` to the new GitHub nav links
  - moved focus to the first nav link when the mobile menu opens
- Second nitpickr pass:
  - hardened the remaining `target="_blank"` links on the site with `rel="noopener noreferrer"`
  - switched first-link menu focus to `focus({ preventScroll: true })` to avoid mobile scroll jank
- Third nitpickr pass:
  - mirrored `.has-js` activation in the shared script so the CSS mobile-nav hooks are JS-owned as well as HTML-bootstrapped
  - synchronized `aria-hidden` with the mobile nav open/closed state
  - added a `MediaQueryList` change listener alongside resize handling for breakpoint transitions
- Attempted Safari WebDriver viewport verification, but `safaridriver --enable` required a local password prompt that could not be completed unattended from the agent session.

# PR #4 Merge + Review Sweep

## Plan

- [x] Merge the latest `main` into `codex/open-source-docs`.
- [x] Re-triage active PR comments after the merge and separate real issues from stale noise.
- [x] Fix relevant findings, verify, and push the branch.
- [ ] Resolve addressed threads, wait five minutes for new nitpickr comments, and iterate until clear.

## Results

- In progress.

# Open Source Documentation Readiness

## Plan

- [x] Audit all user-facing setup requirements against the codebase and current docs.
- [x] Rewrite `README.md` for open-source onboarding, local setup, usage, and Railway deployment.
- [x] Add `CONTRIBUTING.md` with development workflow, verification expectations, and PR guidance.
- [x] Align supporting docs/examples with the new onboarding docs where needed.
- [x] Run verification for docs consistency and open a pull request for review.

## Results

- Rewrote `README.md` around a local-first setup story with:
  - architecture overview and Mermaid diagram
  - explicit environment variable sourcing guidance
  - GitHub App setup summary and usage commands
  - Railway deployment positioning as the hosted option
  - model-cost guidance centered on `gpt-5-mini`
  - roadmap and source-available licensing notes
- Added `CONTRIBUTING.md` covering:
  - local development workflow
  - verification expectations
  - pull request guidance
  - contributor licensing expectations
- Added `docs/github-app.md` for detailed GitHub App setup.
- Reworked `docs/railway-deploy.md` to match the current deploy shape and env requirements.
- Updated `.env.example` to be a commented, public-ready template.
- Added a repository `LICENSE`, `TRADEMARKS.md`, and package license metadata.
- Aligned default OpenAI model examples and runtime defaults to `gpt-5-mini`.
- Added the mascot asset to the README header for the public docs presentation.
- Switched licensing from PolyForm Noncommercial to Elastic License 2.0 so
  internal commercial use is allowed while hosted/managed-service competition
  remains restricted.
- Verification completed:
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test` (`51` files, `269` tests)
  - `pnpm eval:reviews`
- Opened PR for review:
  - `https://github.com/rubenspessoa/nitpickr/pull/4`
  - posted `@nitpickr review`
# Prompt Token Optimization v1

## Plan

- [x] Add prompt payload optimizer stage with deterministic compaction budgets.
- [x] Wire optimization mode and review scope through config -> runtime -> worker -> review engine.
- [x] Extend review diagnostics with prompt usage before/after compaction and worker logs.
- [x] Add and update unit/integration tests for optimizer, config parsing, worker input wiring, and diagnostics.
- [x] Run lint, typecheck, and tests; document results.

## Results

- Added `PromptPayloadOptimizer` with:
  - scope budgets for `commit_delta` and `full_pr`
  - deterministic primary patch truncation with omission markers
  - context metadata-only compaction and deterministic ordering
  - instruction and per-chunk memory compaction
  - prompt usage estimation utilities
- `ReviewEngine` now:
  - accepts `scope` and `optimizationMode`
  - defaults chunk size to `16000`
  - compacts payloads before prompt build
  - returns diagnostics with prompt usage before/after compaction
- Bootstrap config now supports:
  - `NITPICKR_PROMPT_OPTIMIZATION_MODE=off|balanced` (default `balanced`)
- Worker pipeline now:
  - passes `scope` and `optimizationMode` explicitly to review engine input
  - logs prompt usage metrics before and after compaction
- Added and updated tests:
  - `tests/review/prompt-payload-optimizer.test.ts`
  - `tests/review/review-engine.test.ts`
  - `tests/config/app-config.test.ts`
  - `tests/worker/worker-runner.test.ts`
- Verification:
  - `pnpm typecheck` passed
  - `pnpm lint` passed
  - `pnpm test` passed (`51` files, `247` tests)
  - `pnpm eval:reviews` passed (`Fixtures: 1`, `Precision: 1.00`)

# PR Open Full Review + Worker Setup Logging

## Plan

- [x] Change automatic `pull_request` mode mapping so:
  - `opened` -> `full`
  - `ready_for_review` -> `full`
  - `synchronize` -> `quick`
- [x] Update webhook normalization tests to validate the new mode behavior.
- [x] Reduce setup-required worker log noise while improving diagnostic clarity.
- [x] Verify with typecheck, lint, and test suite.

## Results

- Updated PR event mode mapping in `src/providers/github/github-adapter.ts`.
- Updated mode assertions in:
  - `tests/providers/github-adapter.test.ts`
  - `tests/api/github-webhook-service.test.ts`
- Worker setup-required behavior in `src/worker/index.ts` now:
  - logs detailed setup state on change
  - uses debug for unchanged idle cycles
  - logs a resume message once setup completes
- Verification completed:
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm test` (50 files, 241 tests)

## Follow-up: OpenAI Temperature Compatibility

### Plan

- [x] Reproduce the failure path from logs and identify the source of `temperature: 0.1`.
- [x] Add model-request fallback that retries once without `temperature` for unsupported-temperature 400 responses.
- [x] Add regression tests for fallback behavior and request payloads.
- [x] Verify with typecheck, lint, and tests.

### Results

- Updated `src/review/openai-review-model.ts`:
  - first request keeps `temperature: 0.1`
  - if OpenAI returns a 400 unsupported-temperature error, retries once without `temperature`
  - preserves existing error behavior for other failures
- Updated `tests/review/openai-review-model.test.ts`:
  - validates temperature is sent on the first request
  - validates fallback retry omits temperature and succeeds

# PR #3 Review Thread Sweep

## Plan

- [x] Triage all open PR review threads and separate code fixes from reply-only clarifications.
- [x] Implement config, optimizer, and test hardening updates from accepted findings.
- [x] Re-run lint, typecheck, and test suite before resolving threads.
- [x] Resolve addressed GitHub review threads and reply to remaining open questions.

## Results

- Updated `src/config/app-config.ts`:
  - introduced `PromptOptimizationMode` type derived from Zod schema
  - reused the derived type in bootstrap/app config interfaces
  - documented why `balanced` remains the default mode
- Updated `src/review/prompt-payload-optimizer.ts`:
  - stabilized minimum omission marker sizing so truncation logic does not grow with full input length
  - unified text truncation marker formatting through `buildOmissionMarker`
  - clarified truncation marker initialization heuristic in patch truncation
  - normalized path separators for chunk-memory relevance matching
- Updated tests:
  - `tests/config/app-config.test.ts` now explicitly covers default `balanced` and explicit `balanced` value
  - `tests/review/prompt-payload-optimizer.test.ts` now avoids brittle path indexing, verifies context compaction structure, adds Windows-path memory relevance coverage, and relaxes over-tight numeric expectations
  - `tests/worker/worker-runner.test.ts` now uses shape-safe scope/mode assertions and non-identical before/after prompt usage fixtures
- Follow-up after next nitpickr pass:
  - stabilized omission-marker reference with a named constant
  - restored newline-prefixed omission marker in `truncateTextHead`
  - replaced `replaceAll` path normalization with regex-based replacement for broader runtime compatibility
- Verification completed:
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test` (`51` files, `252` tests)

# Publish 422 Resilience (Path/Line Resolution)

## Plan

- [x] Confirm the failing class from logs and identify the publish-path failure point.
- [x] Add publisher fallback behavior for GitHub 422 inline-comment resolution failures.
- [x] Add regression tests for fallback behavior and non-fallback error handling.
- [x] Run lint, typecheck, and tests; document verification.

## Results

- Updated `src/publisher/review-publisher.ts`:
  - added targeted detection for GitHub 422 errors that indicate unresolved review comment `path`/`line`
  - added one retry path that republishes the same review body without inline comments when that specific error happens
  - kept existing behavior for all non-target errors (they still fail fast)
- Updated `tests/publisher/review-publisher.test.ts`:
  - added regression test covering fallback to summary-only publish after a 422 path/line resolution rejection
  - added regression test ensuring unrelated 422 validation errors are not swallowed
- Verification completed:
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test tests/publisher/review-publisher.test.ts`
  - `pnpm test` (`51` files, `254` tests)

# PR #3 Follow-up Thread Sweep

## Plan

- [x] Re-triage new unresolved nitpickr threads after the latest push.
- [x] Fix omission-marker and truncation edge-case correctness issues.
- [x] Harden 422 fallback error-shape parsing and add non-Error payload test coverage.
- [x] Re-run lint, typecheck, and full test suite.
- [x] Resolve all addressed PR threads.

## Results

- Updated `src/review/prompt-payload-optimizer.ts`:
  - minimum omission budget now includes the newline-prefixed marker shape
  - `truncateTextHead` now preserves trailing content when marker alone would exceed the target budget
  - path comparison now uses Node path utilities for normalization before matching memory scope
- Updated `src/publisher/review-publisher.ts`:
  - replaced brittle single-string checks with structured error inspection
  - supports `Error`, string, and plain-object payloads
  - parses JSON payload fragments from error messages even when trailing text follows the JSON object
  - requires purely numeric status strings before interpreting them as HTTP status codes
  - switched to a linear brace-aware JSON object scanner to avoid bounded reverse-scan misses and unbounded parse loops
  - added defensive `safeTryParseObject` calls in the scan loop so unexpected parser exceptions do not abort fallback detection
  - tightened direct/candidate return checks to explicit `!== null` semantics
  - removed redundant scanner undefined-character guard for clarity
  - restored sanitized/truncated parse diagnostics (`errorMessage`, capped to 200 chars) without logging raw payload content
  - extracted sanitizer to module scope as `sanitizeDiagnosticErrorMessage` for reuse and focused testing
- Updated `tests/publisher/review-publisher.test.ts`:
  - added regression test for non-Error `{ status: "422", errors: [...] }` throw shape to ensure fallback still triggers
  - added regression test covering non-JSON brace content before a valid JSON payload in the same error string
  - added regression test for braces inside JSON string values so string-content braces are not treated as structural boundaries
  - added focused sanitizer tests for `Error`, object input, non-ASCII filtering, truncation, and fallback behavior
- Verification completed:
  - `pnpm test tests/review/prompt-payload-optimizer.test.ts tests/publisher/review-publisher.test.ts`
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm test` (`51` files, `255` tests)

# PR #3 Follow-up Thread Sweep (Round 2)

## Plan

- [x] Re-triage newly opened sanitizer-focused PR threads.
- [x] Harden diagnostic serialization for bounded object payloads and `BigInt` values.

# Marketing Website for GitHub Pages

## Plan

- [x] Add a standalone static marketing site source under `website/` with branded assets and source-accurate product copy.
- [x] Add a small build pipeline and package script that emits a GitHub Pages-safe artifact using relative asset paths.
- [x] Add a dedicated GitHub Pages Actions workflow for deployment from `main`.
- [x] Verify the site build and key links, then document results.

## Follow-up Asset Pass

- [x] Turn the new mascot renders in `assets/` into web-sized landing page assets.
- [x] Replace the placeholder mascot scenes with the stronger review, VPS, and motion illustrations.
- [x] Rebuild the Pages artifact, re-open the browser preview, and document the verification results.

## Simplification Pass

- [x] Reduce the landing page to a calmer, roomier structure with fewer competing sections.
- [x] Rewrite the copy to feel friendlier and easier to scan while preserving the key product truths.
- [x] Rebuild, re-open the browser preview, and verify the simplified page.

# PR #5 Comment Sweep

## Results

- Re-triaged all nitpickr review threads on PR #5 and kept only the feedback that still matched the simplified marketing site.
- Restored a working GitHub Actions setup by keeping `pnpm/action-setup` ahead of cache-enabled `actions/setup-node`, and added `pnpm site:build` to CI.
- Switched the shared header mark to the smaller SVG chip, simplified the imprint header/footer, fixed the EU ODR link to `https`, and replaced the example model name with a neutral placeholder.
- Removed stale mobile-nav JavaScript, tightened the hero height so the page stops feeling like a full-screen splash, pushed commit [`49b935a`](https://github.com/rubenspessoa/nitpickr/commit/49b935a074b27499370d006e41cc36500bfef32b), and resolved all open nitpickr review threads.

## Follow-up Sweep

- [x] Confirm the branch is clean before looking for new feedback.
- [ ] Wait two minutes, then requery PR comments and failing checks.
- [ ] Fix the actionable issues, rerun verification, and push.
- [ ] Requery once more, resolve stale nitpickr comments, and stop when the remaining feedback is no longer worth implementing.

## Imprint And Footer Pass

- [x] Add a dedicated imprint page in the shared site style using the existing legal identity details.
- [x] Simplify the footer so the essential legal and navigation links are easy to scan.
- [x] Rebuild the Pages artifact and verify both the home page and `/imprint/` locally.

## Safari Hero Hardening

- [x] Remove the browser-sensitive hero balance that still breaks on Safari desktop.
- [x] Replace the hero with a simpler, more deterministic layout and heading flow.
- [x] Rebuild, verify, and push the Safari-safe hero update.

## Supporting Sections Restore

- [x] Restore the supporting sections under the simplified hero without changing the hero itself.
- [x] Rebuild and verify that the homepage keeps the one-CTA hero while restoring the product narrative below it.

## Public Pages Launch

- [x] Confirm the repository is clean before changing its GitHub visibility and Pages settings.
- [x] Make `rubenspessoa/nitpickr` public.
- [x] Enable GitHub Pages on the repo using the existing Actions workflow.
- [x] Trigger a deployment and verify the published Pages URL.
- [x] Point the Pages site at `nitpickr.rubenspessoa.dev` in GitHub Pages settings.
- [ ] Add the DNS record for `nitpickr.rubenspessoa.dev` and verify HTTPS once the subdomain resolves.

## Results

- Added a standalone marketing site under `website/` with:
  - branded hero, product walkthrough, self-host comparison, deployment, model-control, FAQ, and CTA/footer sections
  - source-available licensing language aligned with `README.md`, `LICENSE`, and `TRADEMARKS.md`
  - GitHub-first CTAs plus links to the GitHub App and Railway guides
- Added branded web assets:
  - self-hosted `Space Grotesk`, `IBM Plex Sans`, and `IBM Plex Mono` font files
  - mascot-based SVG scene assets for hero, brand chip, badge, and watermark usage
  - PNG derivatives retained for favicon, Apple touch icon, and Open Graph image usage
  - SVG watermark background treatment
- Follow-up asset refresh:
  - replaced the flatter mascot derivatives with SVG scene compositions for the hero, brand chip, badge, and OG card
  - updated the site to use the SVG hero/chip/badge assets directly while regenerating PNG derivatives for social and icon use
- Follow-up asset integration from the new transparent mascot renders:
  - added web-sized mascot art derivatives for hero, VPS/self-host, FAQ, brand mark, and footer usage
  - switched the landing page to use the transparent PNG scenes where they can sit on gradients and cards cleanly
  - kept the reviewing scene as a framed hero image and refreshed the social preview image from the same artwork
  - regenerated the favicon and Apple touch icon from the flying mascot render
- Simplification pass after design feedback:
  - recentered the page around a single value phrase: `AI code review, on your infrastructure.`
  - removed the denser proof-strip and walkthrough sections in favor of a calmer hero, a simple value section, a self-hosting section, and a tighter control/FAQ flow
  - shortened the copy so each section answers one follow-up question instead of trying to explain everything at once
  - reduced mascot usage to the brand mark, the main review hero, and one VPS illustration
- Light/minimal refresh and legal page pass:
  - moved the site to a lighter, warmer visual system with a simpler header and a quieter footer
  - added `website/imprint/index.html` as a dedicated imprint page using the same shell and shared styles
  - simplified the footer down to the core legal and navigation links, including the new imprint page
  - increased spacing rhythm across the hero, sections, cards, footer, and imprint page for a less condensed layout
- Safari-safe hero simplification:
  - removed the browser-sensitive side-by-side hero balance in favor of a more deterministic stacked hero
  - reduced the homepage to one value phrase and one primary GitHub CTA
  - removed the secondary setup CTA and the hero tags to keep the first screen singular and calmer
- Supporting sections restore after product-direction clarification:
  - kept the minimal one-phrase hero and single GitHub CTA
  - restored the explanatory sections underneath for product value, self-hosting, control, and FAQ context
- Added repository wiring:
  - `scripts/build-site.mjs`
  - `pnpm site:build`
  - `.github/workflows/pages.yml`
  - Biome ignore for generated `dist/`
- Verification completed:
  - `pnpm site:build`
  - `pnpm lint`
  - `pnpm typecheck`
  - `rg -n '(src|href)=\"/' dist/site website` (no root-relative asset paths found)
- Browser preview:
  - served `dist/site` locally on `http://127.0.0.1:4173/`
  - reopened the rendered Pages artifact in the browser after both the asset integration pass and the simplification pass
  - verified the rebuilt Pages artifact contains both `dist/site/index.html` and `dist/site/imprint/index.html`
- [x] Add/extend sanitizer-focused regression tests.
- [x] Re-run lint, typecheck, and targeted publisher tests.
- [x] Resolve addressed PR threads.

## Results

- Updated `src/publisher/review-publisher.ts`:
  - introduced named constants for diagnostic serialization/truncation budgets
  - hardened object serialization with bounded traversal and serialized-length capping
  - added explicit `BigInt` support in the JSON replacer to avoid stringify throws
  - simplified replacer flow with early primitive returns and consolidated object handling
  - kept parse-error deduplication sentinel function-scoped during scanner execution
- Updated `tests/publisher/review-publisher.test.ts`:
  - added circular-object sanitizer coverage
  - added `BigInt` serialization regression coverage
- Follow-up after next nitpickr pass:
  - ensured sanitizer preserves truncation sentinels when trimming to 200 chars
  - added regression tests for serialized-length truncation marker preservation
  - added regression tests for object-budget truncation marker preservation
  - exported sanitizer truncation constants for canonical reuse across tests/callers
  - switched truncation assertions to import constants instead of hard-coded literals
  - extracted diagnostic constants into `src/publisher/diagnostic-constants.ts`
  - updated publisher and tests to import constants from the dedicated diagnostics module
  - moved `DIAGNOSTIC_MAX_SERIALIZED_LENGTH`, `DIAGNOSTIC_MAX_STRING_LENGTH`, and `DIAGNOSTIC_OBJECT_BUDGET` into the same diagnostics constants module
  - added a diagnostics constants header comment documenting units/relationships
  - unified truncation casing to lowercase marker format (`[truncated]`)
  - added deprecated uppercase marker alias for backward compatibility (`DIAGNOSTIC_OBJECT_TRUNCATION_MARKER_DEPRECATED`)
  - documented casing-change impact as a breaking change that needs release-note visibility
  - added marker-variant detection export to cover canonical + deprecated object truncation literals
  - added `CHANGELOG.md` with an Unreleased note about marker casing and the deprecated alias
  - clarified changelog wording to foreground backward compatibility
  - exported a marker `Set` companion for compatibility-friendly membership checks
  - kept sanitizer marker iteration on the ordered variants array for readability and deterministic ordering
  - added sanitizer regression coverage for canonical + deprecated truncation marker variants
  - documented sanitizer contract: preserve detected deprecated marker literals in output instead of normalizing to canonical during truncation
  - cleaned up lessons wording typo flagged during PR review
- Verification completed:
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test tests/publisher/review-publisher.test.ts`

---

# Local models via Ollama — implementation todo

Plan: ~/.claude/plans/plan-plan-mode-how-fuzzy-brooks.md

## Part 2 — code
- [x] app-config: new OPENAI_*/NITPICKR_* env vars (reasoning effort, memory model, embedding model/dims, timeout, concurrency, chunk total chars)
- [x] openai-review-model: reasoning_effort, timeout, fence/think stripping, retry-once
- [x] memory classifier/embedder: timeout, dimension validation
- [x] build-runtime: wire config; embedder optional
- [x] worker-runner: model-output errors retryable
- [x] review-engine: total-chars chunk budget + bounded concurrency
- [x] migrations: configurable embedding dimension + alter migration
- [x] docker-compose: pgvector image, extra_hosts, restart policy
- [~] doctor: skipped live model check; relaxed PEM check to accept RSA keys
- [x] .env.example + docs
- [x] tests green: pnpm test, pnpm build

## Part 3–5 — ops / verify / eval
- [x] Ollama env + nomic-embed-text
- [ ] Tailscale Funnel
- [ ] GitHub App on throwaway repo
- [ ] compose up, verification PR, timings
- [x] eval live mode + fixtures + run matrix

## Results (2026-08-16)

- Code: 381 tests, lint, typecheck, build green; Docker image builds; `docker compose up` brings db (pgvector), migrate (`memories.embedding` = `vector(768)`), api, worker up; worker container reaches host Ollama via `host.docker.internal:11434`.
- Live eval (5 planted-bug fixtures, `pnpm eval:reviews --live`, sequential, Ollama on the mini):

| model | effort | recall | precision | unexpected | total s | per-case s |
|---|---|---|---|---|---|---|
| qwen3.6:35b-a3b-nvfp4 | none | 100% | 42% | 7 | 56 | 8–15 |
| qwen3.6:35b-a3b-nvfp4 | high | 100% | 50% | 5 | 448 | 45–130 |
| qwen3.8:27b-mlx | none | 80% | 50% | 4 | 162 | 24–40 |
| qwen3.8:27b-mlx | high | 100% | 33% | 10 | 1458 | 201–413 |

  Decision: default `qwen3.6:35b-a3b-nvfp4` + `OPENAI_REASONING_EFFORT=none` (best recall per second; extra "unexpected" findings are mostly reasonable nits, not hallucinations). Revisit with real captured PRs.
- Found & fixed during eval: Node fetch's 300 s undici `headersTimeout` killed slow non-streaming generations ("fetch failed" at 301 s) → model calls now go through an undici Agent sized by `OPENAI_REQUEST_TIMEOUT_MS`.
- Pending (needs human): enable Tailscale Funnel, create the GitHub App, fill GitHub values in `.env`, restart compose, open the verification PR on `rubenspessoa/nitpickr-ollama-test`.
- Verification PR (rubenspessoa/nitpickr-ollama-test#1, 2026-08-16): webhook via Tailscale Funnel → queue → worker → Ollama → GitHub, all green.
  - Round 1 (`opened`, qwen3.6/none): job 29 s (model 20 s, 3076+727 tok, 1 chunk); 3 correct inline findings; summary + mermaid; check run `nitpickr / review` success; embeddings 768-d OK.
  - Round 2 (`synchronize`, commit-delta): 19 s; 2 findings — one false positive (called the correct pagination fix a regression) and one "logic corrected" note posted as a finding; outdated round-1 threads were not auto-resolved (investigate stale-thread resolution path).
  - Round 3 (`@nitpickrai review`, qwen3.8/none, cold): 145 s; first reply had trailing text after the JSON → automatic re-prompt succeeded (attempts=2); 3 findings.
  - `.env` restored to qwen3.6 default; GitHub App `nitpickrai` is installed on all repos (allowlist limits reviews to the test repo) with Contents:write — consider narrowing.
