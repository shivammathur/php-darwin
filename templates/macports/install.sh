#!/usr/bin/env bash

# Generated for one tested php-darwin Intel/MacPorts cache. It deliberately
# contains no repository checkout, encoded payload, or auxiliary script.

php_darwin_macports_version='__PHP_VERSION__'
php_darwin_macports_semver='__PHP_SEMVER__'
php_darwin_macports_build='__BUILD__'
php_darwin_macports_ts='__TS__'
php_darwin_macports_prefix='__PREFIX__'
php_darwin_macports_archive_name='__ARCHIVE__'
php_darwin_macports_archive_sha256='__SHA256__'
php_darwin_macports_archive_bytes='__BYTES__'
php_darwin_macports_minimum_macos='__MINIMUM_MACOS__'
php_darwin_macports_release_url='__RELEASE_URL__'

php_darwin_macports_die() {
  printf 'php-darwin: %s failed: %s\n' "${php_darwin_macports_phase:-install}" "$*" >&2
  exit 1
}

php_darwin_macports_cleanup() {
  local status=$?

  trap '' HUP INT TERM
  if [ "$status" -ne 0 ] && [ "${php_darwin_macports_mutated:-false}" = true ]; then
    if [ -d "$php_darwin_macports_prefix" ] && [ ! -L "$php_darwin_macports_prefix" ]; then
      find "$php_darwin_macports_prefix" -mindepth 1 -delete >/dev/null 2>&1 || true
      rmdir "$php_darwin_macports_prefix" >/dev/null 2>&1 || true
    fi
    if [ -d "${php_darwin_macports_backup:-}" ] && [ ! -L "$php_darwin_macports_backup" ]; then
      mv "$php_darwin_macports_backup" "$php_darwin_macports_prefix" >/dev/null 2>&1 || \
        printf 'php-darwin: restore the previous Intel cache with: mv %q %q\n' \
          "$php_darwin_macports_backup" "$php_darwin_macports_prefix" >&2
    fi
  fi
  if [ -d "${php_darwin_macports_tmp:-}" ] && [ ! -L "$php_darwin_macports_tmp" ]; then
    find "$php_darwin_macports_tmp" -mindepth 1 -delete >/dev/null 2>&1 || true
    rmdir "$php_darwin_macports_tmp" >/dev/null 2>&1 || true
  fi
  return "$status"
}

trap php_darwin_macports_cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

requested_version=${1:-$php_darwin_macports_version}
requested_build=${2:-$php_darwin_macports_build}
requested_ts=${3:-$php_darwin_macports_ts}
[ "$(uname -s)" = Darwin ] || php_darwin_macports_die 'macOS is required'
[ "$(uname -m)" = x86_64 ] || php_darwin_macports_die 'this cache requires an Intel Mac'
php_darwin_macports_macos=$(sw_vers -productVersion | cut -d. -f1) || \
  php_darwin_macports_die 'could not determine the macOS version'
[[ "$php_darwin_macports_macos" =~ ^[0-9]+$ ]] && \
  [ "$php_darwin_macports_macos" -ge "$php_darwin_macports_minimum_macos" ] || \
  php_darwin_macports_die "macOS $php_darwin_macports_minimum_macos or newer is required"
[ "$requested_version" = "$php_darwin_macports_version" ] || \
  php_darwin_macports_die "this installer contains PHP $php_darwin_macports_version"
[ "$requested_build" = "$php_darwin_macports_build" ] || \
  php_darwin_macports_die "this installer contains the $php_darwin_macports_build build"
[ "$requested_ts" = "$php_darwin_macports_ts" ] || \
  php_darwin_macports_die "this installer contains the $php_darwin_macports_ts build"

for php_darwin_macports_tool in curl shasum tar zstd; do
  command -v "$php_darwin_macports_tool" >/dev/null 2>&1 || \
    php_darwin_macports_die "required command is missing: $php_darwin_macports_tool"
done

php_darwin_macports_tmp=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-macports.XXXXXX") || \
  php_darwin_macports_die 'could not create the installation directory'
php_darwin_macports_archive="$php_darwin_macports_tmp/$php_darwin_macports_archive_name"
php_darwin_macports_phase=download
if [ -n "${PHP_DARWIN_MACPORTS_ARCHIVE:-}" ]; then
  [ -f "$PHP_DARWIN_MACPORTS_ARCHIVE" ] || php_darwin_macports_die 'local archive does not exist'
  php_darwin_macports_archive=$PHP_DARWIN_MACPORTS_ARCHIVE
else
  curl --fail --location --silent --show-error \
    --output "$php_darwin_macports_archive" \
    "$php_darwin_macports_release_url/$php_darwin_macports_archive_name" || \
    php_darwin_macports_die 'could not download the cache archive'
fi

