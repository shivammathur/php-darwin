#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/macports/lib.sh
. "$script_dir/lib.sh"

output_dir=${1:?}
profile_name=${PROFILE_NAME:?}
mkdir -p "$output_dir" || php_darwin_macports_die 'could not create the profile directory'
command -v php >/dev/null 2>&1 || php_darwin_macports_die 'PHP is not on PATH'
command -v php-config >/dev/null 2>&1 || php_darwin_macports_die 'php-config is not on PATH'
command -v pecl >/dev/null 2>&1 || php_darwin_macports_die 'PECL is not on PATH'

php -m | awk '
  /^\[/ || /^[[:space:]]*$/ { next }
  { print tolower($0) }
' | LC_ALL=C sort -u > "$output_dir/extensions.txt" || php_darwin_macports_die 'could not profile PHP extensions'
php -i | awk -F ' => ' '
  /^[^[:space:]<][^=]* => / {
    key=tolower($1)
    gsub(/[[:space:]]+/, " ", key)
    print key
  }
' | LC_ALL=C sort -u > "$output_dir/php-info-keys.txt" || php_darwin_macports_die 'could not profile phpinfo keys'
# shellcheck disable=SC2016
php -r '
  $functions = [
    "curl_init", "date_create", "filter_var", "gd_info", "gettext", "gmp_init",
    "iconv", "mysqli_connect", "openssl_encrypt", "pg_connect", "simplexml_load_string",
    "socket_create", "sodium_crypto_secretbox", "tidy_parse_string", "xml_parser_create"
  ];
  $classes = ["DOMDocument", "IntlDateFormatter", "PDO", "Phar", "SQLite3", "XSLTProcessor", "ZipArchive"];
  $result = [
    "classes" => array_fill_keys($classes, false),
    "debug" => (bool) PHP_DEBUG,
    "functions" => array_fill_keys($functions, false),
    "sapi" => PHP_SAPI,
    "stream_filters" => stream_get_filters(),
    "stream_transports" => stream_get_transports(),
    "stream_wrappers" => stream_get_wrappers(),
    "version_minor" => PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION,
    "zts" => (bool) PHP_ZTS
  ];
  foreach ($functions as $function) $result["functions"][$function] = function_exists($function);
  foreach ($classes as $class) $result["classes"][$class] = class_exists($class);
  foreach (["stream_filters", "stream_transports", "stream_wrappers"] as $key) sort($result[$key]);
  echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
' > "$output_dir/runtime.json" || php_darwin_macports_die 'could not create the runtime profile'

pecl config-show > "$output_dir/pecl-config.txt" || php_darwin_macports_die 'could not read the PECL configuration'
for key in bin_dir cache_dir download_dir ext_dir php_bin php_dir php_ini temp_dir; do
  grep -Eq "[[:space:]]${key}[[:space:]]" "$output_dir/pecl-config.txt" || \
    php_darwin_macports_die "PECL $key is not configured"
  printf '%s\n' "$key" >> "$output_dir/pecl-config-keys.txt" || php_darwin_macports_die 'could not write PECL profile'
done
LC_ALL=C sort -u "$output_dir/pecl-config-keys.txt" -o "$output_dir/pecl-config-keys.txt" || \
  php_darwin_macports_die 'could not sort the PECL profile'
{
  printf 'name=%s\n' "$profile_name"
  printf 'php=%s\n' "$(php -r 'echo PHP_VERSION;')"
  printf 'php_config=%s\n' "$(php-config --version)"
  printf 'pear=%s\n' "$(pear version | awk '/PEAR Version:/ {print $3; exit}')"
  printf 'pecl=%s\n' "$(pecl version | awk '/PEAR Version:/ {print $3; exit}')"
} > "$output_dir/tool-versions.txt" || php_darwin_macports_die 'could not create the tool profile'
