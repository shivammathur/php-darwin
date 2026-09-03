#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

version=${PHP_VERSION:-${1:-}}
php_darwin_validate_version "$version"
release_repository=$(php_darwin_package_config release_repository) || \
  php_darwin_die 'could not read the release repository configuration'
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

curl --fail --location --retry 3 --connect-timeout 10 \
  --output "$installer" \
  "https://github.com/$release_repository/releases/download/php-$version/install.sh" || \
  php_darwin_die "could not download the PHP $version release installer"
bash "$installer" "$version" release nts || \
  php_darwin_die "the PHP $version release installer failed"

