#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib/lib.sh
. "$script_dir/../../lib/lib.sh"
# shellcheck source=scripts/tests/helpers/published-installer.sh
. "$script_dir/../helpers/published-installer.sh"

version=${PHP_VERSION:-${1:-}}
php_darwin_validate_version "$version"
tmp_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-e2e.XXXXXX") || \
  php_darwin_die 'could not create the installer test directory'
installer="$tmp_dir/install.sh"

cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -n "${PHP_DARWIN_TEST_INSTALLER:-}" ]; then
  cp "$PHP_DARWIN_TEST_INSTALLER" "$installer" || exit 1
else
  php_darwin_fetch_published_installer "$version" "$installer" || \
    php_darwin_die "could not download the PHP $version release installer"
fi
bash "$installer" "$version" release nts || \
  php_darwin_die "the PHP $version release installer failed"
