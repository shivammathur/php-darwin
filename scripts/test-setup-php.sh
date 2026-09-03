#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

version=${PHP_VERSION:-${1:-}}
php_darwin_validate_version "$version"

# shellcheck disable=SC2016
php -r '
  $expected = getenv("PHP_VERSION");
  $actual = PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION;
  if ($actual !== $expected) {
    fwrite(STDERR, "Expected PHP $expected, found $actual\n");
    exit(1);
  }
' || php_darwin_die "PHP $version is not active"

if [ "${PHP_DARWIN_REQUIRE_XDEBUG:-false}" = true ]; then
  # shellcheck disable=SC2016
  php -r '
    if (!extension_loaded("xdebug")) {
      fwrite(STDERR, "Xdebug is not loaded\n");
      exit(1);
    }
  ' || php_darwin_die 'cache-extensions integration failed'
fi
if [ "${PHP_DARWIN_REQUIRE_PCOV:-false}" = true ]; then
  # shellcheck disable=SC2016
  php -r '
    if (!extension_loaded("pcov")) {
      fwrite(STDERR, "PCOV is not loaded\n");
      exit(1);
    }
  ' || php_darwin_die 'PCOV cache integration failed'
fi
if [ "${PHP_DARWIN_REQUIRE_XDEBUG:-false}" != true ] && \
  [ "${PHP_DARWIN_REQUIRE_PCOV:-false}" != true ]; then
  while IFS= read -r extension; do
    php -r "if (extension_loaded('$extension')) { exit(1); }" || \
      php_darwin_die "$extension is enabled by default after a direct cache install"
  done < <(bash "$script_dir/cached-extensions.sh" "$version")
fi

tap=$(php_darwin_package_config tap) || php_darwin_die 'could not read the Homebrew tap configuration'
formula=$(php_darwin_formula "$version" release nts) || php_darwin_die 'could not resolve the PHP formula'
trust_json=$(brew trust --json=v1) || php_darwin_die 'could not read Homebrew trust state'
if ! php_darwin_tap_trusted "$tap" "$trust_json" && \
  ! php_darwin_formula_trusted "$tap/$formula" "$trust_json"; then
  php_darwin_die "Homebrew does not trust the installed PHP $version formula"
fi

printf 'Verified php-darwin cache installation for PHP %s' "$version"
[ "${PHP_DARWIN_REQUIRE_XDEBUG:-false}" != true ] || printf ' with cache-extensions'
printf '\n'
