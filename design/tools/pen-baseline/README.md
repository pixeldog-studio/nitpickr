# Pen baseline (web)

Rebuilds this site's as-built Pen file from a local build, with every visual value bound to a `design/DESIGN.md`
token. Nothing here runs in CI; the app's own verify ignores it apart from lint/format.

1. Build and serve the site from this checkout (see `manifest.txt` for how), then capture every route in
   `manifest.txt` at the viewports and schemes in `config.json`:
   `PLAYWRIGHT_MODULE=<path>/node_modules/playwright/index.mjs node design/tools/pen-baseline/capture.mjs`
   Playwright is not a repo dependency: install it anywhere (`npm i --prefix /tmp/pw playwright@1.58.2`).
   Captures and extracts land in gitignored `design/.refs/`; image assets in `design/images/`.
2. `design/tools/pen-baseline/sync.sh` writes the DESIGN.md front matter (tokens named after the CSS custom
   properties; values without one are flagged) and the `.pen` file, looping until every value binds. The prose
   below the front matter is hand-written and kept.
3. `node design/tools/pen-baseline/verify.mjs --pen design/<file>.pen --id <ticket> --scale 1` exports every frame
   through headless `pen interactive`, diffs each against its capture (`hq design diff`) and prints the binding
   report. `node design/tools/pen-baseline/align-web.mjs <python with numpy+pillow>` gives per-element offsets;
   then `python3 design/tools/pen-baseline/shrink_exports.py design/exports/<ticket>` makes the committed previews
   256-colour PNGs.

| File                                      | Role                                                                                                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `extract.js`                              | runs in the page: boxes, computed styles, text lines, SVG paths, resolved `:root` custom properties                                                                                                          |
| `capture.mjs`                             | drives Chromium per route × viewport × scheme; screenshots, extracts, assets                                                                                                                                 |
| `usage.mjs`                               | names each rendered value after the code's custom property when one matches                                                                                                                                  |
| `tokens-draft.mjs`                        | DESIGN.md front matter from the captures (`--write` keeps the prose)                                                                                                                                         |
| `tokens.mjs`                              | DESIGN.md → Pen variables (colours through `hq design pen-tokens`)                                                                                                                                           |
| `build.mjs`                               | extracts + variables → `.pen`: auto-layout where CSS flex/flow matches Pen's rules exactly, measured positions elsewhere; light page frames are components and dark frames are instances with the dark theme |
| `verify.mjs`, `align-web.mjs`, `align.py` | export, diff, binding report, per-element alignment                                                                                                                                                          |

Known Pen limits (pen 0.3.14): `$variables` on width/height are ignored and on opacity render wrong, so those are
literal numbers; text underline isn't exported; pseudo-elements (`::before`/`::after`) are not reproduced.
