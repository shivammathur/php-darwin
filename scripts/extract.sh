#!/usr/bin/env bash

archive=${1:?}
prefix=${2:?}
exclude_file=${3:?}
archive_members=$(mktemp "${RUNNER_TEMP:-/tmp}/php-darwin-archive-members.XXXXXX") || exit 1
extract_members=$(mktemp "${RUNNER_TEMP:-/tmp}/php-darwin-extract-members.XXXXXX") || {
  rm -f "$archive_members"
  exit 1
}
retry_members=
parent_paths=
permission_records=

path_uid() {
  stat -f '%u' "$1" 2>/dev/null || stat -c '%u' "$1"
}

path_gid() {
  stat -f '%g' "$1" 2>/dev/null || stat -c '%g' "$1"
}

path_mode() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"
}

restore_permissions() {
  local absolute_path
  local changed_owner
  local extra
  local gid
  local mode
  local relative_path
  local status=0
  local uid

  [ -n "$permission_records" ] && [ -s "$permission_records" ] || return 0
  while IFS=$'\t' read -r relative_path uid gid mode changed_owner extra; do
    [ -n "$relative_path" ] && [ -z "$extra" ] || {
      status=1
      continue
    }
    absolute_path="$prefix/$relative_path"
    if [ ! -d "$absolute_path" ] || [ -L "$absolute_path" ]; then
      printf 'Could not restore extraction directory: %s\n' "$relative_path" >&2
      status=1
      continue
    fi
    if ! chmod "$mode" "$absolute_path" 2>/dev/null && \
      ! sudo -n chmod "$mode" "$absolute_path"; then
      printf 'Could not restore extraction permissions: %s\n' "$relative_path" >&2
      status=1
    fi
    if [ "$changed_owner" = true ] && ! sudo -n chown "$uid:$gid" "$absolute_path"; then
      printf 'Could not restore extraction ownership: %s\n' "$relative_path" >&2
      status=1
    fi
  done < "$permission_records"
  [ "$status" -ne 0 ] || : > "$permission_records"
  return "$status"
}

# shellcheck disable=SC2329
cleanup() {
  local temporary_file

  trap '' HUP INT TERM
  restore_permissions || true
  for temporary_file in "$archive_members" "$extract_members" "$retry_members" \
    "$parent_paths" "$permission_records"; do
    [ -z "$temporary_file" ] || rm -f "$temporary_file"
  done
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

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
    if ($0 == "" || $0 ~ /[\t\r]/ || $0 ~ /^\// || $0 ~ /(^|\/)\.\.($|\/)/ ||
        $0 ~ /(^|\/)\.($|\/)/ || $0 ~ /\/\// || $0 ~ /\/$/) exit 2
    excluded[$0]=1
    next
  }
  {
    path=$0
    if (path == "" || path ~ /[\t\r]/ || path ~ /^\// || path ~ /(^|\/)\.\.($|\/)/ ||
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

if tar --ignore-zeros -xkmpf "$archive" --no-same-owner -C "$prefix" \
  -T "$extract_members" 2> "$archive_members"; then
  exit 0
fi

retry_members=$(mktemp "${RUNNER_TEMP:-/tmp}/php-darwin-retry-members.XXXXXX") || exit 1
parent_paths=$(mktemp "${RUNNER_TEMP:-/tmp}/php-darwin-parent-paths.XXXXXX") || exit 1
permission_records=$(mktemp "${RUNNER_TEMP:-/tmp}/php-darwin-permissions.XXXXXX") || exit 1
: > "$retry_members" || exit 1
while IFS= read -r member; do
  if [ ! -e "$prefix/$member" ] && [ ! -L "$prefix/$member" ]; then
    printf '%s\n' "$member" >> "$retry_members" || exit 1
  fi
done < "$extract_members"
[ -s "$retry_members" ] || {
  cat "$archive_members" >&2
  exit 1
}

awk '
  {
    path=$0
    while (sub("/[^/]+$", "", path)) print path
  }
' "$retry_members" | LC_ALL=C sort -u > "$parent_paths" || exit 1
: > "$permission_records" || exit 1
current_uid=$(id -u) || exit 1
current_gid=$(id -g) || exit 1
while IFS= read -r relative_path; do
  absolute_path="$prefix/$relative_path"
  [ ! -L "$absolute_path" ] || {
    printf 'Extraction parent is a symlink: %s\n' "$relative_path" >&2
    exit 1
  }
  [ -d "$absolute_path" ] || continue
  [ ! -w "$absolute_path" ] || continue
  uid=$(path_uid "$absolute_path") || exit 1
  gid=$(path_gid "$absolute_path") || exit 1
  mode=$(path_mode "$absolute_path") || exit 1
  if [ "$uid" = "$current_uid" ]; then
    changed_owner=false
  else
    changed_owner=true
  fi
  printf '%s\t%s\t%s\t%s\t%s\n' "$relative_path" "$uid" "$gid" "$mode" \
    "$changed_owner" >> "$permission_records" || exit 1
  if [ "$changed_owner" = true ]; then
    command -v sudo >/dev/null 2>&1 && \
      sudo -n chown "$current_uid:$current_gid" "$absolute_path" || exit 1
  fi
  chmod u+rwx "$absolute_path" || exit 1
  [ -w "$absolute_path" ] || exit 1
done < "$parent_paths"

[ -s "$permission_records" ] || {
  cat "$archive_members" >&2
  exit 1
}
printf 'Retrying cache extraction after temporarily granting access to Homebrew directories\n'
tar --ignore-zeros -xkmpf "$archive" --no-same-owner -C "$prefix" -T "$retry_members"
extract_status=$?
restore_permissions || exit 1
exit "$extract_status"
