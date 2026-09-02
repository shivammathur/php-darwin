#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-publish-test.XXXXXX") || \
  php_darwin_die 'could not create publish test fixtures'
trap 'rm -rf "$work_dir"' EXIT
builds_dir="$work_dir/builds"
fake_bin="$work_dir/bin"
formulae="$work_dir/formulae.tsv"
gh_log="$work_dir/gh.log"
gh_manifest="$work_dir/release-manifest.json"
gh_installer="$work_dir/install.sh"
version=7.0
semver=7.0.33
source_commit=0123456789abcdef0123456789abcdef01234567
mkdir -p "$builds_dir" "$fake_bin" || php_darwin_die 'could not create publish fixtures'
cp "$script_dir/../templates/publish-gh.sh" "$fake_bin/gh" || php_darwin_die 'could not copy the gh fixture'
chmod 0755 "$fake_bin/gh" || php_darwin_die 'could not make the gh fixture executable'

php_darwin_test_release_assets() {
  local asset_file
  local asset_hash
  local asset_records="$2.records"
  local assets_dir=$1
  local output=$2

  : > "$asset_records" || return 1
  for asset_file in "$assets_dir"/*; do
    [ -f "$asset_file" ] || continue
    asset_hash=$(php_darwin_sha256 "$asset_file") || return 1
    jq -cn --arg digest "sha256:$asset_hash" --arg name "${asset_file##*/}" \
      --argjson size "$(wc -c < "$asset_file" | tr -d '[:space:]')" \
      '{name:$name,digest:$digest,size:$size,state:"uploaded"}' >> "$asset_records" || return 1
  done
  jq -s '{assets:.}' "$asset_records" > "$output"
}

: > "$formulae"
variant_index=0
while read -r build ts extra; do
  [ -n "$build" ] || continue
  case "$build" in \#*) continue ;; esac
  [ -z "$extra" ] || php_darwin_die "invalid configured variant: $build $ts $extra"
  variant_index=$((variant_index + 1))
  formula=$(php_darwin_formula "$version" "$build" "$ts")
  formula_hash=$(printf '%064d' "$variant_index")
  printf '%s\t%s\n' "$formula" "$formula_hash" >> "$formulae" || \
    php_darwin_die 'could not create formula fixtures'
done < "$script_dir/../conf/variants"
LC_ALL=C sort -u "$formulae" -o "$formulae" || php_darwin_die 'could not sort formula fixtures'
source_hash=$(php_darwin_sha256 "$formulae") || php_darwin_die 'could not hash formula fixtures'

