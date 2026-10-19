#!/usr/bin/env bash
set -euo pipefail

# Homebrew cleanup can remove libraries used by its curl. Keep downloads and
# their child processes on the OS client throughout the private job.
if [ "$(uname -s)" = Darwin ]; then
  test -x /usr/bin/curl
  network_bin=$(mktemp -d "${RUNNER_TEMP:?}/php-darwin-network.XXXXXX")
  ln -s /usr/bin/curl "$network_bin/curl"
  printf '%s\n' "$network_bin" >> "${GITHUB_PATH:?}"
  printf '%s\n' 'HOMEBREW_CURL=/usr/bin/curl' 'HOMEBREW_CURL_PATH=/usr/bin/curl' \
    'HOMEBREW_FORCE_BREWED_CURL=' >> "${GITHUB_ENV:?}"
fi
