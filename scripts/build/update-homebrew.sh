#!/usr/bin/env bash
set -euo pipefail
[ "${GITHUB_ACTIONS:-}" = true ] || exit 1
log=$(mktemp "${RUNNER_TEMP:-/tmp}/php-darwin-brew-update.XXXXXX")
trap 'rm -f "$log"' EXIT
for attempt in 1 2 3 4 5 6; do
  status=0
  HOMEBREW_UPDATE_TO_TAG=1 brew update --force > "$log" 2>&1 || status=$?
  cat "$log"
  [ "$status" -ne 0 ] || exit 0
  # Never remove the lock inode or interrupt an active update. Preflight can
  # recover a proven orphan; a live owner gets a bounded opportunity to finish.
  # Homebrew prints literal backticks.
  # shellcheck disable=SC2016
  if [ "$attempt" -eq 6 ] || ! grep -Eq 'Another `brew update` process|Could not resolve host|Failed to connect|Connection timed out|remote end hung up' "$log"; then
    exit "$status"
  fi
  printf 'Waiting for Homebrew update retry %s/6\n' "$((attempt + 1))" >&2
  sleep 10
done
