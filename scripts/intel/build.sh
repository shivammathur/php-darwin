#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$script_dir/../.." && pwd)
stage=${1:-all}

[ "$(uname -m)" = x86_64 ] || {
  printf 'php-darwin-intel: an x86_64 runner is required\n' >&2
  exit 1
}
export ARCH=x86_64
export PHP_DARWIN_BACKEND=intel
export PHP_DARWIN_FORCE_SOURCE=true

case "$stage" in
  extensions) exec bash "$root/scripts/build-extensions.sh" ;;
  prepare|cleanup|install|package|verify|reset|all)
    exec bash "$root/scripts/build.sh" "$stage"
    ;;
  *) printf 'php-darwin-intel: usage: build.sh prepare|cleanup|install|extensions|package|verify|reset|all\n' >&2; exit 1 ;;
esac
