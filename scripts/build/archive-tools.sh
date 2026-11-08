#!/usr/bin/env bash
set -euo pipefail

# Preparing a test must not upgrade or clean up existing PHP dependencies.
export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_INSTALL_CLEANUP=1
export HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1

# Compatibility tests need working archive utilities, not newer tool versions.
# Keep runner-provided tools; never start a source build to prepare a test.
missing=()
for tool in jq zstd; do
  if ! command -v "$tool" >/dev/null 2>&1; then missing+=("$tool"); fi
done
if [ "${#missing[@]}" -eq 0 ]; then exit 0; fi
# Build/test jobs may disable API installs before a fresh runner has core.
# Only this tool-bootstrap subprocess needs the API; keep pinned recipes when
# a core checkout exists, and leave the caller's environment unchanged.
repository=$(brew --repository)
if [ ! -d "$repository/Library/Taps/homebrew/homebrew-core" ]; then
  unset HOMEBREW_NO_INSTALL_FROM_API
fi
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
"${PHP_DARWIN_NODE:-node}" "$script_dir/archive-tools.cjs" "${missing[@]}"
