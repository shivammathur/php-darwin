#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

builds_dir=${1:?}
expected_version=${PHP_VERSION:-}
source_commit=${HOMEBREW_PHP_COMMIT:-}
release_repository=$(php_darwin_package_config release_repository)
work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-publish.XXXXXX") || \
  php_darwin_die 'could not create the release staging directory'
release_exists=false
publish_mutation_started=false
previous_assets="$work_dir/previous-assets"
publish_cleanup() {
  local cleanup_status=$?
  local previous_asset
  local previous_asset_files=()

  trap - EXIT
  if [ "$cleanup_status" -ne 0 ] && [ "$publish_mutation_started" = true ] && \
    [ "$release_exists" = true ] && [ -d "$previous_assets" ]; then
    while IFS= read -r -d '' previous_asset; do
      previous_asset_files+=("$previous_asset")
    done < <(find "$previous_assets" -type f -print0)
    if [ "${#previous_asset_files[@]}" -gt 0 ]; then
      printf 'Restoring the previous %s release assets after a failed publish\n' "$tag" >&2
      gh release upload "$tag" "${previous_asset_files[@]}" --clobber \
        --repo "$release_repository" >/dev/null 2>&1 || \
        printf 'Could not fully restore the previous %s release assets\n' "$tag" >&2
    fi
  elif [ "$cleanup_status" -ne 0 ] && [ "$publish_mutation_started" = true ] && \
    [ "$release_exists" = false ]; then
    gh release delete "$tag" --cleanup-tag --yes --repo "$release_repository" >/dev/null 2>&1 || \
      printf 'Could not remove the incomplete %s release\n' "$tag" >&2
  fi
  rm -rf "$work_dir"
  exit "$cleanup_status"
}
trap publish_cleanup EXIT
metadata_unsorted="$work_dir/metadata-unsorted.txt"
metadata_list="$work_dir/metadata.txt"
matrix_keys="$work_dir/matrix-keys.txt"
formulae="$work_dir/formulae.tsv"
source_hashes="$work_dir/source-hashes.txt"
semvers="$work_dir/semvers.txt"
php_src_commits="$work_dir/php-src-commits.txt"
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
: > "$php_src_commits"
: > "$assets_jsonl"

version=
data_upload_files=()
while IFS= read -r metadata; do
  metadata_version=$(jq -er '.php_version' "$metadata") || php_darwin_die "PHP version is missing in $metadata"
  [ -z "$expected_version" ] || [ "$metadata_version" = "$expected_version" ] || \
    php_darwin_die "metadata PHP version is $metadata_version; expected $expected_version"
  [ -n "$version" ] || version=$metadata_version
  [ "$metadata_version" = "$version" ] || php_darwin_die 'publish input contains multiple PHP minor versions'
  channel=$(php_darwin_version_channel "$version")
  metadata_php_src_commit=$(jq -er '.php_src_commit | select(type == "string")' "$metadata") || \
    php_darwin_die "PHP source commit is missing in $metadata"
  case "$channel" in
    nightly) [[ "$metadata_php_src_commit" =~ ^[0-9a-f]{40}$ ]] || \
      php_darwin_die "nightly PHP source commit is invalid in $metadata" ;;
    stable) [ -z "$metadata_php_src_commit" ] || \
      php_darwin_die "stable PHP source commit must be empty in $metadata" ;;
  esac
  metadata_build=$(jq -er '.build' "$metadata") || php_darwin_die "build type is missing in $metadata"
  metadata_ts=$(jq -er '.thread_safety' "$metadata") || php_darwin_die "thread safety is missing in $metadata"
  metadata_arch=$(jq -er '.architecture' "$metadata") || php_darwin_die "architecture is missing in $metadata"
  php_darwin_validate_build "$metadata_build"
  php_darwin_validate_ts "$metadata_ts"
  metadata_arch=$(php_darwin_normalize_arch "$metadata_arch")
  expected_archive=$(php_darwin_asset "$version" "$metadata_build" "$metadata_ts" "$metadata_arch")
  expected_prefix=$(jq -er --arg arch "$metadata_arch" '.[$arch].brew_prefix' \
    "$script_dir/../conf/platforms.json") || php_darwin_die "brew prefix is not configured for $metadata_arch"
  expected_minimum=$(jq -er --arg arch "$metadata_arch" '.[$arch].minimum_macos' \
    "$script_dir/../conf/platforms.json") || php_darwin_die "minimum macOS is not configured for $metadata_arch"

  php_darwin_validate_cache_metadata "$metadata" "$version" "$metadata_build" "$metadata_ts" \
    "$metadata_arch" "$expected_prefix" "$expected_minimum" "$source_commit" \
    "$metadata_php_src_commit" >/dev/null || php_darwin_die "metadata validation failed: $metadata"
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
  expected_hash=$(php_darwin_checksum_from_file "$checksum" "$expected_archive") || \
    php_darwin_die "checksum record not found for $expected_archive"
  actual_hash=$(php_darwin_sha256 "$archive") || php_darwin_die "could not hash $expected_archive"
  [ "$actual_hash" = "$expected_hash" ] || php_darwin_die "checksum mismatch before publish: $expected_archive"
  archive_bytes=$(wc -c < "$archive" | tr -d '[:space:]')
  [[ "$archive_bytes" =~ ^[0-9]+$ ]] || php_darwin_die "invalid archive size for $expected_archive"
  cp "$archive" "$staging/$expected_archive" || php_darwin_die "could not stage $expected_archive"
  cp "$checksum" "$staging/$expected_archive.sha256" || \
    php_darwin_die "could not stage the checksum for $expected_archive"
  data_upload_files+=("$staging/$expected_archive" "$staging/$expected_archive.sha256")

  printf '%s/%s/%s\n' "$metadata_build" "$metadata_ts" "$metadata_arch" >> "$matrix_keys"
  jq -r '[.formula,.formula_sha256] | @tsv' "$metadata" >> "$formulae" || \
    php_darwin_die "could not read formula metadata from $metadata"
  jq -er '.source_hash' "$metadata" >> "$source_hashes" || php_darwin_die "could not read source hash from $metadata"
  jq -er '.php_semver' "$metadata" >> "$semvers" || php_darwin_die "could not read PHP version from $metadata"
  printf '%s\n' "$metadata_php_src_commit" >> "$php_src_commits" || \
    php_darwin_die "could not read the PHP source commit from $metadata"
  jq -cn --arg architecture "$metadata_arch" --arg build "$metadata_build" --arg name "$expected_archive" \
    --arg sha256 "$actual_hash" --arg thread_safety "$metadata_ts" --argjson bytes "$archive_bytes" \
    --argjson minimum_macos "$expected_minimum" \
    '{architecture:$architecture,build:$build,bytes:$bytes,minimum_macos:$minimum_macos,name:$name,
      sha256:$sha256,thread_safety:$thread_safety}' >> "$assets_jsonl" || \
    php_darwin_die "could not create the release record for $expected_archive"
