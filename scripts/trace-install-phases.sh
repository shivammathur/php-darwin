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
