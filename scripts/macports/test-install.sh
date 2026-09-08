#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/macports/lib.sh
. "$script_dir/lib.sh"

version=${PHP_VERSION:-8.5}
build=${BUILD:-release}
ts=${TS:-nts}
prefix_file="${RUNNER_TEMP:-/tmp}/php-darwin-prefix"
[ -s "$prefix_file" ] || php_darwin_macports_die 'the installer did not record its prefix'
IFS= read -r prefix < "$prefix_file"
expected_prefix=$(php_darwin_macports_prefix "$version" "$build" "$ts") || exit 1
[ "$prefix" = "$expected_prefix" ] || php_darwin_macports_die "unexpected installed prefix: $prefix"
[ "$(command -v php)" = "$prefix/bin/php" ] || php_darwin_macports_die 'the cached PHP is not first on PATH'
[ "$(command -v php-config)" = "$prefix/bin/php-config" ] || php_darwin_macports_die 'the cached php-config is not first on PATH'

actual_version=$(php -n -r 'echo PHP_MAJOR_VERSION, ".", PHP_MINOR_VERSION;') || \
  php_darwin_macports_die 'PHP did not start'
[ "$actual_version" = "$version" ] || php_darwin_macports_die "expected PHP $version, found $actual_version"
actual_zts=$(php -n -r 'echo PHP_ZTS ? "zts" : "nts";') || php_darwin_macports_die 'could not inspect PHP ZTS mode'
[ "$actual_zts" = "$ts" ] || php_darwin_macports_die "expected $ts, found $actual_zts"
actual_debug=$(php -n -r 'echo PHP_DEBUG ? "debug" : "release";') || php_darwin_macports_die 'could not inspect PHP debug mode'
[ "$actual_debug" = "$build" ] || php_darwin_macports_die "expected $build, found $actual_debug"

while IFS= read -r extension; do
  [ -n "$extension" ] || continue
  case "$extension" in \#*) continue ;; esac
  # shellcheck disable=SC2016
  php -r 'exit(extension_loaded($argv[1]) ? 0 : 1);' -- "$extension" || \
    php_darwin_macports_die "required PHP extension is missing: $extension"
done < "$php_darwin_macports_root/conf/macports-critical-extensions"
php -r 'exit(extension_loaded("xdebug") || extension_loaded("pcov") ? 1 : 0);' || \
  php_darwin_macports_die 'xdebug or pcov is enabled by default'

extension_dir=$(php-config --extension-dir) || php_darwin_macports_die 'php-config could not report the extension directory'
[ -f "$extension_dir/xdebug.so" ] || php_darwin_macports_die 'the cached xdebug extension is missing'
[ -f "$extension_dir/pcov.so" ] || php_darwin_macports_die 'the cached pcov extension is missing'
php -n -d "zend_extension=$extension_dir/xdebug.so" -r 'exit(extension_loaded("xdebug") ? 0 : 1);' || \
  php_darwin_macports_die 'the cached xdebug extension cannot be enabled'
php -n -d "extension=$extension_dir/pcov.so" -r 'exit(extension_loaded("pcov") ? 0 : 1);' || \
  php_darwin_macports_die 'the cached pcov extension cannot be enabled'
if ! command -v pear >/dev/null 2>&1 || ! pear version >/dev/null; then
  php_darwin_macports_die 'PEAR is not functional'
fi
if ! command -v pecl >/dev/null 2>&1 || ! pecl version >/dev/null; then
  php_darwin_macports_die 'PECL is not functional'
fi
if ! command -v phpize >/dev/null 2>&1 || ! phpize --version >/dev/null; then
  php_darwin_macports_die 'phpize is not functional'
fi
pecl_config=$(pecl config-show) || php_darwin_macports_die 'could not read the PECL configuration'
pecl_ext_dir=$(awk '$0 ~ /[[:space:]]ext_dir[[:space:]]/ { print $NF; exit }' <<< "$pecl_config")
pecl_php_bin=$(awk '$0 ~ /[[:space:]]php_bin[[:space:]]/ { print $NF; exit }' <<< "$pecl_config")
pecl_php_ini=$(awk '$0 ~ /[[:space:]]php_ini[[:space:]]/ { print $NF; exit }' <<< "$pecl_config")
[ "$pecl_ext_dir" = "$extension_dir" ] || php_darwin_macports_die 'PECL extension_dir does not match php-config'
[ "$pecl_php_bin" = "$prefix/bin/php" ] || php_darwin_macports_die 'PECL php_bin does not use cached PHP'
[ "$pecl_php_ini" = "$prefix/etc/php${version/./}/php.ini" ] || \
  php_darwin_macports_die 'PECL php_ini does not use cached PHP configuration'

# shellcheck disable=SC2016
php -r '
  $checks = [
    function_exists("curl_init"), class_exists("DOMDocument"), function_exists("gd_info"),
    class_exists("IntlDateFormatter"), function_exists("mysqli_connect"),
    in_array("https", stream_get_wrappers(), true), in_array("tls", stream_get_transports(), true),
    PDO::getAvailableDrivers() !== []
  ];
  exit(in_array(false, $checks, true) ? 1 : 0);
' || php_darwin_macports_die 'the PHP runtime capability probe failed'

if command -v php-fpm >/dev/null 2>&1; then
  php-fpm -t >/dev/null 2>&1 || php_darwin_macports_die 'php-fpm configuration validation failed'
fi
printf 'Verified PHP %s %s/%s from the Intel/MacPorts cache\n' "$version" "$build" "$ts"
