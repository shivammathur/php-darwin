#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"
work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-repack-test.XXXXXX") || exit 1
trap 'rm -rf "$work_dir"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
asset=$(php_darwin_asset 8.3 release nts arm64) || exit 1
member=$(php_darwin_metadata_path "$asset") || exit 1
prefix="$work_dir/prefix"
keg=Cellar/php@8.3/8.3.0
mkdir -p "$prefix/$keg/bin" "$prefix/$keg/share/man/man1" "$prefix/$keg/share/doc/php" \
  "$prefix/opt" "$prefix/bin" "$prefix/share/man/man1" "$prefix/share/pear@8.3" \
  "$prefix/etc/php/8.3" "$prefix/var/php-darwin" || exit 1
for entry in "$keg/bin/php" "$keg/INSTALL_RECEIPT.json" "$keg/share/man/man1/php.1" \
  "$keg/share/doc/php/LICENSE" "$keg/share/doc/php/guide.txt" \
  etc/php/8.3/pear.conf share/pear@8.3/pear.php; do
  printf 'fixture %s\n' "$entry" > "$prefix/$entry" || exit 1
done
chmod 755 "$prefix/$keg/bin/php" || exit 1
ln -s ../Cellar/php@8.3/8.3.0 "$prefix/opt/php@8.3" || exit 1
ln -s ../Cellar/php@8.3/8.3.0/bin/php "$prefix/bin/php" || exit 1
ln -s ../../../Cellar/php@8.3/8.3.0/share/man/man1/php.1 "$prefix/share/man/man1/php.1" || exit 1
jq --arg asset "$asset" --arg commit "$(printf '%040d' 1)" --arg hash "$(printf '%064d' 1)" '
  .archive=$asset | .architecture="arm64" | .brew_prefix="/opt/homebrew" |
  .build="release" | .thread_safety="nts" | .php_version="8.3" | .php_semver="8.3.0" |
  .formula="php@8.3" | .requested_formula="php@8.3" | .minimum_macos=14 |
  .platform_key="arm64_sonoma" | .pear_path="share/pear@8.3" | .pecl_extension="20230831" |
  .homebrew_php_commit=$commit | .formula_sha256=$hash | .source_hash=$hash |
  .tap_snapshot="var/php-darwin/homebrew-php" |
  .packages=[{name:"php@8.3",opt_target:"../Cellar/php@8.3/8.3.0",keg_only:false}] |
  .links=[{path:"bin/php",target:"../Cellar/php@8.3/8.3.0/bin/php"},
    {path:"share/man/man1/php.1",target:"../../../Cellar/php@8.3/8.3.0/share/man/man1/php.1"}] |
  .state_paths=["etc/php/8.3/pear.conf"]
' "$script_dir/../templates/cache-metadata.json" > "$prefix/$member" || exit 1
printf '%s\n' "$member" > "$work_dir/members" || exit 1
find "$prefix" ! -type d -print | sed "s|^$prefix/||" | grep -Fvx "$member" | LC_ALL=C sort >> "$work_dir/members" || exit 1
tar --no-recursion -cf "$work_dir/source.tar" -C "$prefix" -T "$work_dir/members" || exit 1
zstd -q "$work_dir/source.tar" -o "$work_dir/$asset" || exit 1
checksum=$(php_darwin_sha256 "$work_dir/$asset") || exit 1
if bash "$script_dir/repack.sh" "$work_dir/$asset" "$(printf '%064d' 0)" "$work_dir/rejected" >/dev/null 2>&1; then
  php_darwin_die 'repack accepted a bad source checksum'
fi
bash "$script_dir/repack.sh" "$work_dir/$asset" "$checksum" "$work_dir/output" || exit 1
new_checksum=$(php_darwin_checksum_from_file "$work_dir/output/$asset.sha256" "$asset") || exit 1
[ "$new_checksum" != "$checksum" ] || php_darwin_die 'repack did not change the documentation fixture'
[ "$(php_darwin_sha256 "$work_dir/output/$asset")" = "$new_checksum" ] || exit 1
[ "$(php_darwin_sha256 "$work_dir/$asset")" = "$checksum" ] || php_darwin_die 'repack modified its source archive'
jq -e '.links | length == 1 and .[0].path == "bin/php"' "$work_dir/output/${asset%.tar.zst}.json" >/dev/null || \
  php_darwin_die 'repack retained a deleted documentation link in metadata'
bash "$script_dir/read-metadata.sh" "$work_dir/output/$asset" "$member" "$work_dir/embedded.json" || exit 1
cmp -s "$work_dir/embedded.json" "$work_dir/output/${asset%.tar.zst}.json" || exit 1
bash "$script_dir/repack.sh" "$work_dir/output/$asset" "$new_checksum" "$work_dir/idempotent" || exit 1
cmp -s "$work_dir/output/$asset" "$work_dir/idempotent/$asset" || php_darwin_die 'repack is not idempotent'
if bash "$script_dir/repack.sh" "$work_dir/$asset" "$checksum" "$work_dir/output" >/dev/null 2>&1; then
  php_darwin_die 'repack overwrote an existing output'
fi
printf 'Repack integrity, link metadata, source preservation, and idempotence validation passed\n'
