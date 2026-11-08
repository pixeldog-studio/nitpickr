#!/usr/bin/env bash
# Writes DESIGN.md's front matter from the captures, then rebuilds the Pen file and the front matter until every
# value binds (build -> tokens -> build). The hand-written prose under the front matter is kept.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
node "$here/tokens-draft.mjs" --write
for _ in 1 2 3; do
  out=$(node "$here/build.mjs")
  node "$here/tokens-draft.mjs" --write
  if ! grep -q UNBOUND <<<"$out"; then
    node "$here/build.mjs"
    exit 0
  fi
done
node "$here/build.mjs"
