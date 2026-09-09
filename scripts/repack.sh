#!/usr/bin/env bash

# Repackage a verified cache without invoking Homebrew, PHP, or a compiler.
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"
archive=${1:?}
expected_sha256=${2:?}
output_dir=${3:?}
work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-repack.XXXXXX") || exit 1
cleanup() {
  trap '' HUP INT TERM
  rm -rf "$work_dir"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
[[ "$expected_sha256" =~ ^[0-9a-f]{64}$ ]] || php_darwin_die 'invalid trusted archive checksum'
[ "$(php_darwin_sha256 "$archive")" = "$expected_sha256" ] || php_darwin_die 'source archive checksum mismatch'
bash "$script_dir/list-archive.sh" "$archive" "$work_dir/members" || php_darwin_die 'could not list the verified archive'
awk '
  FILENAME == ARGV[1] { if ($1 !~ /^#/ && NF == 1) roots[$1]=1; next }
  {
    split($0, parts, "/")
    if (!(parts[1] in roots) || $0 ~ /[\r\t]/ || $0 ~ /(^|\/)\.\.?(\/|$)/ ||
        $0 ~ /\/\// || $0 ~ /\/$/ || seen[$0]++) exit 1
  }
' "$script_dir/../conf/archive-paths" "$work_dir/members" || php_darwin_die 'unsafe or duplicate archive member'
metadata_member=$(awk '
  /^var\/php-darwin\/php_[0-9]+\.[0-9]+-(nts|zts)-(debug|release)\+darwin_(arm64|x86_64)\.json$/ { member=$0; count++ }
  END { if (count != 1) exit 1; print member }
' "$work_dir/members") || php_darwin_die 'archive must contain exactly one cache metadata member'
bash "$script_dir/read-metadata.sh" "$archive" "$metadata_member" "$work_dir/source.json" || \
  php_darwin_die 'could not read source metadata'
values=$(jq -er '[.php_version,.build,.thread_safety,.architecture] |
  select(all(.[]; type == "string" and length > 0 and test("^[A-Za-z0-9._-]+$"))) | @tsv' \
  "$work_dir/source.json") || php_darwin_die 'invalid source metadata request'
IFS=$'\t' read -r version build ts arch <<< "$values" || exit 1
asset=$(php_darwin_asset "$version" "$build" "$ts" "$arch") || exit 1
[ "$metadata_member" = "$(php_darwin_metadata_path "$asset")" ] || php_darwin_die 'source metadata name mismatch'
expected_prefix=$(php_darwin_expected_prefix "$arch") || exit 1
minimum_macos=$(php_darwin_platform_value "$arch" minimum_macos) || exit 1
php_darwin_validate_cache_metadata "$work_dir/source.json" "$version" "$build" "$ts" "$arch" \
  "$expected_prefix" "$minimum_macos" >/dev/null || php_darwin_die 'source metadata validation failed'
for filename in "$asset" "$asset.sha256" "${asset%.tar.zst}.json"; do
  [ ! -e "$output_dir/$filename" ] || php_darwin_die "repack output already exists: $output_dir/$filename"
done
prefix="$work_dir/prefix"
mkdir -p "$prefix" "$work_dir/result" || exit 1
tar --ignore-zeros -xpf "$archive" --no-same-owner -C "$prefix" || php_darwin_die 'could not stage the verified archive'
bash "$script_dir/filter-archive.sh" "$prefix" "$work_dir/members" "$work_dir/kept" "$expected_prefix" || \
  php_darwin_die 'could not apply the runtime archive policy'
jq --rawfile paths "$work_dir/kept" '
  ($paths | split("\n") | map(select(length > 0)) | map({key:.,value:true}) | from_entries) as $kept |
  .links |= map(select($kept[.path]))
' "$work_dir/source.json" > "$work_dir/result/${asset%.tar.zst}.json" || \
  php_darwin_die 'could not update the embedded link manifest'
php_darwin_validate_cache_metadata "$work_dir/result/${asset%.tar.zst}.json" \
  "$version" "$build" "$ts" "$arch" "$expected_prefix" "$minimum_macos" >/dev/null || \
  php_darwin_die 'repacked metadata validation failed'
jq -r '.links[].path, .state_paths[], ((.extensions // [])[].path),
  (.packages[].name | "opt/" + .),
  (.packages[].opt_target | ltrimstr("../") | . + "/INSTALL_RECEIPT.json")' \
  "$work_dir/result/${asset%.tar.zst}.json" > "$work_dir/required" || exit 1
awk 'FILENAME == ARGV[1] { kept[$0]=1; next } !($0 in kept) { print; failed=1 } END { exit failed }' \
  "$work_dir/kept" "$work_dir/required" || php_darwin_die 'the archive policy removed required Homebrew state'

if cmp -s "$work_dir/members" "$work_dir/kept"; then
  cp "$archive" "$work_dir/result/$asset" || exit 1
  cp "$work_dir/source.json" "$work_dir/result/${asset%.tar.zst}.json" || exit 1
  printf 'Archive already satisfies the runtime policy: %s\n' "$asset"
else
  cp "$work_dir/result/${asset%.tar.zst}.json" "$prefix/$metadata_member" || exit 1
  bash "$script_dir/filesystem-manifest.sh" "$prefix" "$work_dir/before" \
    "$script_dir/../conf/archive-paths" || php_darwin_die 'could not fingerprint source payload'
  awk -F '\t' 'FILENAME == ARGV[1] { kept[$0]=1; next } $2 != "d" && ($1 in kept)' \
    "$work_dir/kept" "$work_dir/before" > "$work_dir/expected" || exit 1
  compression=$(jq -er 'select((.compression_level | type == "number" and floor == . and . >= 1 and . <= 22) and
    (.compression_long | type == "number" and floor == . and . > 0)) | [.compression_level,.compression_long] | @tsv' \
    "$script_dir/../conf/build.json") || exit 1
  IFS=$'\t' read -r level window <<< "$compression" || exit 1
  tar --no-recursion -cf - -C "$prefix" -T "$work_dir/kept" | \
    zstd --ultra -"$level" --long="$window" -T0 -q -o "$work_dir/result/$asset"
  compression_status=("${PIPESTATUS[@]}")
  [ "${compression_status[0]}" -eq 0 ] && [ "${compression_status[1]}" -eq 0 ] || php_darwin_die 'repacking failed'
  zstd -qt "$work_dir/result/$asset" || php_darwin_die 'repacked archive integrity failed'
  bash "$script_dir/list-archive.sh" "$work_dir/result/$asset" "$work_dir/actual-members" || exit 1
  cmp -s "$work_dir/kept" "$work_dir/actual-members" || php_darwin_die 'repacking changed the retained member list'
  mkdir "$work_dir/verify" || exit 1
  tar --ignore-zeros -xpf "$work_dir/result/$asset" --no-same-owner -C "$work_dir/verify" || exit 1
  bash "$script_dir/filesystem-manifest.sh" "$work_dir/verify" "$work_dir/after" \
    "$script_dir/../conf/archive-paths" || php_darwin_die 'could not fingerprint repacked payload'
  awk -F '\t' '$2 != "d"' "$work_dir/after" > "$work_dir/actual" || exit 1
  cmp -s "$work_dir/expected" "$work_dir/actual" || php_darwin_die 'repacking changed retained file bytes, modes, or symlinks'
  printf 'Verified %s retained paths; removed %s documentation paths from %s\n' \
    "$(wc -l < "$work_dir/kept" | tr -d ' ')" \
    "$(awk 'FILENAME == ARGV[1] { count++; next } { count-- } END { print count }' "$work_dir/members" "$work_dir/kept")" "$asset"
fi
actual_sha256=$(php_darwin_sha256 "$work_dir/result/$asset") || exit 1
printf '%s  %s\n' "$actual_sha256" "$asset" > "$work_dir/result/$asset.sha256" || exit 1
mkdir -p "$output_dir" || exit 1
mv "$work_dir/result/$asset" "$work_dir/result/$asset.sha256" \
  "$work_dir/result/${asset%.tar.zst}.json" "$output_dir/" || exit 1