while read -r build ts extra; do
  [ -n "$build" ] || continue
  case "$build" in \#*) continue ;; esac
  [ -z "$extra" ] || php_darwin_die "invalid configured variant: $build $ts $extra"
  formula=$(php_darwin_formula "$version" "$build" "$ts")
  requested=$(php_darwin_requested_formula "$version" "$build" "$ts")
  formula_hash=$(awk -F '\t' -v formula="$formula" '$1 == formula { print $2; found=1; exit } END { exit !found }' \
    "$formulae") || php_darwin_die "could not read fixture hash for $formula"
  while IFS= read -r arch; do
    asset=$(php_darwin_asset "$version" "$build" "$ts" "$arch")
    artifact_dir="$builds_dir/$build-$ts-$arch"
    archive="$artifact_dir/$asset"
    metadata="$artifact_dir/${asset%.tar.zst}.json"
    prefix=$(jq -er --arg arch "$arch" '.[$arch].brew_prefix' "$script_dir/../conf/platforms.json") || exit 1
    minimum=$(jq -er --arg arch "$arch" '.[$arch].minimum_macos' "$script_dir/../conf/platforms.json") || exit 1
    platform=$(jq -er --arg arch "$arch" '.[$arch].platform_key' "$script_dir/../conf/platforms.json") || exit 1
    mkdir -p "$artifact_dir" || php_darwin_die 'could not create an artifact fixture directory'
    printf 'archive fixture for %s/%s/%s\n' "$build" "$ts" "$arch" > "$archive"
    archive_hash=$(php_darwin_sha256 "$archive") || php_darwin_die 'could not hash an archive fixture'
    printf '%s  %s\n' "$archive_hash" "$asset" > "$archive.sha256"
    jq --arg archive "$asset" --arg architecture "$arch" --arg brew_prefix "$prefix" \
      --arg build "$build" --arg formula "$formula" --arg formula_sha256 "$formula_hash" \
      --arg homebrew_php_commit "$source_commit" --argjson minimum_macos "$minimum" \
      --arg pear_path "$(php_darwin_pear_path "$version" "$formula")" --arg pecl_extension 20250925 \
      --arg php_semver "$semver" --arg php_src_commit '' --arg php_version "$version" --arg platform_key "$platform" \
      --arg requested_formula "$requested" --arg source_hash "$source_hash" \
      --arg config_id "$(php_darwin_config_id "$version" "$build" "$ts")" \
      --arg tap_snapshot "$(php_darwin_package_config tap_snapshot)" --arg thread_safety "$ts" '
      .archive=$archive | .architecture=$architecture | .brew_prefix=$brew_prefix | .build=$build |
      .created_at="2026-01-01T00:00:00Z" | .formula=$formula | .formula_sha256=$formula_sha256 |
      .homebrew_php_commit=$homebrew_php_commit | .macos_version="15.0" | .minimum_macos=$minimum_macos |
      .links=[{path:"bin/php",target:("../Cellar/" + $formula + "/" + $php_semver + "/bin/php")}] |
      .packages=[{name:$formula,opt_target:("../Cellar/" + $formula + "/" + $php_semver),keg_only:false}] |
      .pear_path=$pear_path | .pecl_extension=$pecl_extension | .php_semver=$php_semver |
      .php_src_commit=$php_src_commit | .php_version=$php_version | .platform_key=$platform_key |
      .requested_formula=$requested_formula |
      .runner_image="fixture" | .source_hash=$source_hash |
      .state_paths=[("etc/php/" + $config_id + "/pear.conf")] | .tap_snapshot=$tap_snapshot |
      .thread_safety=$thread_safety
    ' "$script_dir/../templates/cache-metadata.json" > "$metadata" || \
      php_darwin_die 'could not write metadata fixture'
  done < <(jq -r 'keys[]' "$script_dir/../conf/platforms.json")
done < "$script_dir/../conf/variants"

# One schema-1 stable cache may still use the legacy explicit null. Publishing
# must normalize it without accepting a missing field.
jq '.php_src_commit=null' "$metadata" > "$metadata.legacy" || \
  php_darwin_die 'could not create a legacy publisher input fixture'
mv "$metadata.legacy" "$metadata" || php_darwin_die 'could not install the legacy publisher input fixture'

export GH_LOG=$gh_log
export GH_MANIFEST=$gh_manifest
export GH_INSTALLER=$gh_installer
: > "$gh_log"
PHP_VERSION="$version" PATH="$fake_bin:$PATH" bash "$script_dir/publish.sh" "$builds_dir" >/dev/null || \
  php_darwin_die 'publish fixture validation failed'
[ "$(awk 'END { print NR+0 }' "$gh_log")" -eq 5 ] || \
  php_darwin_die 'publisher did not view, create, and upload the release in three phases'
grep -Eq '^release view php-7\.0 ' "$gh_log" || php_darwin_die 'publisher did not inspect the minor release'
grep -Eq '^release create php-7\.0 ' "$gh_log" || php_darwin_die 'publisher did not create the minor release'
grep -Eq '^release upload php-7\.0 .*\.[0-9a-f]{64}\.tar\.zst(\.sha256)?( .*\.[0-9a-f]{64}\.tar\.zst(\.sha256)?)* --repo shivammathur/php-darwin$' \
  "$gh_log" || php_darwin_die 'publisher did not upload immutable release assets'
grep -Eq '^release upload php-7\.0 .*release/install\.sh .*--clobber' "$gh_log" || \
  php_darwin_die 'publisher did not upload the standalone installer'
grep -Eq '^release upload php-7\.0 .*\.[0-9a-f]{64}\.tar\.zst\.sha256 .*--repo shivammathur/php-darwin$' \
  "$gh_log" || \
  php_darwin_die 'publisher did not upload archive checksum sidecars'
tail -n 1 "$gh_log" | grep -Eq '^release upload php-7\.0 .*/php-7\.0-manifest\.json --clobber --repo shivammathur/php-darwin$' || \
  php_darwin_die 'publisher did not upload the release manifest as the commit point'
