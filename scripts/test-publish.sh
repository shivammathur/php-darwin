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
  for arch in arm64 x86_64; do
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
  done
done < "$script_dir/../conf/variants"

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
grep -Eq '^release upload php-7\.0 .*--clobber' "$gh_log" || \
  php_darwin_die 'publisher did not replace the deterministic release assets'
grep -Eq '^release upload php-7\.0 .*release/install\.sh .*--clobber' "$gh_log" || \
  php_darwin_die 'publisher did not upload the standalone installer'
grep -Eq '^release upload php-7\.0 .*\.sha256 .*--clobber' "$gh_log" || \
  php_darwin_die 'publisher did not upload archive checksum sidecars'
tail -n 1 "$gh_log" | grep -Eq '^release upload php-7\.0 .*/php-7\.0-manifest\.json --clobber --repo shivammathur/php-darwin$' || \
  php_darwin_die 'publisher did not upload the release manifest as the commit point'
jq -e --arg source_hash "$source_hash" --argjson count "$(php_darwin_expected_asset_count)" '
  .schema == 1 and .php_version == "7.0" and .php_semver == "7.0.33" and
  .php_src_commit == "" and
  .homebrew_php_commit == "0123456789abcdef0123456789abcdef01234567" and
  .source_hash == $source_hash and (.assets | length == $count) and
  ([.assets[].name] | unique | length == $count) and
  ([.assets[].architecture] | unique | sort) == ["arm64","x86_64"]
' "$gh_manifest" >/dev/null || php_darwin_die 'publisher created an invalid release manifest'
manifest_asset=$(jq -er '.assets[0].name' "$gh_manifest") || \
  php_darwin_die 'could not select a published manifest asset'
manifest_values=$(php_darwin_validate_release_manifest "$gh_manifest" "$version" stable "$manifest_asset") || \
  php_darwin_die 'published stable manifest did not pass shared validation'
IFS=$'\t' read -r manifest_hash manifest_commit manifest_php_src_commit manifest_semver manifest_source_hash \
  <<< "$manifest_values" || php_darwin_die 'could not parse the published stable manifest'
[ "$manifest_hash" = "$(php_darwin_manifest_asset_sha256 "$gh_manifest" "$manifest_asset")" ] && \
  [ "$manifest_commit" = "$source_commit" ] && [ "$manifest_php_src_commit" = - ] && \
  [ "$manifest_semver" = "$semver" ] && \
  [ "$manifest_source_hash" = "$source_hash" ] || \
  php_darwin_die 'stable manifest fields were not preserved across parsing'

legacy_manifest="$work_dir/legacy-stable-manifest.json"
jq '.php_src_commit=null' "$gh_manifest" > "$legacy_manifest" || \
  php_darwin_die 'could not create a legacy stable manifest fixture'
legacy_manifest_values=$(php_darwin_validate_release_manifest \
  "$legacy_manifest" "$version" stable "$manifest_asset") || \
  php_darwin_die 'legacy stable manifest did not pass compatibility validation'
[ "$legacy_manifest_values" = "$manifest_values" ] || \
  php_darwin_die 'legacy stable manifest fields were not normalized'

legacy_metadata="$work_dir/legacy-stable-metadata.json"
jq '.php_src_commit=null' "$metadata" > "$legacy_metadata" || \
  php_darwin_die 'could not create a legacy stable metadata fixture'
legacy_metadata_values=$(jq -er \
  '[.build,.thread_safety,.architecture,.brew_prefix,(.minimum_macos|tostring),.platform_key] | @tsv' \
  "$legacy_metadata") || php_darwin_die 'could not read legacy stable metadata fields'
IFS=$'\t' read -r legacy_build legacy_ts legacy_arch legacy_prefix legacy_minimum legacy_platform \
  <<< "$legacy_metadata_values" || php_darwin_die 'could not parse legacy stable metadata fields'
php_darwin_validate_cache_metadata "$legacy_metadata" "$version" "$legacy_build" "$legacy_ts" \
  "$legacy_arch" "$legacy_prefix" 26 "$source_commit" '' "$(php_darwin_package_config current_version)" \
  "$(php_darwin_package_config tap_snapshot)" "$legacy_minimum" "$legacy_platform" >/dev/null || \
  php_darwin_die 'legacy stable cache metadata did not pass compatibility validation'
grep -Fq '"php_version": "7.0"' "$gh_installer" || \
  php_darwin_die 'published installer did not embed the matching release manifest'

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
previous_assets="$work_dir/previous-assets"
mkdir -p "$previous_assets" || php_darwin_die 'could not create previous release fixtures'
printf 'previous archive\n' > "$previous_assets/previous.tar.zst" || \
  php_darwin_die 'could not write a previous release fixture'
: > "$gh_log" || php_darwin_die 'could not reset the publish rollback log'
if GH_RELEASE_EXISTS=true GH_PREVIOUS_ASSETS="$previous_assets" GH_FAIL_UPLOAD_MATCH='/release/php_' \
  PHP_VERSION="$version" PATH="$fake_bin:$PATH" bash "$script_dir/publish.sh" "$builds_dir" \
  >/dev/null 2>&1; then
  php_darwin_die 'publish rollback fixture unexpectedly succeeded'
fi
grep -Eq '^release download php-7\.0 --dir .* --repo shivammathur/php-darwin$' "$gh_log" || \
  php_darwin_die 'publisher did not back up the existing release assets'
tail -n 1 "$gh_log" | grep -Eq '^release upload php-7\.0 .*/previous-assets/previous\.tar\.zst --clobber --repo shivammathur/php-darwin$' || \
  php_darwin_die 'publisher did not restore the previous assets after an upload failure'
printf 'Release publish validation passed\n'
