#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$script_dir/../.." && pwd)
# shellcheck source=scripts/lib.sh
. "$root/scripts/lib.sh"

metadata=${1:?}
output=${2:?}
export PHP_DARWIN_BACKEND=intel
version=$(jq -er '.php_version' "$metadata") || php_darwin_die 'PHP version is missing from Intel metadata'
asset=$(jq -er '.archive' "$metadata") || php_darwin_die 'archive is missing from Intel metadata'
archive="$(dirname "$metadata")/$asset"
checksum="$archive.sha256"
[ -f "$archive" ] && [ -f "$checksum" ] || php_darwin_die 'Intel archive or checksum is missing'
php_darwin_validate_cache_metadata "$metadata" "$version" release nts x86_64 \
  /usr/local 15 >/dev/null || php_darwin_die 'Intel cache metadata is invalid'
sha256=$(php_darwin_checksum_from_file "$checksum" "$asset") || php_darwin_die 'Intel checksum is invalid'
bytes=$(wc -c < "$archive" | tr -d '[:space:]')
asset_record=$(jq -cn \
  --arg architecture x86_64 --arg build release --arg name "$asset" --arg sha256 "$sha256" \
  --arg thread_safety nts --argjson bytes "$bytes" --argjson minimum_macos 15 \
  '{architecture:$architecture,build:$build,bytes:$bytes,download:$name,minimum_macos:$minimum_macos,
    name:$name,sha256:$sha256,thread_safety:$thread_safety}') || exit 1
jq --argjson asset "$asset_record" --slurpfile metadata "$metadata" '
  .assets=[$asset] |
  .extensions_source_hash=$metadata[0].extensions_source_hash |
  .homebrew_extensions_commit=$metadata[0].homebrew_extensions_commit |
  .homebrew_php_commit=$metadata[0].homebrew_php_commit |
  .php_semver=$metadata[0].php_semver | .php_src_commit=$metadata[0].php_src_commit |
  .php_version=$metadata[0].php_version | .source_hash=$metadata[0].source_hash
' "$root/templates/release-manifest.json" > "$output" || \
  php_darwin_die 'could not create the Intel release manifest'
php_darwin_validate_release_manifest "$output" "$version" stable || \
  php_darwin_die 'Intel release manifest validation failed'
