#!/usr/bin/env bash
# Use the release installer's authenticated downloader for one native-test variant.
set -euo pipefail
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$script_dir/../../.." && pwd)
. "$root/scripts/lib/lib.sh"
version=${PHP_VERSION:?}
build=${BUILD:?}
ts=${TS:?}
arch=$(php_darwin_normalize_arch "${ARCH:?}")
php_darwin_validate_version "$version"
php_darwin_validate_build "$build"
php_darwin_validate_ts "$ts"
asset=$(php_darwin_asset "$version" "$build" "$ts" "$arch")
directory=$(mktemp -d "${RUNNER_TEMP:?}/php-release-$version-$build-$ts.XXXXXX")
"${PHP_DARWIN_NODE:-node}" "$root/scripts/release/repackage-release.cjs" receipt "$version" \
  "${REPACKAGE_RECEIPT:?}" "${REPACKAGE_RECEIPT_SHA256:?}" "$directory"
release_manifest="$directory/manifest.json"
release_repository=$(php_darwin_package_config release_repository)
archive="$directory/$asset"
php_darwin_read_config() { cat "$root/conf/$1"; }
php_darwin_start_archive_hash() { actual_hash=$(php_darwin_sha256 "$1"); }
php_darwin_wait_for_archive_hash() { :; }
. "$root/scripts/installer/download.sh"
php_darwin_use_release_manifest "$release_manifest" || php_darwin_die 'selected release variant is invalid'
php_darwin_download_release_archive || php_darwin_die "could not download selected release variant: $release_archive_error"
printf '%s  %s\n' "$expected_hash" "$asset" > "$archive.sha256"
case "$(tar --version)" in *bsdtar*) options=(-q);; *) options=(--occurrence=1);; esac
set +e
zstd -qdc "$archive" 2> "$directory/zstd.log" | tar -xOf - "${options[@]}" "var/php-darwin/${asset%.tar.zst}.json" > "${archive%.tar.zst}.json"
statuses=("${PIPESTATUS[@]}")
set -e
if [ "${statuses[0]}" -eq 70 ] && grep -Eq '^zstd: error 70 : Write error : .*Broken pipe *$' "$directory/zstd.log"; then statuses[0]=141; fi
if [ "${statuses[1]}" -ne 0 ] || { [ "${statuses[0]}" -ne 0 ] && [ "${statuses[0]}" -ne 141 ]; }; then
  cat "$directory/zstd.log" >&2
  php_darwin_die 'selected archive metadata could not be extracted'
fi
PHP_DARWIN_RELEASE_MANIFEST="$release_manifest" bash "$root/scripts/installer/generate-install.sh" "$directory/install.sh"
[ "$(php_darwin_sha256 "$directory/install.sh")" = "$(jq -er .installer_sha256 "$directory/$REPACKAGE_RECEIPT")" ] || \
  php_darwin_die 'candidate installer differs from the staged installer'
{
  echo "ARCHIVE_DIR=$directory"
  echo "PHP_DARWIN_TEST_RELEASE_INSTALLER=$directory/install.sh"
} >> "${GITHUB_ENV:?}"
printf 'Downloaded only %s (%s bytes) through the release installer download path\n' "$asset" "$manifest_archive_bytes"
