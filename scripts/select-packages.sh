#!/usr/bin/env bash

baseline=${1:?}
installed=${2:?}
formula=${3:?}
output=${4:?}

[ -f "$baseline" ] || exit 1
[ -f "$installed" ] || exit 1
[[ "$formula" =~ ^[A-Za-z0-9@+._-]+$ ]] || exit 1
awk -v formula="$formula" '$1 == formula { found=1 } END { exit !found }' "$installed" || exit 1

awk -v formula="$formula" '
  NR == FNR { if (NF) baseline[$1]=1; next }
  !NF || $1 == "zstd" { next }
  $1 == formula || !($1 in baseline) { print $1 }
' "$baseline" "$installed" | LC_ALL=C sort -u > "$output"
pipeline_status=("${PIPESTATUS[@]}")
[ "${pipeline_status[0]}" -eq 0 ] && [ "${pipeline_status[1]}" -eq 0 ] || exit 1
grep -Fxq "$formula" "$output"