jq -e --arg source_hash "$source_hash" --argjson count "$(php_darwin_expected_asset_count)" '
  .schema == 1 and .php_version == "7.0" and .php_semver == "7.0.33" and
  .php_src_commit == "" and
  .homebrew_php_commit == "0123456789abcdef0123456789abcdef01234567" and
  .source_hash == $source_hash and (.assets | length == $count) and
  ([.assets[].name] | unique | length == $count) and
  all(.assets[]; . as $item |
    .download == ($item.name | sub("\\.tar\\.zst$"; "." + $item.sha256 + ".tar.zst"))) and
  ([.assets[].architecture] | unique) == ["arm64"]
' "$gh_manifest" >/dev/null || php_darwin_die 'publisher created an invalid release manifest'
manifest_asset=$(jq -er '.assets[0].name' "$gh_manifest") || \
  php_darwin_die 'could not select a published manifest asset'
manifest_values=$(php_darwin_validate_release_manifest "$gh_manifest" "$version" stable "$manifest_asset") || \
  php_darwin_die 'published stable manifest did not pass shared validation'
IFS=$'\t' read -r manifest_hash manifest_commit manifest_php_src_commit manifest_semver manifest_source_hash \
  manifest_download_asset \
  <<< "$manifest_values" || php_darwin_die 'could not parse the published stable manifest'
[ "$manifest_hash" = "$(php_darwin_manifest_asset_sha256 "$gh_manifest" "$manifest_asset")" ] && \
  [ "$manifest_commit" = "$source_commit" ] && [ "$manifest_php_src_commit" = - ] && \
  [ "$manifest_semver" = "$semver" ] && \
  [ "$manifest_source_hash" = "$source_hash" ] && \
  [ "$manifest_download_asset" = "$(php_darwin_download_asset "$manifest_asset" "$manifest_hash")" ] || \
  php_darwin_die 'stable manifest fields were not preserved across parsing'

legacy_manifest="$work_dir/legacy-stable-manifest.json"
jq '.php_src_commit=null' "$gh_manifest" > "$legacy_manifest" || \
  php_darwin_die 'could not create a legacy stable manifest fixture'
legacy_manifest_values=$(php_darwin_validate_release_manifest \
  "$legacy_manifest" "$version" stable "$manifest_asset") || \
  php_darwin_die 'legacy stable manifest did not pass compatibility validation'
[ "$legacy_manifest_values" = "$manifest_values" ] || \
  php_darwin_die 'legacy stable manifest fields were not normalized'
legacy_asset_manifest="$work_dir/legacy-asset-manifest.json"
jq 'del(.assets[].download)' "$gh_manifest" > "$legacy_asset_manifest" || \
  php_darwin_die 'could not create a legacy release-asset fixture'
legacy_asset_values=$(php_darwin_validate_release_manifest \
  "$legacy_asset_manifest" "$version" stable "$manifest_asset") || \
  php_darwin_die 'legacy release asset names did not pass compatibility validation'
[ "${legacy_asset_values##*$'\t'}" = "$manifest_asset" ] || \
  php_darwin_die 'legacy release asset name was not preserved'
legacy_intel_manifest="$work_dir/legacy-intel-manifest.json"
jq --argjson minimum_macos "$(jq -er '.x86_64.minimum_macos' "$script_dir/../conf/legacy-platforms.json")" '
  .assets += [.assets[] |
    .architecture="x86_64" |
    .minimum_macos=$minimum_macos |
    .name=(.name | sub("arm64\\.tar\\.zst$"; "x86_64.tar.zst")) |
    del(.download)]
' "$legacy_asset_manifest" > "$legacy_intel_manifest" || \
  php_darwin_die 'could not create a legacy Intel manifest fixture'
legacy_intel_values=$(php_darwin_validate_release_manifest \
  "$legacy_intel_manifest" "$version" stable "$manifest_asset") || \
  php_darwin_die 'legacy eight-asset manifest did not pass compatibility validation'
[ "${legacy_intel_values##*$'\t'}" = "$manifest_asset" ] || \
  php_darwin_die 'legacy eight-asset manifest did not select the ARM64 archive'
missing_commit_manifest="$work_dir/missing-commit-stable-manifest.json"
jq 'del(.php_src_commit)' "$gh_manifest" > "$missing_commit_manifest" || \
  php_darwin_die 'could not create a missing-commit stable manifest fixture'
