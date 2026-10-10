#!/usr/bin/env bash
# Select and authenticate an immutable archive before executing its installer.
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$script_dir/../lib/lib.sh"
version=${1:-$(php_darwin_package_config current_version)}
build=${2:-release}
ts=${3:-nts}
local_archive=${4:-}
extensions_input=${5-${PHP_DARWIN_EXTENSIONS:-${INPUT_EXTENSIONS:-}}}
[ "$(uname -s)" = Darwin ] || php_darwin_die 'the cache installer only supports macOS'
for required in brew curl jq tar zstd; do
  command -v "$required" >/dev/null 2>&1 || php_darwin_die "$required is required"
done
arch=$(php_darwin_normalize_arch "$(uname -m)") || exit 1
php_darwin_validate_version "$version"
php_darwin_validate_build "$build"
php_darwin_validate_ts "$ts"
asset=$(php_darwin_asset "$version" "$build" "$ts" "$arch") || exit 1
channel=$(php_darwin_version_channel "$version") || exit 1
release_repository=${PHP_DARWIN_RELEASE_REPOSITORY:-$(php_darwin_package_config release_repository)}
[[ "$release_repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || php_darwin_die 'invalid release repository'
tmp_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-bootstrap.XXXXXX") || exit 1
extension_dir="$tmp_dir/extensions"
extension_prefetch_pid=
installer_pid=
cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  # The transaction handles rollback before its bootstrap removes staging.
  if [ -n "$installer_pid" ]; then kill -TERM "$installer_pid" 2>/dev/null || true; wait "$installer_pid" || true; fi
  if [ -n "$extension_prefetch_pid" ]; then kill -TERM "$extension_prefetch_pid" 2>/dev/null || true; wait "$extension_prefetch_pid" || true; fi
  rm -rf "$tmp_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
# DOWNLOAD_FUNCTIONS
php_darwin_start_archive_hash() { actual_hash=$(php_darwin_sha256 "$1") || exit 1; }
php_darwin_wait_for_archive_hash() { :; }
# Download packs concurrently with PHP; no PHP files or Homebrew state are changed here.
if [ -n "$extensions_input" ] && extension_node=$(command -v "${PHP_DARWIN_NODE:-node}"); then
  mkdir -p "$extension_dir" || exit 1
# PREFETCH_SOURCE
  (
    "$extension_node" "$extension_dir/prefetch.cjs" "$extension_dir" "$extensions_input" "$version" "$build" "$ts" "$arch" > "$extension_dir/prefetch.log" 2>&1 &
    worker=$!
    trap 'kill -TERM "$worker" 2>/dev/null; wait "$worker"; exit 143' TERM INT HUP
    prefetch_status=0
    wait "$worker" || prefetch_status=$?
    printf '%s\n' "$prefetch_status" > "$extension_dir/complete"
  ) &
  extension_prefetch_pid=$!
fi
archive="$tmp_dir/$asset"
release_manifest="$tmp_dir/manifest.json"
manifest_from_embedded=false
if [ -n "$local_archive" ]; then
  archive=$(cd "$(dirname "$local_archive")" && pwd)/$(basename "$local_archive")
  expected_hash=$(php_darwin_checksum_from_file "$archive.sha256" "$asset") || php_darwin_die 'missing local archive checksum'
  [ "$(php_darwin_sha256 "$archive")" = "$expected_hash" ] || php_darwin_die 'local archive checksum mismatch'
else
  php_darwin_read_config release-manifest.json > "$release_manifest"
  if php_darwin_use_release_manifest "$release_manifest"; then manifest_from_embedded=true; else php_darwin_refresh_release_manifest; fi
  if ! php_darwin_download_release_archive; then
    if [ "$manifest_from_embedded" = true ] && [ "$release_archive_error" = not-found ]; then
      php_darwin_refresh_release_manifest
      php_darwin_download_release_archive || php_darwin_die 'could not download the current PHP archive'
    else php_darwin_die "could not download PHP archive: $release_archive_error"; fi
  fi
fi
# Extract only the fixed controller member to stdout in a private directory.
# No archive paths are written to the host until after complete authentication.
case "$(tar --version)" in *bsdtar*) options=(-q);; *) options=(--occurrence=1);; esac
zstd -qdc "$archive" 2> "$tmp_dir/zstd.log" | tar -xOf - "${options[@]}" var/php-darwin/installer/install.sh > "$tmp_dir/install.sh"
statuses=("${PIPESTATUS[@]}")
if [ "${statuses[0]}" -eq 70 ] && grep -Eq '^zstd: error 70 : Write error : .*Broken pipe *$' "$tmp_dir/zstd.log"; then statuses[0]=141; fi
[ "${statuses[1]}" -eq 0 ] && { [ "${statuses[0]}" -eq 0 ] || [ "${statuses[0]}" -eq 141 ]; } && [ -s "$tmp_dir/install.sh" ] || php_darwin_die 'archive has no readable packaged installer'
bash -n "$tmp_dir/install.sh" || php_darwin_die 'invalid packaged installer'
PHP_DARWIN_PREFETCH_DIR="${extension_prefetch_pid:+$extension_dir}" PHP_DARWIN_PREFETCH_PID="$extension_prefetch_pid" \
  bash "$tmp_dir/install.sh" "$version" "$build" "$ts" "$archive" "$extensions_input" &
installer_pid=$!
status=0
wait "$installer_pid" || status=$?
installer_pid=
exit "$status"
