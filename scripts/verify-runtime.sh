#!/usr/bin/env bash

prefix=${1:?}
formula=${2:?}
expected_version=${3:?}
extensions=${4:?}
php_bin="$prefix/opt/$formula/bin/php"
php_config="$prefix/opt/$formula/bin/php-config"
[ -f "$php_bin" ] && [ -x "$php_bin" ] && [ ! -L "$php_bin" ] || {
  printf 'Cached PHP binary is missing or not executable\n' >&2
  exit 1
}
[ -f "$php_config" ] && [ ! -L "$php_config" ] || {
  printf 'Cached php-config is missing or is a symlink\n' >&2
  exit 1
}

# Read the same literal assignment used by setup-php's php_semver. Never source
# php-config or start PHP to read a version already authenticated by the cache.
installed_version=
while IFS= read -r config_line; do
  case "$config_line" in
    version=\"*\")
      [ -z "$installed_version" ] || { printf 'Duplicate php-config version\n' >&2; exit 1; }
      installed_version=${config_line#version=\"}
      installed_version=${installed_version%\"}
      ;;
  esac
done < "$php_config"
[ "$installed_version" = "$expected_version" ] || {
  printf 'Cached php-config version mismatch: expected %s, found %s\n' \
    "$expected_version" "$installed_version" >&2
  exit 1
}
while IFS=$'\t' read -r extension extension_type extension_path extra; do
  [[ "$extension" =~ ^[A-Za-z0-9_]+$ ]] && [ -z "$extra" ] && \
    [[ "$extension_type" =~ ^(extension|zend_extension)$ ]] && \
    [[ "$extension_path" =~ ^(Cellar|lib)/ ]] && \
    [[ ! "$extension_path" =~ (^|/)\.\.(/|$) ]] || exit 1
  [ -s "$prefix/$extension_path" ] && [ ! -L "$prefix/$extension_path" ] || {
    printf 'Cached %s module is missing or is a symlink\n' "$extension" >&2
    exit 1
  }
done < "$extensions"

# Release QA tests PHP and each extension on every supported runner before
# publication. Keep explicit load probes available for installation diagnostics.
if [ "${PHP_DARWIN_VERIFY_RUNTIME:-false}" = true ]; then
  installed_version=$("$php_bin" -n -r 'echo PHP_VERSION;') || exit 1
  [ "$installed_version" = "$expected_version" ] || exit 1
  while IFS=$'\t' read -r extension extension_type extension_path; do
    "$php_bin" -n -d "$extension_type=$prefix/$extension_path" -r \
      "if (!extension_loaded('$extension')) { exit(1); }" || {
      printf 'Cached %s module does not load\n' "$extension" >&2
      exit 1
    }
  done < "$extensions"
fi