if php_darwin_validate_release_manifest \
  "$missing_commit_manifest" "$version" stable "$manifest_asset" >/dev/null 2>&1; then
  php_darwin_die 'stable manifest validation accepted a missing PHP source commit field'
fi

legacy_metadata="$work_dir/legacy-stable-metadata.json"
jq '.php_src_commit=null' "$metadata" > "$legacy_metadata" || \
  php_darwin_die 'could not create a legacy stable metadata fixture'
legacy_build=$(jq -er '.build' "$legacy_metadata") || php_darwin_die 'could not read the legacy build'
legacy_ts=$(jq -er '.thread_safety' "$legacy_metadata") || php_darwin_die 'could not read legacy thread safety'
legacy_arch=$(jq -er '.architecture' "$legacy_metadata") || php_darwin_die 'could not read the legacy architecture'
legacy_prefix=$(jq -er --arg arch "$legacy_arch" '.[$arch].brew_prefix' \
  "$script_dir/../conf/platforms.json") || php_darwin_die 'could not read the configured legacy prefix'
legacy_minimum=$(jq -er --arg arch "$legacy_arch" '.[$arch].minimum_macos' \
  "$script_dir/../conf/platforms.json") || php_darwin_die 'could not read the configured minimum macOS'
legacy_platform=$(jq -er --arg arch "$legacy_arch" '.[$arch].platform_key' \
  "$script_dir/../conf/platforms.json") || php_darwin_die 'could not read the configured legacy platform'
php_darwin_validate_cache_metadata "$legacy_metadata" "$version" "$legacy_build" "$legacy_ts" \
  "$legacy_arch" "$legacy_prefix" 26 "$source_commit" '' "$(php_darwin_package_config current_version)" \
  "$(php_darwin_package_config tap_snapshot)" "$legacy_minimum" "$legacy_platform" >/dev/null || \
  php_darwin_die 'legacy stable cache metadata did not pass compatibility validation'
if php_darwin_validate_cache_metadata "$legacy_metadata" "$version" "$legacy_build" "$legacy_ts" \
  "$legacy_arch" "$legacy_prefix" 26 "$source_commit" '' "$(php_darwin_package_config current_version)" \
  "$(php_darwin_package_config tap_snapshot)" "$((legacy_minimum + 1))" "$legacy_platform" \
  >/dev/null 2>&1; then
  php_darwin_die 'legacy stable cache metadata ignored the configured minimum macOS'
fi
missing_commit_metadata="$work_dir/missing-commit-stable-metadata.json"
jq 'del(.php_src_commit)' "$legacy_metadata" > "$missing_commit_metadata" || \
  php_darwin_die 'could not create a missing-commit stable metadata fixture'
if php_darwin_validate_cache_metadata "$missing_commit_metadata" "$version" "$legacy_build" "$legacy_ts" \
  "$legacy_arch" "$legacy_prefix" 26 "$source_commit" '' "$(php_darwin_package_config current_version)" \
  "$(php_darwin_package_config tap_snapshot)" "$legacy_minimum" "$legacy_platform" >/dev/null 2>&1; then
  php_darwin_die 'stable cache metadata validation accepted a missing PHP source commit field'
fi
grep -Fq '"php_version": "7.0"' "$gh_installer" || \
  php_darwin_die 'published installer did not embed the matching release manifest'
installer_download=$(jq -er '.assets[0].download' "$gh_manifest") || \
  php_darwin_die 'could not select an immutable installer asset'
grep -Fq "\"download\": \"$installer_download\"" "$gh_installer" || \
  php_darwin_die 'published installer did not embed the immutable release asset'

# A subsequent publish keeps the generation referenced by the previous
# installer, uploads a new immutable generation, and removes older immutable
# assets plus the retired mutable and Intel archive names.
previous_generation="$work_dir/previous-generation"
previous_generation_json="$work_dir/previous-generation-assets.json"
mkdir -p "$previous_generation" || php_darwin_die 'could not create immutable release fixtures'
cp "$gh_manifest" "$previous_generation/php-$version-manifest.json" || \
  php_darwin_die 'could not preserve the previous release manifest fixture'
cp "$gh_installer" "$previous_generation/install.sh" || \
  php_darwin_die 'could not preserve the previous release installer fixture'
while IFS= read -r previous_download; do
  printf 'previous immutable archive\n' > "$previous_generation/$previous_download" || exit 1
  printf 'previous immutable checksum\n' > "$previous_generation/$previous_download.sha256" || exit 1
