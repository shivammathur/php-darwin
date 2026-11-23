#!/usr/bin/env bash
set -euo pipefail

[ "${GITHUB_ACTIONS:-}" = true ] || { echo 'Homebrew test preparation requires an Actions runner' >&2; exit 1; }
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# Archived formulae retain their bottle manifest checksums. Older runner images
# cannot load that DSL in brew missing, even when the cached PHP works already.
# Probe the feature instead of updating compatible runners or changing recipes.
export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_INSTALL_CLEANUP=1
export HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1
supports_manifest_checksum() {
  HOMEBREW_DEVELOPER=1 brew ruby -rformula -e 'exit(BottleSpecification.method_defined?(:manifest_sha256) ? 0 : 1)'
}
if supports_manifest_checksum; then exit 0; fi

printf 'Updating Homebrew for archived bottle manifest checksums\n'
# Use private layout state so the later without-core test still owns its fixture.
# Do not fetch core history, update its pinned recipes, or persist environment
# changes: this prerequisite only updates Homebrew itself, not installed kegs.
layout=$(mktemp -d "${RUNNER_TEMP:?}/php-darwin-test-homebrew.XXXXXX")
restore_core() {
  local status=$?
  trap - EXIT
  RUNNER_TEMP="$layout" GITHUB_ENV='' bash "$script_dir/core-tap-layout.sh" restore || status=$?
  rmdir "$layout" || status=$?
  exit "$status"
}
trap restore_core EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
RUNNER_TEMP="$layout" bash "$script_dir/core-tap-layout.sh" prepare
# Allow API resolution while core is hidden, but refuse formula loading during
# update-report so it cannot migrate or reinstall tools (for example pkgconf).
env -u HOMEBREW_NO_INSTALL_FROM_API HOMEBREW_DISABLE_LOAD_FORMULA=1 bash "$script_dir/../../build/update-homebrew.sh"
if ! supports_manifest_checksum; then
  printf 'Homebrew still cannot load archived bottle manifest checksums after updating\n' >&2
  exit 1
fi
