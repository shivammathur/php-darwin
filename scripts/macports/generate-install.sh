#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/macports/lib.sh
. "$script_dir/lib.sh"

metadata=${1:?}
output=${2:?}
template="$php_darwin_macports_root/templates/macports/install.sh"
version=$(jq -er '.php_version' "$metadata") || php_darwin_macports_die 'PHP version is missing from metadata'
semver=$(jq -er '.php_semver' "$metadata") || php_darwin_macports_die 'PHP semantic version is missing from metadata'
build=$(jq -er '.build' "$metadata") || php_darwin_macports_die 'build type is missing from metadata'
ts=$(jq -er '.thread_safety' "$metadata") || php_darwin_macports_die 'thread safety is missing from metadata'
prefix=$(jq -er '.prefix' "$metadata") || php_darwin_macports_die 'prefix is missing from metadata'
archive=$(jq -er '.archive' "$metadata") || php_darwin_macports_die 'archive is missing from metadata'
sha256=$(jq -er '.sha256' "$metadata") || php_darwin_macports_die 'archive checksum is missing from metadata'
bytes=$(jq -er '.bytes' "$metadata") || php_darwin_macports_die 'archive size is missing from metadata'
minimum_macos=$(jq -er '.minimum_macos' "$metadata") || php_darwin_macports_die 'minimum macOS is missing from metadata'
release_tag=$(php_darwin_macports_release_tag "$version") || exit 1
release_url="https://github.com/shivammathur/php-darwin/releases/download/$release_tag"
staged=$(mktemp "${RUNNER_TEMP:-/tmp}/php-darwin-macports-install.XXXXXX") || \
  php_darwin_macports_die 'could not create the installer staging file'
trap 'rm -f "$staged"' EXIT

for value in "$version" "$semver" "$build" "$ts" "$prefix" "$archive" "$sha256" "$bytes" "$minimum_macos" "$release_url"; do
  case "$value" in *"'"*|*$'\n'*) php_darwin_macports_die 'installer metadata contains unsafe text' ;; esac
done

sed \
  -e "s|__PHP_VERSION__|$version|g" \
  -e "s|__PHP_SEMVER__|$semver|g" \
  -e "s|__BUILD__|$build|g" \
  -e "s|__TS__|$ts|g" \
  -e "s|__PREFIX__|$prefix|g" \
  -e "s|__ARCHIVE__|$archive|g" \
  -e "s|__SHA256__|$sha256|g" \
  -e "s|__BYTES__|$bytes|g" \
  -e "s|__MINIMUM_MACOS__|$minimum_macos|g" \
  -e "s|__RELEASE_URL__|$release_url|g" \
  "$template" > "$staged" || php_darwin_macports_die 'could not generate the standalone installer'
grep -Eq '__[A-Z_]+__|base64|githubusercontent' "$staged" && \
  php_darwin_macports_die 'the standalone installer contains an unresolved or disallowed payload'
bash -n "$staged" || php_darwin_macports_die 'the standalone installer has invalid shell syntax'
chmod 0755 "$staged" || php_darwin_macports_die 'could not make the installer executable'
mkdir -p "${output%/*}" || php_darwin_macports_die 'could not create the installer output directory'
mv "$staged" "$output" || php_darwin_macports_die 'could not save the standalone installer'
trap - EXIT