done < <(jq -r '.assets[].download' "$gh_manifest")
stale_hash=$(printf 'f%.0s' {1..64})
stale_asset="php_7.0-nts-release+darwin_arm64.$stale_hash.tar.zst"
printf 'stale immutable archive\n' > "$previous_generation/$stale_asset" || exit 1
printf 'stale immutable checksum\n' > "$previous_generation/$stale_asset.sha256" || exit 1
plain_asset="php_7.0-nts-release+darwin_arm64.tar.zst"
intel_asset="php_7.0-nts-release+darwin_x86_64.tar.zst"
printf 'retired mutable archive\n' > "$previous_generation/$plain_asset" || exit 1
printf 'retired Intel archive\n' > "$previous_generation/$intel_asset" || exit 1
php_darwin_test_release_assets "$previous_generation" "$previous_generation_json" || \
  php_darwin_die 'could not inventory the previous release generation'
while IFS= read -r archive_fixture; do
  printf 'next generation\n' >> "$archive_fixture" || exit 1
  archive_fixture_hash=$(php_darwin_sha256 "$archive_fixture") || exit 1
  printf '%s  %s\n' "$archive_fixture_hash" "${archive_fixture##*/}" > "$archive_fixture.sha256" || exit 1
done < <(find "$builds_dir" -type f -name '*.tar.zst' -print)
: > "$gh_log" || php_darwin_die 'could not reset the immutable publish log'
GH_RELEASE_EXISTS=true GH_RELEASE_ASSETS_JSON="$previous_generation_json" \
  GH_PREVIOUS_ASSETS="$previous_generation" PHP_VERSION="$version" \
  PATH="$fake_bin:$PATH" bash "$script_dir/publish.sh" "$builds_dir" >/dev/null || \
  php_darwin_die 'immutable release replacement fixture failed'
grep -Fxq "release delete-asset php-7.0 $stale_asset --yes --repo shivammathur/php-darwin" "$gh_log" || \
  php_darwin_die 'publisher did not remove a stale immutable archive'
grep -Fxq "release delete-asset php-7.0 $stale_asset.sha256 --yes --repo shivammathur/php-darwin" "$gh_log" || \
  php_darwin_die 'publisher did not remove a stale immutable checksum'
grep -Fxq "release delete-asset php-7.0 $plain_asset --yes --repo shivammathur/php-darwin" "$gh_log" || \
  php_darwin_die 'publisher did not retire the mutable archive name'
grep -Fxq "release delete-asset php-7.0 $intel_asset --yes --repo shivammathur/php-darwin" "$gh_log" || \
  php_darwin_die 'publisher did not remove the unsupported Intel archive'
while IFS= read -r previous_download; do
  ! grep -Fq "release delete-asset php-7.0 $previous_download " "$gh_log" || \
    php_darwin_die 'publisher removed the previous installer generation'
done < <(jq -r '.assets[].download' "$previous_generation/php-$version-manifest.json")

# A malformed prior manifest cannot authorize deletion of any immutable asset.
invalid_previous_generation="$work_dir/invalid-previous-generation"
invalid_previous_json="$work_dir/invalid-previous-assets.json"
cp -R "$previous_generation" "$invalid_previous_generation" || \
  php_darwin_die 'could not create an invalid previous release fixture'
jq 'del(.homebrew_php_commit)' "$previous_generation/php-$version-manifest.json" \
  > "$invalid_previous_generation/php-$version-manifest.json" || \
  php_darwin_die 'could not invalidate the previous release manifest fixture'
php_darwin_test_release_assets "$invalid_previous_generation" "$invalid_previous_json" || \
  php_darwin_die 'could not inventory the invalid previous release fixture'
: > "$gh_log" || php_darwin_die 'could not reset the invalid-manifest publish log'
GH_RELEASE_EXISTS=true GH_RELEASE_ASSETS_JSON="$invalid_previous_json" \
  GH_PREVIOUS_ASSETS="$invalid_previous_generation" PHP_VERSION="$version" \
  PATH="$fake_bin:$PATH" bash "$script_dir/publish.sh" "$builds_dir" >/dev/null || \
  php_darwin_die 'publish with an invalid previous manifest fixture failed'
! grep -Fq "release delete-asset php-7.0 $stale_asset " "$gh_log" || \
  php_darwin_die 'publisher deleted immutable assets using an invalid previous manifest'

