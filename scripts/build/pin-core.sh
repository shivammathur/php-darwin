#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib/retry.sh
. "$script_dir/../lib/retry.sh"

# Resolve the same dependency recipes on every architecture and retry.
[[ "${HOMEBREW_CORE_COMMIT:?}" =~ ^[0-9a-f]{40}$ ]] || exit 1
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_FROM_API=1
if [ -n "${PHP_DARWIN_TEST_CORE_CHECKOUT:-}" ]; then
  # Test jobs update Homebrew before attaching their temporary shallow checkout.
  # Never turn that snapshot into a full-history tap or update it again.
  [ "${GITHUB_ACTIONS:-}" = true ]
  core=$(brew --repository homebrew/core)
  [ "$core" = "$PHP_DARWIN_TEST_CORE_CHECKOUT" ]
  [ "$(git -C "$core" rev-parse --is-shallow-repository)" = true ]
  [ "$(git -C "$core" rev-parse HEAD)" = "$HOMEBREW_CORE_COMMIT" ]
  "${PHP_DARWIN_NODE:-node}" "$script_dir/../cache/dependency-recipes.cjs" apply "$core"
  exit 0
fi
php_darwin_retry brew tap --force homebrew/core
core=$(brew --repository homebrew/core)
bash "$(dirname "${BASH_SOURCE[0]}")/ensure-core-history.sh" "$core"
# Hosted baseline images can ship a Homebrew older than the approved recipes'
# DSL (for example resource :test). Update the CI-owned executable and taps
# before restoring the exact dependency snapshot below.
if [ "${GITHUB_ACTIONS:-}" = true ]; then
  bash "$script_dir/update-homebrew.sh"
fi
if ! git -C "$core" cat-file -e "$HOMEBREW_CORE_COMMIT^{commit}" 2>/dev/null; then
  # Keep full taps updateable: Homebrew refuses to update shallow core clones.
  php_darwin_retry git -C "$core" fetch --no-tags origin "$HOMEBREW_CORE_COMMIT"
fi
# Runner images and interrupted jobs can leave modified formulae in the tap.
# CI owns this checkout; local invocations must retain Git's dirty-tree guard.
checkout_flags=(--detach)
if [ "${GITHUB_ACTIONS:-}" = true ]; then checkout_flags+=(--force); fi
git -C "$core" checkout "${checkout_flags[@]}" "$HOMEBREW_CORE_COMMIT"
"${PHP_DARWIN_NODE:-node}" "$(dirname "${BASH_SOURCE[0]}")/../cache/dependency-recipes.cjs" apply "$core"
