#!/usr/bin/env bash
# Rebuilds the Pen file and DESIGN.md front matter until every value binds (build -> tokens -> build).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
for i in 1 2 3; do
  out=$(node "$here/build.mjs")
  node "$here/tokens-draft.mjs" --write
  if ! grep -q UNBOUND <<<"$out"; then node "$here/build.mjs"; exit 0; fi
done
node "$here/build.mjs"