# A complete generation is idempotent and needs no archive upload.
current_generation="$work_dir/current-generation"
current_generation_json="$work_dir/current-generation-assets.json"
mkdir -p "$current_generation" || php_darwin_die 'could not create the current generation fixture'
cp "$gh_manifest" "$current_generation/php-$version-manifest.json" || exit 1
cp "$gh_installer" "$current_generation/install.sh" || exit 1
while IFS= read -r archive_fixture; do
  logical_name=${archive_fixture##*/}
  archive_fixture_hash=$(php_darwin_sha256 "$archive_fixture") || exit 1
  immutable_name=$(php_darwin_download_asset "$logical_name" "$archive_fixture_hash") || exit 1
  cp "$archive_fixture" "$current_generation/$immutable_name" || exit 1
  printf '%s  %s\n' "$archive_fixture_hash" "$immutable_name" \
    > "$current_generation/$immutable_name.sha256" || exit 1
done < <(find "$builds_dir" -type f -name '*.tar.zst' -print)
php_darwin_test_release_assets "$current_generation" "$current_generation_json" || \
  php_darwin_die 'could not inventory the current release generation'
: > "$gh_log" || php_darwin_die 'could not reset the idempotent publish log'
GH_RELEASE_EXISTS=true GH_RELEASE_ASSETS_JSON="$current_generation_json" \
  GH_PREVIOUS_ASSETS="$current_generation" PHP_VERSION="$version" PATH="$fake_bin:$PATH" \
  bash "$script_dir/publish.sh" "$builds_dir" >/dev/null || \
  php_darwin_die 'idempotent release publish fixture failed'
! grep -Eq '^release upload php-7\.0 .*\.[0-9a-f]{64}\.tar\.zst' "$gh_log" || \
  php_darwin_die 'idempotent publisher re-uploaded immutable release assets'

# A corrupt partial immutable asset is deleted and repaired on retry.
ghost_assets_json="$work_dir/ghost-assets.json"
ghost_asset=$(jq -er '.assets[0].download' "$gh_manifest") || exit 1
jq --arg name "$ghost_asset" --arg digest "sha256:$(printf '0%.0s' {1..64})" '
  .assets |= map(if .name == $name then .digest=$digest else . end)
' "$current_generation_json" > "$ghost_assets_json" || exit 1
: > "$gh_log" || php_darwin_die 'could not reset the ghost-asset publish log'
GH_RELEASE_EXISTS=true GH_RELEASE_ASSETS_JSON="$ghost_assets_json" \
  GH_PREVIOUS_ASSETS="$current_generation" PHP_VERSION="$version" PATH="$fake_bin:$PATH" \
  bash "$script_dir/publish.sh" "$builds_dir" >/dev/null || \
  php_darwin_die 'partial immutable release retry fixture failed'
grep -Fxq "release delete-asset php-7.0 $ghost_asset --yes --repo shivammathur/php-darwin" "$gh_log" || \
  php_darwin_die 'publisher did not remove the corrupt immutable asset'
grep -F 'release upload php-7.0 ' "$gh_log" | \
  grep -Fq "/$ghost_asset --repo shivammathur/php-darwin" || \
  php_darwin_die 'publisher did not repair the corrupt immutable asset'

# An existing release with zero assets is recoverable without a backup download.
empty_release="$work_dir/empty-release"
empty_assets_json="$work_dir/empty-assets.json"
mkdir -p "$empty_release" || exit 1
printf '{"assets":[]}\n' > "$empty_assets_json" || exit 1
: > "$gh_log" || php_darwin_die 'could not reset the empty-release publish log'
GH_RELEASE_EXISTS=true GH_RELEASE_ASSETS_JSON="$empty_assets_json" \
  GH_PREVIOUS_ASSETS="$empty_release" PHP_VERSION="$version" PATH="$fake_bin:$PATH" \
  bash "$script_dir/publish.sh" "$builds_dir" >/dev/null || \
  php_darwin_die 'empty release recovery fixture failed'
! grep -Fq 'release download ' "$gh_log" || \
  php_darwin_die 'publisher tried to download assets from an empty release'

# Garbage-collection failure after the manifest commit cannot roll back it.
postcommit_generation="$work_dir/postcommit-generation"
postcommit_assets_json="$work_dir/postcommit-assets.json"
cp -R "$current_generation" "$postcommit_generation" || exit 1
printf 'postcommit stale archive\n' > "$postcommit_generation/$stale_asset" || exit 1
php_darwin_test_release_assets "$postcommit_generation" "$postcommit_assets_json" || exit 1
: > "$gh_log" || php_darwin_die 'could not reset the postcommit publish log'
GH_RELEASE_EXISTS=true GH_RELEASE_ASSETS_JSON="$postcommit_assets_json" \
  GH_PREVIOUS_ASSETS="$postcommit_generation" GH_FAIL_DELETE_MATCH="$stale_asset" \
  PHP_VERSION="$version" PATH="$fake_bin:$PATH" bash "$script_dir/publish.sh" "$builds_dir" \
  >/dev/null || php_darwin_die 'postcommit cleanup failure rolled back the release'
! grep -Eq '^release upload php-7\.0 .*/previous-assets/' "$gh_log" || \
  php_darwin_die 'postcommit cleanup failure restored the previous release'

if PHP_VERSION=7.1 HOMEBREW_PHP_COMMIT="$source_commit" PATH="$fake_bin:$PATH" \
  bash "$script_dir/publish.sh" "$builds_dir" >/dev/null 2>&1; then
  php_darwin_die 'publish validation accepted a different requested PHP version'
fi

checksum_fixture=$(find "$builds_dir" -type f -name '*.sha256' -print -quit)
[ -f "$checksum_fixture" ] || php_darwin_die 'publish checksum fixture is missing'
mv "$checksum_fixture" "$checksum_fixture.missing" || php_darwin_die 'could not hide the checksum fixture'
if HOMEBREW_PHP_COMMIT="$source_commit" PATH="$fake_bin:$PATH" \
  bash "$script_dir/publish.sh" "$builds_dir" >/dev/null 2>&1; then
  php_darwin_die 'publish validation accepted an archive without a checksum'
fi

mv "$checksum_fixture.missing" "$checksum_fixture" || \
  php_darwin_die 'could not restore the checksum fixture'

# A broken mutable backup download does not wedge replacement.
: > "$gh_log" || php_darwin_die 'could not reset the backup recovery log'
GH_RELEASE_EXISTS=true GH_RELEASE_ASSETS_JSON="$current_generation_json" \
  GH_PREVIOUS_ASSETS="$current_generation" GH_FAIL_DOWNLOAD_MATCH=install.sh \
  PHP_VERSION="$version" PATH="$fake_bin:$PATH" bash "$script_dir/publish.sh" "$builds_dir" \
  >/dev/null 2>&1 || php_darwin_die 'publisher did not recover from a broken mutable backup'

# A failure at the manifest commit point restores the previous mutable files.
upload_once_marker="$work_dir/upload-once.marker"
: > "$gh_log" || php_darwin_die 'could not reset the publish rollback log'
if GH_RELEASE_EXISTS=true GH_RELEASE_ASSETS_JSON="$current_generation_json" \
  GH_PREVIOUS_ASSETS="$current_generation" GH_FAIL_UPLOAD_ONCE_MATCH='php-7.0-manifest.json' \
  GH_FAIL_UPLOAD_ONCE_MARKER="$upload_once_marker" \
  PHP_VERSION="$version" PATH="$fake_bin:$PATH" bash "$script_dir/publish.sh" "$builds_dir" \
  >/dev/null 2>&1; then
  php_darwin_die 'publish rollback fixture unexpectedly succeeded'
fi
grep -Eq '^release download php-7\.0 --pattern install\.sh --dir .* --repo shivammathur/php-darwin$' \
  "$gh_log" || php_darwin_die 'publisher did not back up the existing installer'
grep -Eq '^release download php-7\.0 --pattern php-7\.0-manifest\.json --dir .* --repo shivammathur/php-darwin$' \
  "$gh_log" || php_darwin_die 'publisher did not back up the existing manifest'
tail -n 1 "$gh_log" | grep -Eq \
  '^release upload php-7\.0 .*/previous-assets/(install\.sh|php-7\.0-manifest\.json) .*/previous-assets/(install\.sh|php-7\.0-manifest\.json) --clobber --repo shivammathur/php-darwin$' || \
  php_darwin_die 'publisher did not restore the previous mutable assets after an upload failure'
printf 'Release publish validation passed\n'
