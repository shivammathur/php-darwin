#!/usr/bin/env bash
set -euo pipefail
[ "${GITHUB_ACTIONS:-}" = true ] || exit 1
# Cold integration tests start with no PHP keg. Repository CI runners include
# self-hosted macOS machines; this cleanup is explicitly part of their test job
# and runs before taking the preservation snapshot.
formulae=()
while IFS= read -r formula; do
  [[ "$formula" =~ ^php(@[0-9.]+)?(-debug)?(-zts)?$ ]] && formulae+=("$formula")
done < <(brew list --formula)
if [ "${#formulae[@]}" -gt 0 ]; then
  brew uninstall --formula --force --ignore-dependencies "${formulae[@]}"
fi
if command -v php >/dev/null 2>&1; then
  printf 'Cold test still has PHP on PATH: %s\n' "$(command -v php)" >&2
  exit 1
fi