php_darwin_macports_phase=verify
php_darwin_macports_actual_bytes=$(wc -c < "$php_darwin_macports_archive" | tr -d '[:space:]')
[ "$php_darwin_macports_actual_bytes" = "$php_darwin_macports_archive_bytes" ] || \
  php_darwin_macports_die "archive size mismatch (expected $php_darwin_macports_archive_bytes, found $php_darwin_macports_actual_bytes)"
php_darwin_macports_actual_sha256=$(shasum -a 256 "$php_darwin_macports_archive" | awk '{print $1}') || \
  php_darwin_macports_die 'could not hash the cache archive'
[ "$php_darwin_macports_actual_sha256" = "$php_darwin_macports_archive_sha256" ] || \
  php_darwin_macports_die 'archive checksum mismatch'

php_darwin_macports_parent=${php_darwin_macports_prefix%/*}
if [ ! -d "$php_darwin_macports_parent" ]; then
  if [ -w "${php_darwin_macports_parent%/*}" ]; then
    mkdir -p "$php_darwin_macports_parent" || php_darwin_macports_die 'could not create the cache parent'
  else
    command -v sudo >/dev/null 2>&1 || php_darwin_macports_die 'sudo is required to create the cache parent'
    sudo -n mkdir -p "$php_darwin_macports_parent" || php_darwin_macports_die 'could not create the cache parent'
    sudo -n chown "$(id -u):$(id -g)" "$php_darwin_macports_parent" || \
      php_darwin_macports_die 'could not make the cache parent writable'
  fi
fi
[ -d "$php_darwin_macports_parent" ] && [ ! -L "$php_darwin_macports_parent" ] && \
  [ -w "$php_darwin_macports_parent" ] || php_darwin_macports_die 'the cache parent is not a writable directory'

php_darwin_macports_backup="$php_darwin_macports_tmp/previous"
if [ -e "$php_darwin_macports_prefix" ] || [ -L "$php_darwin_macports_prefix" ]; then
  [ -d "$php_darwin_macports_prefix" ] && [ ! -L "$php_darwin_macports_prefix" ] || \
    php_darwin_macports_die 'the cache prefix is not a directory'
  mv "$php_darwin_macports_prefix" "$php_darwin_macports_backup" || \
    php_darwin_macports_die 'could not preserve the previous Intel cache'
fi

php_darwin_macports_phase=extract
php_darwin_macports_mutated=true
zstd -q -dc "$php_darwin_macports_archive" | tar -xf - -C /
php_darwin_macports_pipeline=("${PIPESTATUS[@]}")
[ "${php_darwin_macports_pipeline[0]}" -eq 0 ] && [ "${php_darwin_macports_pipeline[1]}" -eq 0 ] || \
  php_darwin_macports_die 'could not extract the cache archive'

php_darwin_macports_php="$php_darwin_macports_prefix/bin/php"
[ -x "$php_darwin_macports_php" ] || php_darwin_macports_die 'the extracted PHP executable is missing'
php_darwin_macports_actual_version=$("$php_darwin_macports_php" -n -r \
  'echo PHP_MAJOR_VERSION, ".", PHP_MINOR_VERSION, ".", PHP_RELEASE_VERSION;' 2>/dev/null) || \
  php_darwin_macports_die 'the extracted PHP executable did not start'
[ "$php_darwin_macports_actual_version" = "$php_darwin_macports_semver" ] || \
  php_darwin_macports_die "expected PHP $php_darwin_macports_semver, found $php_darwin_macports_actual_version"
"$php_darwin_macports_php" -r \
  'exit(extension_loaded("xdebug") || extension_loaded("pcov") ? 1 : 0);' 2>/dev/null || \
  php_darwin_macports_die 'a cached coverage extension is enabled by default'

if [ -n "${GITHUB_PATH:-}" ]; then
  printf '%s/bin\n' "$php_darwin_macports_prefix" >> "$GITHUB_PATH" || \
    php_darwin_macports_die 'could not add PHP to the Actions path'
fi
printf '%s\n' "$php_darwin_macports_prefix" > "${RUNNER_TEMP:-/tmp}/php-darwin-prefix" || \
  php_darwin_macports_die 'could not record the installed prefix'

php_darwin_macports_phase=cleanup
if [ -d "$php_darwin_macports_backup" ]; then
  find "$php_darwin_macports_backup" -mindepth 1 -delete || \
    php_darwin_macports_die 'could not remove the replaced Intel cache'
  rmdir "$php_darwin_macports_backup" || php_darwin_macports_die 'could not remove the replaced Intel cache directory'
fi
php_darwin_macports_mutated=false
printf 'Installed PHP %s from the Intel/MacPorts cache at %s\n' \
  "$php_darwin_macports_actual_version" "$php_darwin_macports_prefix"
