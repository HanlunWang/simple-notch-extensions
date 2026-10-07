#!/bin/zsh
# Generates the Raycast extension catalog locally (the GitHub Actions workflow does the same every day):
# a partial clone of raycast/extensions that only fetches each extension's package.json, then build.js.
#   Scripts/raycast-catalog.sh [out.json]   (default: <scratch>/raycast-catalog.json)
set -euo pipefail
ROOT=${0:A:h:h}
OUT=${1:-${TMPDIR:-/tmp}/raycast-catalog.json}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/raycast-catalog.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
git clone --quiet --filter=blob:none --no-checkout --depth 1 https://github.com/raycast/extensions "$WORK/extensions"
cd "$WORK/extensions"
git sparse-checkout init --no-cone
git sparse-checkout set 'extensions/*/package.json'
git checkout --quiet
node "$ROOT/Scripts/raycast-catalog/build.js" --repo "$WORK/extensions" --out "$OUT"
echo "$OUT"
