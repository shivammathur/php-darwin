#!/usr/bin/env bash
# Preserve the original tap during no-core installs or pinned recipe preparation.
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
    [ ! -e "$state" ] && [ ! -L "$state" ] && [ ! -e "$backup" ] && [ ! -L "$backup" ] && [ ! -e "$state.fixture" ]
    [ ! -L "$core" ]
    if [ -e "$core" ]; then
      [ -d "$core" ]
      printf 'present\n' > "$state"
      mv "$core" "$backup" || sudo -n mv "$core" "$backup"
    else
      printf 'absent\n' > "$state"
    fi
    ;;
  fixture)
    fixture=${2:?Shallow checkout required}
    commit=${3:?Pinned commit required}
    [[ "$commit" =~ ^[a-f0-9]{40}$ ]]
    [ -f "$state" ] && [ ! -e "$core" ] && [ ! -L "$core" ]
    [ "$(git -C "$fixture" rev-parse --is-shallow-repository)" = true ]
    [ "$(git -C "$fixture" rev-parse HEAD)" = "$commit" ]
    printf '%s\n' "$commit" > "$state.fixture"
    mkdir -p "${core%/*}"
    cp -R "$fixture" "$core"
    printf 'PHP_DARWIN_CORE_CHECKOUT=%s\n' "$core" >> "${GITHUB_ENV:?}"
    ;;
  restore)
    [ -f "$state" ] || exit 0
    unexpected=false
    if [ -d "$backup" ] || [ "$(cat "$state")" = absent ]; then
      if [ -e "$core" ] || [ -L "$core" ]; then
        unexpected=true
        if [ -f "$state.fixture" ] && [ ! -L "$core" ] && \
          [ "$(git -C "$core" rev-parse HEAD 2>/dev/null)" = "$(cat "$state.fixture")" ] && \
          [ "$(git -C "$core" rev-parse --is-shallow-repository 2>/dev/null)" = true ]; then
          unexpected=false
        fi
        php_darwin_remove_tap_path "$prefix" "$core"
      fi
      if [ -d "$backup" ]; then
        mv "$backup" "$core" || sudo -n mv "$backup" "$core"
      fi
    fi
    rm -f "$state" "$state.fixture"
    if [ -n "${GITHUB_ENV:-}" ]; then
      printf 'PHP_DARWIN_CORE_CHECKOUT=\nPHP_DARWIN_CORE_PREPARED=\nHOMEBREW_NO_INSTALL_FROM_API=%s\n' \
        "$(if [ -d "$core" ]; then printf 1; fi)" >> "$GITHUB_ENV"
    fi
    [ "$unexpected" = false ] || php_darwin_die 'native installation unexpectedly created homebrew/core'
    ;;
  *) exit 2 ;;
esac
