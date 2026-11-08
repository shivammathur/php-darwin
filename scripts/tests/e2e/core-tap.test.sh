#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib/lib.sh
. "$script_dir/../../lib/lib.sh"
[ "${GITHUB_ACTIONS:-}" = true ] || php_darwin_die 'core tap fixtures require an Actions runner'
case "${CORE_TAP_STATE:-}" in present|absent) ;; *) php_darwin_die 'invalid core tap state' ;; esac
brew_prefix=$(brew --prefix)
repository=$(brew --repository)
core="$repository/Library/Taps/homebrew/homebrew-core"
backup="${RUNNER_TEMP:?}/php-darwin-core-tap-$$"
original=false
[ ! -L "$core" ] || php_darwin_die 'core tap fixture cannot move a symlink'
[ ! -e "$backup" ] && [ ! -L "$backup" ] || php_darwin_die 'core tap fixture backup already exists'
if [ -e "$core" ] || [ -L "$core" ]; then original=true; fi
cleanup() {
  local status=$?
  trap - EXIT
  if [ -d "$backup" ]; then
    if [ -e "$core" ] || [ -L "$core" ]; then
      php_darwin_remove_tap_path "$brew_prefix" "$core" || status=1
    fi
    mv "$backup" "$core" || sudo -n mv "$backup" "$core" || status=1
  elif [ "$original" = false ]; then
    if [ -e "$core" ] || [ -L "$core" ]; then
      php_darwin_remove_tap_path "$brew_prefix" "$core" || status=1
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if [ "$CORE_TAP_STATE" = absent ] && [ "$original" = true ]; then
  mv "$core" "$backup" || sudo -n mv "$core" "$backup"
elif [ "$CORE_TAP_STATE" = present ] && [ "$original" = false ]; then
  brew tap --force homebrew/core
fi
check_core() {
  if [ "$CORE_TAP_STATE" = absent ]; then
    [ ! -e "$core" ] && [ ! -L "$core" ] || php_darwin_die 'a cache install unexpectedly created homebrew/core'
  else
    [ -d "$core" ] || php_darwin_die 'a cache install removed homebrew/core'
  fi
}
export PHP_DARWIN_REQUIRE_CACHE=true PHP_DARWIN_REQUIRE_PACKS=true PHP_DARWIN_REQUIRE_XDEBUG=true
export PHP_DARWIN_EXTENSIONS=xdebug,pcov,apcu,imagick,mongodb,memcached,swoole,amqp,yaml,ssh2,rdkafka,redis
report="$RUNNER_TEMP/core-tap-${CORE_TAP_STATE}.jsonl"
: > "$report"
while read -r channel version; do
  export PHP_VERSION="$version"
  export PHP_DARWIN_REQUIRE_PCOV=true
  case "$version" in 5.6|7.0) export PHP_DARWIN_REQUIRE_PCOV=false ;; esac
  check_core
  bash "$script_dir/../helpers/prepare-e2e.sh"
  for phase in cold warm; do
    bash "$script_dir/release.test.sh"
    check_core
    bash "$script_dir/setup-php.test.sh"
    check_core
    jq -nc --arg php "$version" --arg state "$CORE_TAP_STATE" --arg phase "$phase" \
      '{php:$php,core_tap:$state,phase:$phase,source_builds:0,success:true}' >> "$report"
  done
done < <(php_darwin_configured_versions)
