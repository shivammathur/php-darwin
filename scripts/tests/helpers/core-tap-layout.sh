#!/usr/bin/env bash
# Temporarily hide core while a native job tests the actual release installer.
set -euo pipefail
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$script_dir/../../lib/lib.sh"
[ "${GITHUB_ACTIONS:-}" = true ] || php_darwin_die 'core layout fixtures require an Actions runner'
prefix=$(brew --prefix)
repository=$(brew --repository)
core="$repository/Library/Taps/homebrew/homebrew-core"
backup="${RUNNER_TEMP:?}/php-darwin-native-core-backup"
state="$RUNNER_TEMP/php-darwin-native-core-state"
case "$core" in "$prefix/Library/Taps/homebrew/homebrew-core"|"$prefix/Homebrew/Library/Taps/homebrew/homebrew-core") ;; *) exit 1 ;; esac
case "${1:-}" in
  prepare)
    [ ! -e "$state" ] && [ ! -L "$state" ] && [ ! -e "$backup" ] && [ ! -L "$backup" ]
    [ ! -L "$core" ]
    if [ -e "$core" ]; then
      [ -d "$core" ]
      printf 'present\n' > "$state"
      mv "$core" "$backup" || sudo -n mv "$core" "$backup"
    else
      printf 'absent\n' > "$state"
    fi
    ;;
  restore)
    [ -f "$state" ] || exit 0
    unexpected=false
    if [ -d "$backup" ] || [ "$(cat "$state")" = absent ]; then
      if [ -e "$core" ] || [ -L "$core" ]; then
        unexpected=true
        php_darwin_remove_tap_path "$prefix" "$core"
      fi
      if [ -d "$backup" ]; then
        mv "$backup" "$core" || sudo -n mv "$backup" "$core"
      fi
    fi
    rm "$state"
    [ "$unexpected" = false ] || php_darwin_die 'native installation unexpectedly created homebrew/core'
    ;;
  *) exit 2 ;;
esac
