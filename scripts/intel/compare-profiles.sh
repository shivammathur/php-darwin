#!/usr/bin/env bash

arm=${1:?}
intel=${2:?}
for profile in "$arm" "$intel"; do
  for file in extensions.txt php-info-keys.txt runtime.json pecl-config-keys.txt tool-versions.txt; do
    [ -s "$profile/$file" ] || { printf 'Missing profile file: %s/%s\n' "$profile" "$file" >&2; exit 1; }
  done
done
work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-parity.XXXXXX") || exit 1
trap 'rm -rf "$work_dir"' EXIT

diff -u "$arm/extensions.txt" "$intel/extensions.txt" || {
  printf 'ARM and Intel PHP extension sets differ\n' >&2
  exit 1
}
jq -S . "$arm/runtime.json" > "$work_dir/arm-runtime.json" || exit 1
jq -S . "$intel/runtime.json" > "$work_dir/intel-runtime.json" || exit 1
diff -u "$work_dir/arm-runtime.json" "$work_dir/intel-runtime.json" || {
  printf 'ARM and Intel runtime capabilities differ\n' >&2
  exit 1
}
diff -u "$arm/pecl-config-keys.txt" "$intel/pecl-config-keys.txt" || {
  printf 'ARM and Intel PECL configuration capabilities differ\n' >&2
  exit 1
}
comm -12 "$arm/php-info-keys.txt" "$intel/php-info-keys.txt" > "$work_dir/info-common.txt" || exit 1
LC_ALL=C sort -u "$arm/php-info-keys.txt" "$intel/php-info-keys.txt" > "$work_dir/info-union.txt" || exit 1
common_count=$(awk 'END { print NR+0 }' "$work_dir/info-common.txt")
union_count=$(awk 'END { print NR+0 }' "$work_dir/info-union.txt")
[ "$union_count" -gt 0 ] || exit 1
match=$((common_count * 100 / union_count))
printf 'phpinfo key parity: %s%% (%s of %s)\n' "$match" "$common_count" "$union_count"
[ "$match" -ge 95 ] || { printf 'phpinfo key parity is below 95%%\n' >&2; exit 1; }
printf 'ARM bottle and Intel source-build PHP profiles match\n'
