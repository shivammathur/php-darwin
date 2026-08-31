#!/usr/bin/env bash

archive=${1:?}
prefix=${2:?}
exclude_file=${3:?}
archive_members="$exclude_file.archive-members.$$"
extract_members="$exclude_file.extract-members.$$"
trap 'rm -f "$archive_members" "$extract_members"' EXIT

[ -f "$archive" ] || {
  printf 'Archive not found: %s\n' "$archive" >&2
  exit 1
}
[ -d "$prefix" ] || {
  printf 'Extraction prefix not found: %s\n' "$prefix" >&2
  exit 1
}
[ -f "$exclude_file" ] || {
  printf 'Extraction exclusion list not found: %s\n' "$exclude_file" >&2
  exit 1
}

tar --ignore-zeros -tf "$archive" > "$archive_members" || {
  printf 'Could not list archive members: %s\n' "$archive" >&2
  exit 1
}
awk '
  FILENAME == ARGV[1] {
    if ($0 == "" || $0 ~ /^\// || $0 ~ /(^|\/)\.\.($|\/)/ ||
        $0 ~ /(^|\/)\.($|\/)/ || $0 ~ /\/\// || $0 ~ /\/$/) exit 2
    excluded[$0]=1
    next
  }
  {
    path=$0
    if (path == "" || path ~ /^\// || path ~ /(^|\/)\.\.($|\/)/ ||
        path ~ /(^|\/)\.($|\/)/ || path ~ /\/\// || path ~ /\/$/) exit 3
    candidate=path
    while (1) {
      if (candidate in excluded) next
      if (!sub("/[^/]+$", "", candidate)) break
    }
    print path
  }
' "$exclude_file" "$archive_members" > "$extract_members"
filter_status=$?
case "$filter_status" in
  0) ;;
  2) printf 'Unsafe extraction exclusion path\n' >&2; exit 1 ;;
  3) printf 'Unsafe archive member\n' >&2; exit 1 ;;
  *) printf 'Could not filter archive members\n' >&2; exit 1 ;;
esac
[ -s "$extract_members" ] || {
  printf 'Archive has no extractable members: %s\n' "$archive" >&2
  exit 1
}

tar --ignore-zeros -xkmpf "$archive" --no-same-owner -C "$prefix" -T "$extract_members"