done < "$metadata_list"

variant_count=$(awk '!/^#/ && NF == 2 { count++ } END { print count+0 }' "$script_dir/../conf/variants")
expected_count=$(php_darwin_expected_asset_count)
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
LC_ALL=C sort -u "$php_src_commits" -o "$php_src_commits" || \
  php_darwin_die 'could not sort PHP source commits'
[ "$(awk 'END { print NR+0 }' "$php_src_commits")" -eq 1 ] || \
  php_darwin_die 'build variants disagree on the PHP source commit'
IFS= read -r php_src_commit < "$php_src_commits" || php_src_commit=
case "$channel" in
  nightly) [[ "$php_src_commit" =~ ^[0-9a-f]{40}$ ]] || php_darwin_die 'nightly PHP source commit is invalid' ;;
  stable) [ -z "$php_src_commit" ] || php_darwin_die 'stable PHP source commit must be empty' ;;
esac

tag="php-$version"
manifest="$staging/$tag-manifest.json"
installer="$staging/install.sh"
jq --slurpfile assets "$assets_jsonl" --arg commit "$source_commit" --arg php_semver "$semver" \
  --arg php_src_commit "$php_src_commit" --arg php_version "$version" --arg source_hash "$source_hash" '
  .assets=($assets | sort_by(.build,.thread_safety,.architecture)) |
  .homebrew_php_commit=$commit | .php_semver=$php_semver | .php_src_commit=$php_src_commit |
  .php_version=$php_version |
  .source_hash=$source_hash
' "$script_dir/../templates/release-manifest.json" > "$manifest" || \
  php_darwin_die 'could not create the release manifest'
php_darwin_validate_release_manifest "$manifest" "$version" "$channel" || \
  php_darwin_die 'release manifest validation failed'
bash "$script_dir/validate-install.sh" >/dev/null || \
  php_darwin_die 'standalone installer validation failed before publish'
PHP_DARWIN_RELEASE_MANIFEST="$manifest" bash "$script_dir/generate-install.sh" "$installer" >/dev/null || \
  php_darwin_die 'could not generate the release-specific standalone installer'

if gh release view "$tag" --repo "$release_repository" >/dev/null 2>&1; then
  release_exists=true
  mkdir -p "$previous_assets" || php_darwin_die 'could not create the release backup directory'
  gh release download "$tag" --dir "$previous_assets" --repo "$release_repository" || \
    php_darwin_die "could not back up existing release assets from $tag"
else
  gh release create "$tag" --repo "$release_repository" --title "PHP $version" \
    --notes "Architecture-specific Homebrew PHP $version caches for macOS runners." --latest=false || \
    php_darwin_die "could not create release $tag"
fi
publish_mutation_started=true
gh release upload "$tag" "${data_upload_files[@]}" --clobber --repo "$release_repository" || \
  php_darwin_die "could not upload release archives to $tag"
gh release upload "$tag" "$installer" --clobber --repo "$release_repository" || \
  php_darwin_die "could not upload the release installer to $tag"
# The manifest is the release commit point. Upload it only after every archive,
# checksum, and the matching embedded-manifest installer is available.
gh release upload "$tag" "$manifest" --clobber --repo "$release_repository" || \
  php_darwin_die "could not commit release assets for $tag"
printf 'Published PHP %s release assets with source hash %s\n' "$version" "$source_hash"
