#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

bash -n "$script_dir"/*.sh "$script_dir"/../templates/*.sh || php_darwin_die 'shell syntax validation failed'
bash "$script_dir/test-job-control.sh" || php_darwin_die 'bounded job cleanup validation failed'
bash "$script_dir/test-publish-run.sh" || php_darwin_die 'publish workflow-run validation failed'

for json_file in "$script_dir"/../conf/*.json "$script_dir"/../templates/*.json; do
  jq -e . "$json_file" >/dev/null || php_darwin_die "invalid JSON: $json_file"
done

current_version=$(php_darwin_package_config current_version)
php_darwin_validate_channel "$current_version" stable
php_darwin_validate_channel 5.6 stable
php_darwin_validate_channel 8.5 stable
php_darwin_validate_channel 8.6 nightly
php_darwin_validate_php_semver 8.6 8.6.0beta2 || \
  php_darwin_die 'nightly prerelease PHP version validation failed'
php_darwin_validate_php_semver 8.6 8.6.0RC1 || \
  php_darwin_die 'nightly release-candidate PHP version validation failed'
if php_darwin_validate_php_semver 8.6 8.6.beta2; then
  php_darwin_die 'malformed nightly prerelease PHP version was accepted'
fi
[ "$(php_darwin_formula "$current_version" debug zts "$current_version")" = php-debug-zts ] || \
  php_darwin_die 'preloaded current-version formula resolution failed'

version_count=0
nightly_count=0
seen_versions=
while read -r channel version; do
  case " $seen_versions " in *" $version "*) php_darwin_die "duplicate PHP version: $version" ;; esac
  seen_versions="$seen_versions $version"
  php_darwin_validate_channel "$version" "$channel"
  version_count=$((version_count + 1))
  [ "$channel" != nightly ] || nightly_count=$((nightly_count + 1))
  seen_variants=
  while read -r build ts; do
    case " $seen_variants " in *" $build/$ts "*) php_darwin_die "duplicate variant: $build/$ts" ;; esac
    seen_variants="$seen_variants $build/$ts"
    php_darwin_formula "$version" "$build" "$ts" >/dev/null
    php_darwin_requested_formula "$version" "$build" "$ts" >/dev/null
    php_darwin_asset "$version" "$build" "$ts" arm64 >/dev/null
  done < <(php_darwin_configured_variants)
done < <(php_darwin_configured_versions)
[ "$version_count" -eq 13 ] || php_darwin_die "expected 13 configured PHP versions, found $version_count"
[ "$nightly_count" -eq 1 ] || php_darwin_die "expected one nightly PHP version, found $nightly_count"
configured_versions=$(php_darwin_configured_versions | \
  awk '{ printf "%s%s", separator, $1 ":" $2; separator=" " }') || \
  php_darwin_die 'could not read configured PHP versions'
[ "$configured_versions" = \
  'stable:5.6 stable:7.0 stable:7.1 stable:7.2 stable:7.3 stable:7.4 stable:8.0 stable:8.1 stable:8.2 stable:8.3 stable:8.4 stable:8.5 nightly:8.6' ] || \
  php_darwin_die 'the PHP release-channel configuration is incomplete or out of order'
[ "$(printf '%s\n' "$seen_variants" | awk '{ print NF }')" -eq 4 ] || \
  php_darwin_die 'expected four build variants'
for required_variant in release/nts release/zts debug/nts debug/zts; do
  case " $seen_variants " in *" $required_variant "*) ;; *) php_darwin_die "missing build variant: $required_variant" ;; esac
done

jq -e '
  keys == ["arm64"] and
  .arm64.brew_prefix == "/opt/homebrew" and
  .arm64.build_runner == "macos-14" and .arm64.minimum_macos == 14 and
  .arm64.platform_key == "arm64_sonoma" and
  .arm64.test_runners == ["macos-14", "macos-15", "macos-26", "macos-latest"]
' "$script_dir/../conf/platforms.json" >/dev/null || php_darwin_die 'invalid platform configuration'
jq -e '
  keys == ["platforms", "purpose", "schema"] and .schema == 1 and
  .purpose == "Validate pre-ARM64-only release manifests" and
  .platforms == {"x86_64": {"minimum_macos": 15}}
' "$script_dir/../conf/legacy-platforms.json" >/dev/null || \
  php_darwin_die 'invalid legacy manifest platform configuration'
[ "$(php_darwin_expected_asset_count)" -eq 4 ] || php_darwin_die 'expected four ARM64 release assets'
if (php_darwin_normalize_arch x86_64) >/dev/null 2>&1 || \
  (php_darwin_normalize_arch amd64) >/dev/null 2>&1; then
  php_darwin_die 'Intel architecture aliases are still supported'
fi

archive_roots=
while IFS= read -r root extra; do
  [ -n "$root" ] || continue
  case "$root" in \#*) continue ;; esac
  [ -z "$extra" ] || php_darwin_die "invalid archive root: $root $extra"
  case "$root" in Cellar|Frameworks|bin|etc|include|lib|opt|sbin|share|var) ;; *)
    php_darwin_die "unsafe archive root: $root"
    ;;
  esac
  case " $archive_roots " in *" $root "*) php_darwin_die "duplicate archive root: $root" ;; esac
  archive_roots="$archive_roots $root"
done < "$script_dir/../conf/archive-paths"
[ "$(printf '%s\n' "$archive_roots" | awk '{print NF}')" -eq 10 ] || php_darwin_die 'expected ten archive roots'
[ "$archive_roots" = ' Cellar Frameworks bin etc include lib opt sbin share var' ] || \
  php_darwin_die 'archive roots are incomplete or out of order'
snapshot_roots=$(awk '!/^#/ && NF { printf "%s%s", separator, $1; separator=" " }' \
  "$script_dir/../conf/snapshot-paths") || php_darwin_die 'could not read snapshot roots'
[ "$snapshot_roots" = 'etc var' ] || php_darwin_die 'snapshot roots must be etc and var'
if ! grep -Fq "reuse_baseline_manifest=\"\$reuse_dir/before.tsv\"" "$script_dir/build.sh" || \
  ! grep -Fq "cp \"\$reuse_baseline_manifest\" \"\$before_manifest\"" "$script_dir/build.sh"; then
  php_darwin_die 'build variants do not share their filesystem baseline'
fi

jq -e '
  keys == ["compression_level", "compression_long", "max_archive_bytes"] and
  (.compression_level | type == "number" and . >= 1 and . <= 22 and . == floor) and
  .compression_level == 22 and .compression_long == 27 and
  .max_archive_bytes == {
    "5.6": 140000000, "7.0": 140000000, "7.1": 140000000, "7.2": 140000000,
    "7.3": 140000000, "7.4": 140000000, "8.0": 140000000, "8.1": 140000000,
    "8.2": 140000000, "8.3": 140000000, "8.4": 26000000, "8.5": 26000000,
    "8.6": 28000000
  }
' "$script_dir/../conf/build.json" >/dev/null || php_darwin_die 'invalid build configuration'
jq -e '
  keys == ["current_version", "extension_tap", "extension_tap_branch", "extension_tap_repository",
           "release_repository", "tap", "tap_branch", "tap_repository", "tap_snapshot"] and
  .current_version == "8.5" and .release_repository == "shivammathur/php-darwin" and
  .extension_tap == "shivammathur/extensions" and .extension_tap_branch == "main" and
  .extension_tap_repository == "https://github.com/shivammathur/homebrew-extensions" and
  .tap == "shivammathur/php" and .tap_branch == "main" and
  .tap_repository == "https://github.com/shivammathur/homebrew-php" and
  .tap_snapshot == "var/php-darwin/homebrew-php"
' "$script_dir/../conf/package.json" >/dev/null || php_darwin_die 'invalid package configuration'
jq -e '
  keys == ["architecture", "archive", "brew_prefix", "build", "created_at", "extensions", "formula",
           "formula_sha256", "homebrew_extensions_commit", "homebrew_php_commit", "links",
           "macos_version", "minimum_macos", "packages",
           "pear_path", "pecl_extension", "php_semver", "php_src_commit", "php_version", "platform_key", "requested_formula",
           "runner_image", "schema", "source_hash", "state_paths", "tap_formulae", "tap_snapshot", "thread_safety"] and .schema == 1 and
  .extensions == [] and .homebrew_extensions_commit == "" and
  .links == [] and .packages == [] and .state_paths == [] and .tap_formulae == [] and
  .pear_path == "" and .pecl_extension == "" and .php_src_commit == "" and
  .source_hash == "" and .tap_snapshot == ""
' "$script_dir/../templates/cache-metadata.json" >/dev/null || php_darwin_die 'invalid cache metadata template'
jq -e '
  keys == ["assets", "homebrew_extensions_commit", "homebrew_php_commit", "php_semver", "php_src_commit",
           "php_version", "schema", "source_hash"] and
  .schema == 1 and .assets == [] and .homebrew_extensions_commit == "" and
  .homebrew_php_commit == "" and .php_semver == "" and
  .php_src_commit == "" and .php_version == "" and .source_hash == ""
' "$script_dir/../templates/release-manifest.json" >/dev/null || php_darwin_die 'invalid release manifest template'

[ "$(bash "$script_dir/cached-extensions.sh" 5.6 | tr '\n' ' ')" = 'xdebug ' ] || \
  php_darwin_die 'PHP 5.6 cached extensions are invalid'
[ "$(bash "$script_dir/cached-extensions.sh" 7.0 | tr '\n' ' ')" = 'xdebug ' ] || \
  php_darwin_die 'PHP 7.0 cached extensions are invalid'
[ "$(bash "$script_dir/cached-extensions.sh" 8.5 | tr '\n' ' ')" = 'xdebug pcov ' ] || \
  php_darwin_die 'PHP 8.5 cached extensions are invalid'
[ "$(bash "$script_dir/cached-extensions.sh" 8.6 | tr '\n' ' ')" = 'xdebug pcov ' ] || \
  php_darwin_die 'PHP 8.6 cached extensions are invalid'

[ "$(php_darwin_pear_path 8.5 php)" = 'share/pear' ] || php_darwin_die 'current PEAR path is invalid'
[ "$(php_darwin_pear_path 8.4 'php@8.4')" = 'share/pear@8.4' ] || \
  php_darwin_die 'versioned PEAR path is invalid'
[ "$(php_darwin_pear_path 8.4 'php@8.4-debug-zts')" = 'share/pear@8.4-debug-zts' ] || \
  php_darwin_die 'versioned variant PEAR path is invalid'
[ "$(php_darwin_config_id 8.5 debug zts)" = '8.5-debug-zts' ] || \
  php_darwin_die 'variant configuration id is invalid'
[ "$(php_darwin_metadata_path 'php_8.5-nts-release+darwin_arm64.tar.zst')" = \
  'var/php-darwin/php_8.5-nts-release+darwin_arm64.json' ] || php_darwin_die 'embedded metadata path is invalid'
current_postinstall_paths=$(php_darwin_postinstall_paths 8.5 php | tr '\n' ' ')
[ "$current_postinstall_paths" = 'etc/php/8.5/pear.conf ' ] || \
  php_darwin_die 'current post-install paths are invalid'
versioned_postinstall_paths=$(php_darwin_postinstall_paths 8.4 'php@8.4' | tr '\n' ' ')
[ "$versioned_postinstall_paths" = \
  'etc/php/8.4/pear.conf etc/php/8.4/conf.d/ext-intl.ini etc/php/8.4/conf.d/ext-opcache.ini ' ] || \
  php_darwin_die 'versioned post-install paths are invalid'
variant_postinstall_paths=$(php_darwin_postinstall_paths 8.4 'php@8.4-debug-zts' debug zts | tr '\n' ' ')
[ "$variant_postinstall_paths" = \
  'etc/php/8.4-debug-zts/pear.conf etc/php/8.4-debug-zts/conf.d/ext-intl.ini etc/php/8.4-debug-zts/conf.d/ext-opcache.ini ' ] || \
  php_darwin_die 'variant post-install paths are invalid'

command -v zstd >/dev/null 2>&1 || php_darwin_die 'zstd is required for extraction validation'
fixture_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-validation.XXXXXX")
trap 'chmod u+w "$fixture_dir/prefix/lib/php" 2>/dev/null || true; rm -rf "$fixture_dir"' EXIT
fixture_source="$fixture_dir/source"
fixture_prefix="$fixture_dir/prefix"
fixture_archive="$fixture_dir/cache.tar.zst"
fixture_paths="$fixture_dir/archive-paths.txt"
fixture_excludes="$fixture_dir/excludes.txt"
fixture_kegs="$fixture_dir/kegs.txt"
fixture_managed_paths="$fixture_dir/managed-paths.txt"
fixture_package_kegs="$fixture_dir/package-kegs.txt"
fixture_metadata="$fixture_dir/metadata.json"
fixture_contents="$fixture_dir/archive-contents.txt"
fixture_links="$fixture_dir/links.tsv"
fixture_links_log="$fixture_dir/links.log"
fixture_outside="$fixture_dir/outside"
fixture_symlink_prefix="$fixture_dir/symlink-prefix"
fixture_symlink_log="$fixture_dir/symlink-rack.log"
fixture_unsafe_managed_paths="$fixture_dir/unsafe-managed-paths.txt"
fixture_unsafe_root_log="$fixture_dir/unsafe-root.log"
fixture_bad_snapshot_roots="$fixture_dir/bad-snapshot-paths.txt"
fixture_snapshot_manifest="$fixture_dir/filesystem-manifest.tsv"
fixture_truncated_archive="$fixture_dir/truncated.tar"
fixture_plain_archive="$fixture_dir/metadata.tar"
phase_failure_log="$fixture_dir/phase-failure.log"
invalid_update_root="$fixture_dir/invalid-update-root"
tap_fixture="$fixture_dir/tap"
tap_backup="$fixture_dir/tap-backup"
tap_symlink="$fixture_dir/tap-symlink"
tap_brew_prefix="$fixture_dir/brew"
runtime_dependencies="$fixture_dir/runtime-dependencies.txt"
installed_formulae="$fixture_dir/installed-formulae.txt"
selected_formulae="$fixture_dir/selected-formulae.txt"
cleanup_formulae="$fixture_dir/cleanup-formulae.txt"
dependency_info="$fixture_dir/dependency-info.json"
php_dependencies="$fixture_dir/php-dependencies.txt"
unrelated_formulae="$fixture_dir/unrelated-formulae.txt"
mkdir -p "$invalid_update_root/conf" || php_darwin_die 'could not create the invalid update fixture'
cp "$script_dir/../conf/package.json" "$invalid_update_root/conf/package.json" || \
  php_darwin_die 'could not stage the update package configuration fixture'
printf 'stable 8.5 unexpected\n' > "$invalid_update_root/conf/versions" || \
  php_darwin_die 'could not write the invalid update version fixture'
if PHP_DARWIN_ROOT="$invalid_update_root" bash "$script_dir/update.sh" >/dev/null 2>&1; then
  php_darwin_die 'stable cache update silently accepted invalid version configuration'
fi
bash "$script_dir/validate-install.sh" || php_darwin_die 'standalone installer validation failed'
if bash -c '
  . "$1"
  php_darwin_set_phase archive.extract
  php_darwin_die "fixture extraction error"
' _ "$script_dir/lib.sh" > /dev/null 2> "$phase_failure_log"; then
  php_darwin_die 'phase failure fixture unexpectedly succeeded'
fi
grep -Fq 'php-darwin: archive.extract failed: fixture extraction error' "$phase_failure_log" || \
  php_darwin_die 'installer did not explain its phase failure'
if ! (
  brew() { printf '{"taps":["shivammathur/php"],"formulae":[]}\n'; }
  php_darwin_tap_trusted shivammathur/php
); then
  php_darwin_die 'Homebrew trust helper did not recognize a trusted tap'
fi
if (
  brew() { printf '{"taps":[],"formulae":[]}\n'; }
  php_darwin_tap_trusted shivammathur/php
); then
  php_darwin_die 'Homebrew trust helper accepted an untrusted tap'
fi
if ! php_darwin_formula_trusted shivammathur/php/php \
  '{"taps":[],"formulae":["shivammathur/php/php"]}'; then
  php_darwin_die 'Homebrew trust helper did not recognize a trusted formula'
fi
if php_darwin_formula_trusted shivammathur/php/php '{"taps":[],"formulae":[]}'; then
  php_darwin_die 'Homebrew trust helper accepted an untrusted formula'
fi
(
  brew() { printf '{"invalid":true}\n'; }
  php_darwin_tap_trusted shivammathur/php 2>/dev/null
  [ "$?" -eq 2 ]
) || php_darwin_die 'Homebrew trust helper masked malformed trust state'

receipt_prefix="$fixture_dir/receipt-prefix"
mkdir -p "$receipt_prefix/Cellar/php@8.4/8.4.16" || \
  php_darwin_die 'could not create the formula receipt fixture'
printf '{"source":{"tap":"shivammathur/php"}}\n' \
  > "$receipt_prefix/Cellar/php@8.4/8.4.16/INSTALL_RECEIPT.json" || \
  php_darwin_die 'could not write the formula receipt fixture'
[ "$(php_darwin_keg_formula_reference "$receipt_prefix" php@8.4 Cellar/php@8.4/8.4.16 \
  shivammathur/php)" = \
  shivammathur/php/php@8.4 ] || \
  php_darwin_die 'tap formula receipt did not resolve to a fully-qualified reference'
printf '{"source":{"tap":"homebrew/core"}}\n' \
  > "$receipt_prefix/Cellar/php@8.4/8.4.16/INSTALL_RECEIPT.json" || \
  php_darwin_die 'could not update the formula receipt fixture'
[ "$(php_darwin_keg_formula_reference "$receipt_prefix" php@8.4 Cellar/php@8.4/8.4.16 \
  shivammathur/php)" = php@8.4 ] || \
  php_darwin_die 'core formula receipt did not resolve to a bare reference'

[ "$(php_darwin_prepare_tap_path "$tap_fixture" "$tap_backup")" = absent ] || \
  php_darwin_die 'absent Homebrew tap fixture returned the wrong state'
git init -q "$tap_fixture" || php_darwin_die 'could not create the Git tap fixture'
[ "$(php_darwin_prepare_tap_path "$tap_fixture" "$tap_backup")" = git ] || \
  php_darwin_die 'Git Homebrew tap fixture returned the wrong state'
[ -d "$tap_fixture/.git" ] || php_darwin_die 'Git Homebrew tap fixture was moved'
rm -rf "$tap_fixture/.git"
worktree_source="$fixture_dir/worktree-source"
worktree_tap="$fixture_dir/worktree-tap"
git init -q -b main "$worktree_source" || php_darwin_die 'could not create a worktree source fixture'
printf 'fixture\n' > "$worktree_source/fixture" || php_darwin_die 'could not write a worktree fixture'
git -C "$worktree_source" add fixture || php_darwin_die 'could not stage the worktree fixture'
git -C "$worktree_source" -c user.name=php-darwin -c user.email=php-darwin@example.invalid \
  commit -q -m fixture || php_darwin_die 'could not commit the worktree fixture'
git -C "$worktree_source" worktree add -q --detach "$worktree_tap" HEAD || \
  php_darwin_die 'could not create a linked worktree fixture'
[ -f "$worktree_tap/.git" ] || php_darwin_die 'linked worktree fixture did not use a Git file'
[ "$(php_darwin_prepare_tap_path "$worktree_tap" "$tap_backup")" = git ] || \
  php_darwin_die 'linked Homebrew tap worktree was not preserved'
[ -d "$worktree_tap" ] || php_darwin_die 'linked Homebrew tap worktree was moved'
mkdir -p "$worktree_source/Library/Taps/example/homebrew-false-tap" || \
  php_darwin_die 'could not create the parent-repository tap fixture'
if php_darwin_is_git_worktree "$worktree_source/Library/Taps/example/homebrew-false-tap"; then
  php_darwin_die 'tap detection inherited Git state from a parent repository'
fi
printf 'runner-placeholder\n' > "$tap_fixture/Formula.php"
[ "$(php_darwin_prepare_tap_path "$tap_fixture" "$tap_backup")" = backed-up ] || \
  php_darwin_die 'non-Git Homebrew tap fixture returned the wrong state'
[ ! -e "$tap_fixture" ] && [ "$(cat "$tap_backup/Formula.php")" = runner-placeholder ] || \
  php_darwin_die 'non-Git Homebrew tap fixture was not backed up'
php_darwin_restore_tap_path "$tap_fixture" "$tap_backup" || \
  php_darwin_die 'non-Git Homebrew tap fixture could not be restored'
[ "$(cat "$tap_fixture/Formula.php")" = runner-placeholder ] || \
  php_darwin_die 'restored Homebrew tap fixture changed'
mkdir -p "$tap_brew_prefix/var/php-darwin" || php_darwin_die 'could not create the tap backup root fixture'
tap_fixture_path="$tap_brew_prefix/Library/Taps/shivammathur/homebrew-php"
mkdir -p "${tap_fixture_path%/*}" || php_darwin_die 'could not create the tap path fixture'
mv "$tap_fixture" "$tap_fixture_path" || php_darwin_die 'could not stage the tap path fixture'
tap_fixture=$tap_fixture_path
tap_backup=$(php_darwin_tap_backup_path "$tap_brew_prefix" "$tap_fixture" \
  "$fixture_dir/php-darwin-install.fixture") || \
  php_darwin_die 'could not resolve the same-filesystem tap backup fixture'
[ "$tap_backup" = "$tap_brew_prefix/var/php-darwin/tap-backup.php-darwin-install.fixture" ] || \
  php_darwin_die 'tap backup fixture was not in the Homebrew rollback directory'
[ "$(php_darwin_prepare_tap_path "$tap_fixture" "$tap_backup")" = backed-up ] || \
  php_darwin_die 'tap removal fixture was not backed up'
php_darwin_remove_tap_backup "$tap_brew_prefix" "$tap_backup" || \
  php_darwin_die 'same-filesystem Homebrew tap backup fixture could not be removed'
[ ! -e "$tap_backup" ] || php_darwin_die 'Homebrew tap backup fixture remained after removal'
git init -q "$tap_fixture" || php_darwin_die 'could not create the removable tap fixture'
php_darwin_remove_tap_path "$tap_brew_prefix" "$tap_fixture" || \
  php_darwin_die 'Homebrew tap fixture could not be removed transactionally'
[ ! -e "$tap_fixture" ] || php_darwin_die 'removed Homebrew tap fixture remained'
ln -s "$tap_fixture" "$tap_symlink" || php_darwin_die 'could not create the tap symlink fixture'
if php_darwin_prepare_tap_path "$tap_symlink" "$tap_backup" 2> /dev/null; then
  php_darwin_die 'Homebrew tap preparation accepted a symlink'
fi

printf '%s\n' 'dependency-new 1.0' 'hello 1.0' 'php-debug 8.5.10' \
  'updated-dependency 2.0' 'zstd 1.5.7' > "$installed_formulae"
printf '%s\n' dependency-new updated-dependency zstd > "$runtime_dependencies"
bash "$script_dir/select-packages.sh" "$runtime_dependencies" "$installed_formulae" php-debug "$selected_formulae" || \
  php_darwin_die 'runtime dependency package selection failed'
[ "$(tr '\n' ' ' < "$selected_formulae")" = 'dependency-new php-debug updated-dependency ' ] || \
  php_darwin_die 'runtime dependency package selection was incomplete'
printf '%s\n' dependency-new missing-dependency > "$runtime_dependencies"
if bash "$script_dir/select-packages.sh" "$runtime_dependencies" "$installed_formulae" php-debug \
  "$selected_formulae" 2>/dev/null; then
  php_darwin_die 'runtime dependency package selection accepted a missing dependency'
fi

printf '%s\n' \
  '{"formulae":[{"name":"zstd","full_name":"zstd"},{"name":"oniguruma","full_name":"oniguruma"},{"name":"openssl@3","full_name":"openssl@3"},{"name":"jq","full_name":"jq"},{"name":"icu4c@78","full_name":"icu4c@78"},{"name":"autoconf@2.69","full_name":"shivammathur/php/autoconf@2.69"}]}' \
  > "$dependency_info"
bash "$script_dir/canonicalize-formulae.sh" < "$dependency_info" > "$php_dependencies" || \
  php_darwin_die 'Homebrew dependency canonicalization failed'
[ "$(tr '\n' ' ' < "$php_dependencies")" = \
  'autoconf@2.69 icu4c@78 jq oniguruma openssl@3 zstd ' ] || \
  php_darwin_die 'Homebrew dependency canonicalization did not use canonical formula names'
printf '%s\n' 'autoconf@2.69 2.69' 'cmake 4.1.1' 'icu4c@77 77.1' 'icu4c@78 78.1' \
  'jq 1.8.1' 'oniguruma 6.9.10' 'openssl@3 3.5.2' 'php@8.4 8.4.13' 'zstd 1.5.7' \
  > "$cleanup_formulae"
bash "$script_dir/select-cleanup-formulae.sh" "$cleanup_formulae" "$php_dependencies" \
  "$unrelated_formulae" || php_darwin_die 'Homebrew cleanup selection failed'
[ "$(tr '\n' ' ' < "$unrelated_formulae")" = 'cmake icu4c@77 php@8.4 ' ] || \
  php_darwin_die 'Homebrew cleanup selection did not preserve the exact PHP dependencies'

mkdir -p "$fixture_source/Cellar/php/1/bin" "$fixture_source/Cellar/php/1/lib" \
  "$fixture_source/Cellar/dependency/1/bin" \
  "$fixture_source/lib/php/20200930" \
  "$fixture_source/etc" "$fixture_source/opt" \
  "$fixture_source/share/pear" "$fixture_source/var/homebrew/linked" "$fixture_source/var/php-darwin" \
  "$fixture_source/etc/existing-link" "$fixture_prefix/Cellar/dependency/1/bin" \
  "$fixture_prefix/Cellar/hello/1/bin" "$fixture_prefix/etc" \
  "$fixture_prefix/Frameworks" "$fixture_prefix/bin" "$fixture_prefix/include" \
  "$fixture_prefix/lib/php" \
  "$fixture_prefix/opt" "$fixture_prefix/sbin" "$fixture_prefix/share/pear" "$fixture_prefix/var" \
  "$fixture_outside" "$fixture_symlink_prefix/Cellar" || \
  php_darwin_die 'could not create extraction fixtures'
printf '#!/usr/bin/env bash\nprintf fixture-php\\n\n' > "$fixture_source/Cellar/php/1/bin/php"
chmod 0755 "$fixture_source/Cellar/php/1/bin/php"
printf 'archive-dependency\n' > "$fixture_source/Cellar/dependency/1/bin/dependency"
printf 'archive-oniguruma\n' > "$fixture_source/Cellar/php/1/lib/libonig.5.dylib"
printf 'cached-extension\n' > "$fixture_source/lib/php/20200930/cache.so"
printf 'existing-dependency\n' > "$fixture_prefix/Cellar/dependency/1/bin/dependency"
printf 'existing-oniguruma\n' > "$fixture_prefix/lib/libonig.5.dylib"
printf 'archive-value\n' > "$fixture_source/etc/existing[1].conf"
printf 'must-not-escape\n' > "$fixture_source/etc/existing-link/new.conf"
ln -s ../Cellar/php/1 "$fixture_source/opt/php"
ln -s ../../../Cellar/php/1 "$fixture_source/var/homebrew/linked/php"
printf '{"fixture":true}\n' > \
  "$fixture_source/var/php-darwin/php_8.5-nts-release+darwin_arm64.json"
printf 'cached-pear\n' > "$fixture_source/share/pear/new.php"
printf 'existing-pear\n' > "$fixture_prefix/share/pear/existing.php"
printf 'user-value\n' > "$fixture_prefix/etc/existing[1].conf"
chmod 0444 "$fixture_prefix/etc/existing[1].conf"
chmod 0555 "$fixture_prefix/lib/php"
ln -s "$fixture_outside" "$fixture_prefix/etc/existing-link"
printf '#!/usr/bin/env bash\nprintf hello\\n\n' > "$fixture_prefix/Cellar/hello/1/bin/hello"
chmod 0755 "$fixture_prefix/Cellar/hello/1/bin/hello"
printf '%s\n' var/php-darwin/php_8.5-nts-release+darwin_arm64.json \
  Cellar/dependency/1/bin/dependency Cellar/php/1/bin/php \
  Cellar/php/1/lib/libonig.5.dylib \
  'etc/existing[1].conf' etc/existing-link/new.conf lib/php/20200930/cache.so \
  opt/php share/pear/new.php \
  var/homebrew/linked/php > "$fixture_paths"
awk '$0 !~ /^Cellar\//' "$fixture_paths" > "$fixture_managed_paths" || \
  php_darwin_die 'could not create managed path fixtures'
printf '%s\n' lib/libonig.5.dylib >> "$fixture_managed_paths" || \
  php_darwin_die 'could not add the suffix-collision fixture'
printf '%s\n' Cellar/dependency/1 Cellar/php/1 > "$fixture_package_kegs" || \
  php_darwin_die 'could not create package keg fixtures'
tar --no-recursion -cf - -C "$fixture_source" -T "$fixture_paths" | zstd -3 -q -o "$fixture_archive"
fixture_status=("${PIPESTATUS[@]}")
[ "${fixture_status[0]}" -eq 0 ] && [ "${fixture_status[1]}" -eq 0 ] || \
  php_darwin_die 'could not create the extraction fixture archive'
bash "$script_dir/existing-paths.sh" "$fixture_prefix" "$fixture_excludes" \
  "$script_dir/../conf/archive-paths" "$fixture_kegs" "$fixture_managed_paths" \
  "$fixture_package_kegs" || \
  php_darwin_die 'could not create fixture exclusions'
grep -Fxq 'Cellar/dependency/1' "$fixture_excludes" || \
  php_darwin_die 'existing package keg was not excluded as one subtree'
grep -Fxq 'Cellar/dependency/1' "$fixture_kegs" || php_darwin_die 'existing package keg inventory is incomplete'
! grep -Fq 'Cellar/hello/1' "$fixture_excludes" || php_darwin_die 'unrelated keg was unnecessarily scanned'
bash "$script_dir/extract.sh" "$fixture_archive" "$fixture_prefix" "$fixture_excludes" || \
  php_darwin_die 'direct compressed extraction fixture failed'
bash "$script_dir/list-archive.sh" "$fixture_archive" "$fixture_contents" || \
  php_darwin_die 'direct compressed archive listing fixture failed'
bash "$script_dir/read-metadata.sh" "$fixture_archive" \
  var/php-darwin/php_8.5-nts-release+darwin_arm64.json "$fixture_metadata" || \
  php_darwin_die 'embedded metadata read fixture failed'
[ "$(cat "$fixture_metadata")" = '{"fixture":true}' ] || \
  php_darwin_die 'embedded metadata read fixture returned the wrong content'
tar -cf "$fixture_plain_archive" -C "$fixture_source" \
  var/php-darwin/php_8.5-nts-release+darwin_arm64.json || \
  php_darwin_die 'could not create the metadata truncation fixture'
dd if="$fixture_plain_archive" of="$fixture_truncated_archive" bs=1 count=530 2>/dev/null || \
  php_darwin_die 'could not truncate the metadata archive fixture'
if bash "$script_dir/read-metadata.sh" "$fixture_truncated_archive" \
  var/php-darwin/php_8.5-nts-release+darwin_arm64.json "$fixture_metadata" 2>/dev/null; then
  php_darwin_die 'metadata reader accepted a truncated archive'
fi
[ ! -e "$fixture_metadata" ] || php_darwin_die 'metadata reader kept partial output from a truncated archive'
[ "$(cat "$fixture_prefix/etc/existing[1].conf")" = user-value ] || \
  php_darwin_die 'direct extraction replaced an existing file'
fixture_mode=$(stat -f '%Lp' "$fixture_prefix/etc/existing[1].conf" 2>/dev/null || true)
case "$fixture_mode" in 444) ;; *) fixture_mode=$(stat -c '%a' "$fixture_prefix/etc/existing[1].conf") || \
  php_darwin_die 'could not inspect fixture permissions' ;; esac
[ "$fixture_mode" = 444 ] || \
  php_darwin_die 'direct extraction changed existing permissions'
[ -x "$fixture_prefix/Cellar/php/1/bin/php" ] || php_darwin_die 'direct extraction lost executable permissions'
[ "$(cat "$fixture_prefix/Cellar/php/1/lib/libonig.5.dylib")" = archive-oniguruma ] || \
  php_darwin_die 'an unanchored exclusion suppressed a file inside the PHP keg'
[ "$(cat "$fixture_prefix/lib/libonig.5.dylib")" = existing-oniguruma ] || \
  php_darwin_die 'direct extraction replaced the linked dependency fixture'
[ "$(cat "$fixture_prefix/lib/php/20200930/cache.so")" = cached-extension ] || \
  php_darwin_die 'direct extraction did not recover from an unwritable Homebrew directory'
fixture_php_mode=$(stat -f '%Lp' "$fixture_prefix/lib/php" 2>/dev/null || true)
case "$fixture_php_mode" in 555) ;; *)
  fixture_php_mode=$(stat -c '%a' "$fixture_prefix/lib/php") || \
    php_darwin_die 'could not inspect restored Homebrew directory permissions'
  ;;
esac
[ "$fixture_php_mode" = 555 ] || \
  php_darwin_die 'direct extraction did not restore Homebrew directory permissions'
[ "$(readlink "$fixture_prefix/opt/php")" = ../Cellar/php/1 ] || php_darwin_die 'direct extraction lost the PHP opt link'
[ "$(readlink "$fixture_prefix/var/homebrew/linked/php")" = ../../../Cellar/php/1 ] || \
  php_darwin_die 'direct extraction omitted the Homebrew linked-keg marker'
printf '%s\t%s\n' opt/php ../Cellar/php/1 \
  var/homebrew/linked/php ../../../Cellar/php/1 > "$fixture_links" || \
  php_darwin_die 'could not create the Homebrew link fixture'
bash "$script_dir/verify-links.sh" "$fixture_prefix" "$fixture_links" || \
  php_darwin_die 'bulk Homebrew link verification failed'
ln -sfn ../Cellar/php/invalid "$fixture_prefix/opt/php" || \
  php_darwin_die 'could not change the Homebrew link fixture'
if bash "$script_dir/verify-links.sh" "$fixture_prefix" "$fixture_links" 2> "$fixture_links_log"; then
  php_darwin_die 'bulk Homebrew link verification accepted a wrong target'
fi
grep -Fq 'Cached Homebrew links do not match the archive manifest' "$fixture_links_log" || \
  php_darwin_die 'bulk Homebrew link verification did not explain the mismatch'
ln -sfn ../Cellar/php/1 "$fixture_prefix/opt/php" || \
  php_darwin_die 'could not restore the Homebrew link fixture'
[ -x "$fixture_prefix/Cellar/hello/1/bin/hello" ] || php_darwin_die 'direct extraction removed an existing formula'
[ "$(cat "$fixture_prefix/Cellar/dependency/1/bin/dependency")" = existing-dependency ] || \
  php_darwin_die 'direct extraction replaced an existing package keg'
[ "$(cat "$fixture_prefix/share/pear/existing.php")" = existing-pear ] || \
  php_darwin_die 'direct extraction changed existing PEAR state'
[ "$(cat "$fixture_prefix/share/pear/new.php")" = cached-pear ] || \
  php_darwin_die 'direct extraction omitted cached PEAR state'
[ ! -e "$fixture_outside/new.conf" ] || php_darwin_die 'direct extraction followed an existing symlink outside Homebrew'
ln -s "$fixture_outside" "$fixture_symlink_prefix/Cellar/dependency" || \
  php_darwin_die 'could not create the symlinked formula rack fixture'
if bash "$script_dir/existing-paths.sh" "$fixture_symlink_prefix" "$fixture_excludes" \
  "$script_dir/../conf/archive-paths" "$fixture_kegs" "$fixture_managed_paths" \
  "$fixture_package_kegs" 2> "$fixture_symlink_log"; then
  php_darwin_die 'existing-path scan accepted a symlinked formula rack'
fi
grep -Fxq 'Homebrew formula rack is a symlink: Cellar/dependency' "$fixture_symlink_log" || \
  php_darwin_die 'symlinked formula rack failure was not explained'
printf '%s\n' 'C*/escape' > "$fixture_unsafe_managed_paths" || \
  php_darwin_die 'could not create the unsafe managed-root fixture'
