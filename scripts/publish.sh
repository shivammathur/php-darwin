#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

builds_dir=${1:?}
expected_version=${PHP_VERSION:-}
source_commit=${HOMEBREW_PHP_COMMIT:-}
release_repository=$(php_darwin_package_config release_repository)
tap_snapshot=$(php_darwin_package_config tap_snapshot)
work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-publish.XXXXXX") || \
  php_darwin_die 'could not create the release staging directory'
trap 'rm -rf "$work_dir"' EXIT
metadata_unsorted="$work_dir/metadata-unsorted.txt"
metadata_list="$work_dir/metadata.txt"
matrix_keys="$work_dir/matrix-keys.txt"
formulae="$work_dir/formulae.tsv"
source_hashes="$work_dir/source-hashes.txt"
semvers="$work_dir/semvers.txt"
assets_jsonl="$work_dir/assets.jsonl"
staging="$work_dir/release"

[ -z "$expected_version" ] || php_darwin_validate_version "$expected_version"
[[ "$release_repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || \
  php_darwin_die "invalid release repository: $release_repository"
mkdir -p "$staging" || php_darwin_die 'could not create the release staging directory'
find "$builds_dir" -type f -name 'php_*.json' -print > "$metadata_unsorted" || \
  php_darwin_die 'could not locate cache metadata'
LC_ALL=C sort "$metadata_unsorted" > "$metadata_list" || php_darwin_die 'could not sort cache metadata'
[ -s "$metadata_list" ] || php_darwin_die 'no cache metadata found'
if [ -z "$source_commit" ]; then
  IFS= read -r first_metadata < "$metadata_list"
  source_commit=$(jq -er '.homebrew_php_commit' "$first_metadata") || \
    php_darwin_die 'could not derive the pinned homebrew-php source commit'
fi
[[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || php_darwin_die 'invalid pinned homebrew-php source commit'
: > "$matrix_keys"
: > "$formulae"
: > "$source_hashes"
: > "$semvers"
: > "$assets_jsonl"

version=
upload_files=()
while IFS= read -r metadata; do
  metadata_version=$(jq -er '.php_version' "$metadata") || php_darwin_die "PHP version is missing in $metadata"
  [ -z "$expected_version" ] || [ "$metadata_version" = "$expected_version" ] || \
    php_darwin_die "metadata PHP version is $metadata_version; expected $expected_version"
  [ -n "$version" ] || version=$metadata_version
  [ "$metadata_version" = "$version" ] || php_darwin_die 'publish input contains multiple PHP minor versions'
  metadata_build=$(jq -er '.build' "$metadata") || php_darwin_die "build type is missing in $metadata"
  metadata_ts=$(jq -er '.thread_safety' "$metadata") || php_darwin_die "thread safety is missing in $metadata"
  metadata_arch=$(jq -er '.architecture' "$metadata") || php_darwin_die "architecture is missing in $metadata"
  php_darwin_validate_build "$metadata_build"
  php_darwin_validate_ts "$metadata_ts"
  metadata_arch=$(php_darwin_normalize_arch "$metadata_arch")
  expected_archive=$(php_darwin_asset "$version" "$metadata_build" "$metadata_ts" "$metadata_arch")
  expected_formula=$(php_darwin_formula "$version" "$metadata_build" "$metadata_ts")
  expected_requested=$(php_darwin_requested_formula "$version" "$metadata_build" "$metadata_ts")
  expected_pear_path=$(php_darwin_pear_path "$version" "$expected_formula")
  expected_prefix=$(jq -er --arg arch "$metadata_arch" '.[$arch].brew_prefix' \
    "$script_dir/../conf/platforms.json") || php_darwin_die "brew prefix is not configured for $metadata_arch"
  expected_minimum=$(jq -er --arg arch "$metadata_arch" '.[$arch].minimum_macos' \
    "$script_dir/../conf/platforms.json") || php_darwin_die "minimum macOS is not configured for $metadata_arch"
  expected_platform=$(jq -er --arg arch "$metadata_arch" '.[$arch].platform_key' \
    "$script_dir/../conf/platforms.json") || php_darwin_die "platform key is not configured for $metadata_arch"

  jq -e --arg archive "$expected_archive" --arg arch "$metadata_arch" --arg build "$metadata_build" \
    --arg commit "$source_commit" --arg formula "$expected_formula" --arg php "$version" \
    --arg pear_path "$expected_pear_path" --arg platform "$expected_platform" --arg prefix "$expected_prefix" \
    --arg requested "$expected_requested" \
    --arg tap_snapshot "$tap_snapshot" --arg ts "$metadata_ts" --argjson minimum "$expected_minimum" '
    .schema == 1 and .archive == $archive and .architecture == $arch and .brew_prefix == $prefix and
    .build == $build and .formula == $formula and .homebrew_php_commit == $commit and
    .minimum_macos == $minimum and .php_version == $php and .platform_key == $platform and
    .requested_formula == $requested and .tap_snapshot == $tap_snapshot and .thread_safety == $ts and
    (.formula_sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.source_hash | type == "string" and test("^[0-9a-f]{64}$")) and
    (.php_semver | type == "string" and startswith($php + ".") and test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) and
    (.links | type == "array" and length > 0) and
    ([.links[].path] | unique | length) == (.links | length) and
    all(.links[];
      (.path | type == "string" and test("^(Frameworks|bin|etc|include|lib|sbin|share|var/homebrew/linked)/") and
        (test("(^|/)\\.\\.(/|$)") | not) and test("^[^\\r\\n\\t]+$")) and
      (.target | type == "string" and test("^[^\\r\\n\\t]+$"))) and
    (.state_paths | type == "array" and length > 0) and
    all(.state_paths[]; type == "string" and test("^(etc|var)/") and
      (test("(^|/)\\.\\.(/|$)") | not) and test("^[^\\r\\n\\t]+$")) and
    (.packages | type == "array" and length > 0) and
    .pear_path == $pear_path and
    (.pecl_extension | type == "string" and test("^[A-Za-z0-9._-]+$")) and
    any(.packages[]; .name == $formula) and
    all(.packages[];
      (.name | type == "string" and test("^[A-Za-z0-9@+._-]+$")) and
      (.keg_only | type == "boolean") and
      (.name as $name | .opt_target | split("/") |
        length == 4 and .[0] == ".." and .[1] == "Cellar" and .[2] == $name and
        (.[3] | type == "string" and test("^[^\\r\\n\\t/]+$") and . != "." and . != "..")))
  ' "$metadata" >/dev/null || php_darwin_die "metadata validation failed: $metadata"
  [ "$(basename "$metadata")" = "${expected_archive%.tar.zst}.json" ] || \
    php_darwin_die "metadata filename does not match its archive: $metadata"

  archive_matches="$work_dir/archive-matches.txt"
  find "$builds_dir" -type f -name "$expected_archive" -print > "$archive_matches" || \
    php_darwin_die "could not locate $expected_archive"
  [ "$(awk 'END { print NR+0 }' "$archive_matches")" -eq 1 ] || \
    php_darwin_die "expected exactly one archive named $expected_archive"
  IFS= read -r archive < "$archive_matches"
  checksum="$archive.sha256"
  [ -f "$checksum" ] || php_darwin_die "checksum not found: $checksum"
  expected_hash=$(awk -v name="$expected_archive" '$2 == name { print $1; found=1; exit } END { exit !found }' \
    "$checksum") || php_darwin_die "checksum record not found for $expected_archive"
  [[ "$expected_hash" =~ ^[0-9a-f]{64}$ ]] || php_darwin_die "invalid checksum for $expected_archive"
  actual_hash=$(php_darwin_sha256 "$archive") || php_darwin_die "could not hash $expected_archive"
  [ "$actual_hash" = "$expected_hash" ] || php_darwin_die "checksum mismatch before publish: $expected_archive"
  archive_bytes=$(wc -c < "$archive" | tr -d '[:space:]')
  [[ "$archive_bytes" =~ ^[0-9]+$ ]] || php_darwin_die "invalid archive size for $expected_archive"
  cp "$archive" "$staging/$expected_archive" || php_darwin_die "could not stage $expected_archive"
  upload_files+=("$staging/$expected_archive")

  printf '%s/%s/%s\n' "$metadata_build" "$metadata_ts" "$metadata_arch" >> "$matrix_keys"
  jq -r '[.formula,.formula_sha256] | @tsv' "$metadata" >> "$formulae" || \
    php_darwin_die "could not read formula metadata from $metadata"
  jq -er '.source_hash' "$metadata" >> "$source_hashes" || php_darwin_die "could not read source hash from $metadata"
  jq -er '.php_semver' "$metadata" >> "$semvers" || php_darwin_die "could not read PHP version from $metadata"
  jq -cn --arg architecture "$metadata_arch" --arg build "$metadata_build" --arg name "$expected_archive" \
    --arg sha256 "$actual_hash" --arg thread_safety "$metadata_ts" --argjson bytes "$archive_bytes" \
    --argjson minimum_macos "$expected_minimum" \
    '{architecture:$architecture,build:$build,bytes:$bytes,minimum_macos:$minimum_macos,name:$name,
      sha256:$sha256,thread_safety:$thread_safety}' >> "$assets_jsonl" || \
    php_darwin_die "could not create the release record for $expected_archive"
done < "$metadata_list"

variant_count=$(awk '!/^#/ && NF == 2 { count++ } END { print count+0 }' "$script_dir/../conf/variants")
platform_count=$(jq 'keys | length' "$script_dir/../conf/platforms.json") || \
  php_darwin_die 'could not read the configured platform count'
expected_count=$((variant_count * platform_count))
metadata_count=$(awk 'END { print NR+0 }' "$metadata_list")
[ "$metadata_count" -eq "$expected_count" ] || \
  php_darwin_die "incomplete publish matrix; expected $expected_count metadata files, found $metadata_count"
LC_ALL=C sort -u "$matrix_keys" -o "$matrix_keys" || php_darwin_die 'could not sort publish matrix keys'
[ "$(awk 'END { print NR+0 }' "$matrix_keys")" -eq "$expected_count" ] || \
  php_darwin_die 'publish matrix contains duplicate or missing build keys'
LC_ALL=C sort -u "$formulae" -o "$formulae" || php_darwin_die 'could not sort formula hashes'
[ "$(awk 'END { print NR+0 }' "$formulae")" -eq "$variant_count" ] || \
  php_darwin_die "expected $variant_count unique formula source hashes"
computed_source_hash=$(php_darwin_sha256 "$formulae") || php_darwin_die 'could not hash formula metadata'
LC_ALL=C sort -u "$source_hashes" -o "$source_hashes" || php_darwin_die 'could not sort source hashes'
[ "$(awk 'END { print NR+0 }' "$source_hashes")" -eq 1 ] || \
  php_darwin_die 'build variants disagree on the formula source hash'
IFS= read -r source_hash < "$source_hashes"
[ "$source_hash" = "$computed_source_hash" ] || php_darwin_die 'formula source hash does not match the metadata'
LC_ALL=C sort -u "$semvers" -o "$semvers" || php_darwin_die 'could not sort PHP semantic versions'
[ "$(awk 'END { print NR+0 }' "$semvers")" -eq 1 ] || \
  php_darwin_die 'build variants disagree on the PHP semantic version'
IFS= read -r semver < "$semvers"

tag="php-$version"
manifest="$staging/$tag-manifest.json"
jq --slurpfile assets "$assets_jsonl" --arg commit "$source_commit" --arg php_semver "$semver" \
  --arg php_version "$version" --arg source_hash "$source_hash" '
  .assets=($assets | sort_by(.build,.thread_safety,.architecture)) |
  .homebrew_php_commit=$commit | .php_semver=$php_semver | .php_version=$php_version |
  .source_hash=$source_hash
' "$script_dir/../templates/release-manifest.json" > "$manifest" || \
  php_darwin_die 'could not create the release manifest'
jq -e --arg commit "$source_commit" --arg php_semver "$semver" --arg php_version "$version" \
  --arg source_hash "$source_hash" --argjson count "$expected_count" '
  .schema == 1 and .homebrew_php_commit == $commit and .php_semver == $php_semver and
  .php_version == $php_version and .source_hash == $source_hash and (.assets | length == $count)
' "$manifest" >/dev/null || php_darwin_die 'release manifest validation failed'
upload_files+=("$manifest")

if ! gh release view "$tag" --repo "$release_repository" >/dev/null 2>&1; then
  gh release create "$tag" --repo "$release_repository" --title "PHP $version" \
    --notes "Architecture-specific Homebrew PHP $version caches for macOS runners." --latest=false || \
    php_darwin_die "could not create release $tag"
fi
gh release upload "$tag" "${upload_files[@]}" --clobber --repo "$release_repository" || \
  php_darwin_die "could not upload release assets to $tag"
printf 'Published PHP %s release assets with source hash %s\n' "$version" "$source_hash"
