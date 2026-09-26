#!/usr/bin/env bash
set -euo pipefail

# Resolve the same dependency recipes on every architecture and retry.
[[ "${HOMEBREW_CORE_COMMIT:?}" =~ ^[0-9a-f]{40}$ ]] || exit 1
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_FROM_API=1
brew tap --force homebrew/core
core=$(brew --repository homebrew/core)
if ! git -C "$core" cat-file -e "$HOMEBREW_CORE_COMMIT^{commit}" 2>/dev/null; then
  git -C "$core" fetch --no-tags --depth=1 origin "$HOMEBREW_CORE_COMMIT"
fi
git -C "$core" checkout --detach "$HOMEBREW_CORE_COMMIT"
