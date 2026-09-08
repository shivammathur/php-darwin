#!/usr/bin/env bash

output_dir=${1:?}
profile_name=${PROFILE_NAME:?}
mkdir -p "$output_dir" || exit 1
for command_name in php php-config pear pecl; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'php-darwin-profile: %s is not on PATH\n' "$command_name" >&2
    exit 1
  }
done

php -m | awk '/^\[/ || /^[[:space:]]*$/ { next } { print tolower($0) }' | \
  LC_ALL=C sort -u > "$output_dir/extensions.txt" || exit 1
php -i | awk -F ' => ' '
  /^[^[:space:]<][^=]* => / {
    key=tolower($1); gsub(/[[:space:]]+/, " ", key); print key
  }
' | LC_ALL=C sort -u > "$output_dir/php-info-keys.txt" || exit 1
# shellcheck disable=SC2016
php -r '
  $functions = ["curl_init", "date_create", "filter_var", "gd_info", "gettext", "gmp_init",
    "iconv", "mysqli_connect", "openssl_encrypt", "pg_connect", "simplexml_load_string",
    "socket_create", "sodium_crypto_secretbox", "tidy_parse_string", "xml_parser_create"];
  $classes = ["DOMDocument", "IntlDateFormatter", "PDO", "Phar", "SQLite3", "XSLTProcessor", "ZipArchive"];
  $result = ["classes" => array_fill_keys($classes, false), "debug" => (bool) PHP_DEBUG,
    "functions" => array_fill_keys($functions, false), "sapi" => PHP_SAPI,
    "stream_filters" => stream_get_filters(), "stream_transports" => stream_get_transports(),
    "stream_wrappers" => stream_get_wrappers(), "version_minor" => PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION,
    "zts" => (bool) PHP_ZTS];
  foreach ($functions as $function) $result["functions"][$function] = function_exists($function);
  foreach ($classes as $class) $result["classes"][$class] = class_exists($class);
  foreach (["stream_filters", "stream_transports", "stream_wrappers"] as $key) sort($result[$key]);
  echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
' > "$output_dir/runtime.json" || exit 1
pecl config-show > "$output_dir/pecl-config.txt" || exit 1
for key in bin_dir cache_dir download_dir ext_dir php_bin php_dir php_ini temp_dir; do
  grep -Eq "[[:space:]]${key}[[:space:]]" "$output_dir/pecl-config.txt" || exit 1
  printf '%s\n' "$key" >> "$output_dir/pecl-config-keys.txt" || exit 1
done
LC_ALL=C sort -u "$output_dir/pecl-config-keys.txt" -o "$output_dir/pecl-config-keys.txt" || exit 1
{
  printf 'name=%s\n' "$profile_name"
  printf 'php=%s\n' "$(php -r 'echo PHP_VERSION;')"
  printf 'php_config=%s\n' "$(php-config --version)"
  printf 'pear=%s\n' "$(pear version | awk '/PEAR Version:/ {print $3; exit}')"
  printf 'pecl=%s\n' "$(pecl version | awk '/PEAR Version:/ {print $3; exit}')"
} > "$output_dir/tool-versions.txt" || exit 1
