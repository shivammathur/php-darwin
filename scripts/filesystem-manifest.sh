#!/usr/bin/env bash

prefix=${1:?}
output=${2:?}
roots_file=${3:?}
raw_output="$output.unsorted.$$"
path_list="$output.paths.$$"
trap 'rm -f "$raw_output" "$path_list"' EXIT

[ -d "$prefix" ] || {
  printf 'Missing Homebrew prefix: %s\n' "$prefix" >&2
  exit 1
}
[ -f "$roots_file" ] || {
  printf 'Missing snapshot roots: %s\n' "$roots_file" >&2
  exit 1
}

manifest_entry() {
  local path=$1
  local relative=${path#"$prefix"/}
  local hash
  local hash_output
  local mode

  case "$relative" in
    .git|.git/*|Homebrew|Homebrew/*|Library/Homebrew|Library/Homebrew/*|Library/Taps|Library/Taps/*|var/homebrew/locks|var/homebrew/locks/*)
      return
      ;;
  esac

  mode=$(stat -f '%Lp' "$path") || return 1
  if [ -L "$path" ]; then
    printf '%s\tl\t%s\t%s\n' "$relative" "$mode" "$(readlink "$path")"
  elif [ -f "$path" ]; then
    hash_output=$(shasum -a 256 "$path") || return 1
    hash=${hash_output%% *}
    printf '%s\tf\t%s\t%s\n' "$relative" "$mode" "$hash"
  elif [ -d "$path" ]; then
    printf '%s\td\t%s\n' "$relative" "$mode"
  fi
}

: > "$raw_output" || exit 1
while IFS= read -r relative_root extra; do
  [ -n "$relative_root" ] || continue
  case "$relative_root" in \#*) continue ;; esac
  [ -z "$extra" ] || {
    printf 'Invalid snapshot root: %s %s\n' "$relative_root" "$extra" >&2
    exit 1
  }
  case "$relative_root" in /*|*..*)
    printf 'Unsafe snapshot root: %s\n' "$relative_root" >&2
    exit 1
    ;;
  esac
  root="$prefix/$relative_root"
  [ -e "$root" ] || [ -L "$root" ] || continue
  find "$root" \( -path "$prefix/var/homebrew/locks" \) -prune -o -print0 > "$path_list" || exit 1
  while IFS= read -r -d '' path; do
    manifest_entry "$path" >> "$raw_output" || exit 1
  done < "$path_list"
done < "$roots_file"
LC_ALL=C sort "$raw_output" > "$output" || exit 1
