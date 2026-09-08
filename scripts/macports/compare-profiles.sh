#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/macports/lib.sh
. "$script_dir/lib.sh"

homebrew=${1:?}
macports=${2:?}
for profile in "$homebrew" "$macports"; do
  for file in extensions.txt php-info-keys.txt runtime.json pecl-config-keys.txt tool-versions.txt; do
    [ -s "$profile/$file" ] || php_darwin_macports_die "profile file is missing: $profile/$file"
  done
done

work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-parity.XXXXXX") || \
  php_darwin_macports_die 'could not create the comparison directory'
trap 'rm -rf "$work_dir"' EXIT
homebrew_only="$work_dir/homebrew-only.txt"
macports_only="$work_dir/macports-only.txt"
common="$work_dir/common.txt"
union="$work_dir/union.txt"
comm -23 "$homebrew/extensions.txt" "$macports/extensions.txt" > "$homebrew_only" || exit 1
comm -13 "$homebrew/extensions.txt" "$macports/extensions.txt" > "$macports_only" || exit 1
comm -12 "$homebrew/extensions.txt" "$macports/extensions.txt" > "$common" || exit 1
LC_ALL=C sort -u "$homebrew/extensions.txt" "$macports/extensions.txt" > "$union" || exit 1
common_count=$(awk 'END { print NR+0 }' "$common")
union_count=$(awk 'END { print NR+0 }' "$union")
[ "$union_count" -gt 0 ] || php_darwin_macports_die 'the extension profiles are empty'
extension_match=$((common_count * 100 / union_count))
printf 'Extension parity: %s%% (%s shared of %s total)\n' "$extension_match" "$common_count" "$union_count"
printf 'Homebrew-only extensions:\n'
sed 's/^/  /' "$homebrew_only"
printf 'MacPorts-only extensions:\n'
sed 's/^/  /' "$macports_only"
[ "$extension_match" -ge 95 ] || php_darwin_macports_die 'PHP extension parity is below 95%'

while IFS= read -r extension; do
  [ -n "$extension" ] || continue
  case "$extension" in \#*) continue ;; esac
  grep -Fxiq "$extension" "$homebrew/extensions.txt" || \
    php_darwin_macports_die "Homebrew is missing critical extension $extension"
  grep -Fxiq "$extension" "$macports/extensions.txt" || \
    php_darwin_macports_die "MacPorts is missing critical extension $extension"
done < "$php_darwin_macports_root/conf/macports-critical-extensions"

jq -S . "$homebrew/runtime.json" > "$work_dir/homebrew-runtime.json" || exit 1
jq -S . "$macports/runtime.json" > "$work_dir/macports-runtime.json" || exit 1
diff -u "$work_dir/homebrew-runtime.json" "$work_dir/macports-runtime.json" || \
  php_darwin_macports_die 'the normalized runtime capability profiles differ'
diff -u "$homebrew/pecl-config-keys.txt" "$macports/pecl-config-keys.txt" || \
  php_darwin_macports_die 'the PECL configuration capabilities differ'

comm -12 "$homebrew/php-info-keys.txt" "$macports/php-info-keys.txt" > "$work_dir/info-common.txt" || exit 1
LC_ALL=C sort -u "$homebrew/php-info-keys.txt" "$macports/php-info-keys.txt" > "$work_dir/info-union.txt" || exit 1
info_common_count=$(awk 'END { print NR+0 }' "$work_dir/info-common.txt")
info_union_count=$(awk 'END { print NR+0 }' "$work_dir/info-union.txt")
[ "$info_union_count" -gt 0 ] || php_darwin_macports_die 'the phpinfo profiles are empty'
info_match=$((info_common_count * 100 / info_union_count))
printf 'phpinfo directive parity: %s%% (%s shared of %s total)\n' "$info_match" "$info_common_count" "$info_union_count"
[ "$info_match" -ge 90 ] || php_darwin_macports_die 'phpinfo directive parity is below 90%'
printf 'Homebrew and MacPorts PHP capability profiles are compatible\n'
