#!/usr/bin/env bash
set -euo pipefail

# Compatibility tests need working archive utilities, not newer tool versions.
# Keep runner-provided tools; never start a source build to prepare a test.
missing=()
for tool in jq zstd; do
  if ! command -v "$tool" >/dev/null 2>&1; then missing+=("$tool"); fi
done
if [ "${#missing[@]}" -eq 0 ]; then exit 0; fi
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
"${PHP_DARWIN_NODE:-node}" "$script_dir/../cache/upstream-bottle-cache.cjs" tools "${missing[@]}"
brew install --formula --verbose --force-bottle "${missing[@]}"
