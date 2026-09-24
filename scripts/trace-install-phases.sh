#!/usr/bin/env bash
# BASH_ENV for CI diagnostics only; never bundled into the release installer.
php_darwin_trace_phase() {
  if [ -n "${PHP_DARWIN_PHASE:-}" ] &&
    [ "$PHP_DARWIN_PHASE" != "${php_darwin_previous_phase:-}" ]; then
    printf 'php-darwin: phase %s at %ss\n' "$PHP_DARWIN_PHASE" "$SECONDS" >&2
    php_darwin_previous_phase=$PHP_DARWIN_PHASE
  fi
}
trap php_darwin_trace_phase DEBUG

# setup-php invokes the downloaded php-darwin installer through run_script.
# Time the entire child, including its cleanup, without changing release code.
bash() {
  local started elapsed status
  if [ "${repo:-}" != php-darwin ] || [ "${1:-}" != /tmp/install.sh ]; then
    command bash "$@"
    return $?
  fi
  started=$SECONDS
  if command bash "$@"; then status=0; else status=$?; fi
  elapsed=$((SECONDS - started))
  printf 'setup-php cache installer completed in %ss (status %s)\n' "$elapsed" "$status"
  printf '%s\n' "$elapsed" > "${RUNNER_TEMP:?}/php-darwin-setup-install-seconds.txt"
  return "$status"
}
