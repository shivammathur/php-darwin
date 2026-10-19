#!/usr/bin/env bash
set -euo pipefail
umask 022
[ "${GITHUB_ACTIONS:-}" = true ] || { echo 'Private builds require an Actions runner'; exit 1; }
node_runtime=${PHP_DARWIN_NODE:?}
work="${RUNNER_TEMP:?}/php-darwin-private"
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_FROM_API=1 HOMEBREW_DEVELOPER=1
export PHP_DARWIN_SOURCE_CACHE_READ_ONLY=true
export INPUT_RELEASE=cache
export HOMEBREW_LOGS="$work/homebrew-logs" HOMEBREW_TEMP="$work/homebrew-tmp"
mkdir -p "$HOMEBREW_LOGS" "$HOMEBREW_TEMP"
# Node and AWS live outside Homebrew before its cleanup.
"$node_runtime" .github/actions/runner-preflight/main.cjs
if [ "${RUNNER_ENVIRONMENT:-}" != self-hosted ]; then brew test-bot --only-cleanup-before; fi
"$node_runtime" scripts/private/release.cjs prepare
# shellcheck disable=SC1091
source "$work/build.env"
trap 'bash scripts/build/build.sh reset' EXIT
bash scripts/build/pin-core.sh
INPUT_STAGE=tools env INPUT_FORCE-SOURCE=true "$node_runtime" .github/actions/source-cache/main.cjs
bash scripts/build/cleanup-taps.sh
"$node_runtime" scripts/private/release.cjs activate-tap
bash scripts/build/build.sh prepare
bash scripts/build/build.sh cleanup
bash scripts/build/check-homebrew.sh
"$node_runtime" scripts/private/release.cjs seed
env INPUT_FORCE-SOURCE=true "$node_runtime" .github/actions/source-cache/main.cjs
INPUT_STAGE=extensions env INPUT_FORCE-SOURCE=true "$node_runtime" .github/actions/source-cache/main.cjs
bash scripts/build/build.sh package
bash scripts/build/build.sh verify
"$node_runtime" scripts/private/release.cjs save-build