if bash "$script_dir/existing-paths.sh" "$fixture_prefix" "$fixture_excludes" \
  "$script_dir/../conf/archive-paths" "$fixture_kegs" "$fixture_unsafe_managed_paths" \
  "$fixture_package_kegs" 2> "$fixture_unsafe_root_log"; then
  php_darwin_die 'existing-path scan accepted a managed-root pattern'
fi
grep -Fxq 'Unsafe managed archive root: C*' "$fixture_unsafe_root_log" || \
  php_darwin_die 'unsafe managed-root failure was not explained'

printf 'etc unexpected\n' > "$fixture_bad_snapshot_roots" || \
  php_darwin_die 'could not create the malformed snapshot-root fixture'
if bash "$script_dir/filesystem-manifest.sh" "$fixture_prefix" "$fixture_snapshot_manifest" \
  "$fixture_bad_snapshot_roots" >/dev/null 2>&1; then
  php_darwin_die 'filesystem manifest accepted a malformed snapshot root'
fi
mkdir -p "$fixture_prefix/var/homebrew/pinned" || \
  php_darwin_die 'could not create the pinned-state fixture'
ln -s ../../Cellar/dependency/1 "$fixture_prefix/var/homebrew/pinned/dependency" || \
  php_darwin_die 'could not create the pinned-state link fixture'
bash "$script_dir/filesystem-manifest.sh" "$fixture_prefix" "$fixture_snapshot_manifest" \
  "$script_dir/../conf/snapshot-paths" || php_darwin_die 'filesystem manifest fixture failed'
! grep -Fq 'var/homebrew/pinned' "$fixture_snapshot_manifest" || \
  php_darwin_die 'filesystem manifest captured temporary Homebrew pins'

bash "$script_dir/test-publish.sh" || php_darwin_die 'publish validation failed'
bash "$script_dir/test-update-nightly.sh" || php_darwin_die 'nightly update validation failed'
bash "$script_dir/test-tap.sh" || php_darwin_die 'Homebrew tap snapshot validation failed'
bash "$script_dir/test-matrix.sh" || php_darwin_die 'workflow matrix validation failed'

printf 'Configuration validation passed\n'
