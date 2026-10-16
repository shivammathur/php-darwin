#!/usr/bin/env bash
set -euo pipefail
[ "${GITHUB_ACTIONS:-}" = true ] || { echo 'Private tests require an Actions runner'; exit 1; }
node_runtime=${PHP_DARWIN_NODE:?}
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_FROM_API=1 HOMEBREW_DEVELOPER=1
work="${RUNNER_TEMP:?}/php-darwin-private"
export HOMEBREW_LOGS="$work/homebrew-logs" HOMEBREW_TEMP="$work/homebrew-tmp"
mkdir -p "$HOMEBREW_LOGS" "$HOMEBREW_TEMP"
"$node_runtime" .github/actions/runner-preflight/main.cjs
"$node_runtime" scripts/private/release.cjs test-inputs
# shellcheck disable=SC1091
source "$work/build.env"
export ARCHIVE_DIR="$work/packages"
bash scripts/build/cleanup-taps.sh
bash scripts/build/check-homebrew.sh
for BUILD in release debug; do
  for TS in nts zts; do
    export BUILD TS
    trap 'bash scripts/tests/native/install.test.sh reset' EXIT
    bash scripts/tests/native/install.test.sh all
    bash scripts/tests/native/install.test.sh reset
    trap - EXIT
  done
done
"$node_runtime" scripts/private/release.cjs test-result
