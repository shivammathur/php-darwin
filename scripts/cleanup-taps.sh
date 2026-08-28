#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_AUTOREMOVE=1
export HOMEBREW_NO_ENV_HINTS=1

required_tap=$(php_darwin_package_config tap)
installed_taps=$(brew tap) || php_darwin_die 'could not list installed Homebrew taps'
unused_taps=()
untap_log=$(mktemp "${RUNNER_TEMP:-/tmp}/php-darwin-untap.XXXXXX") || \
  php_darwin_die 'could not create the Homebrew untap log'
trap 'rm -f "$untap_log"' EXIT

while IFS= read -r installed_tap; do
  [ -n "$installed_tap" ] || continue
  case "$installed_tap" in
    homebrew/core|"$required_tap") ;;
    *) unused_taps+=("$installed_tap") ;;
  esac
done <<< "$installed_taps"

if [ "${#unused_taps[@]}" -gt 0 ]; then
  if ! brew untap --force "${unused_taps[@]}" > "$untap_log" 2>&1; then
    cat "$untap_log" >&2
    php_darwin_die 'could not remove unused Homebrew taps'
  fi
fi

printf 'Removed %s unused Homebrew tap(s)\n' "${#unused_taps[@]}"
