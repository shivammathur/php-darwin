#!/usr/bin/env bash

prefix=${1:?}
output=${2:?}
roots_file=${3:?}
kegs_output=${4:?}
managed_paths_file=${5:?}
package_kegs_file=${6:?}

[ -d "$prefix" ] || {
  printf 'Missing Homebrew prefix: %s\n' "$prefix" >&2
  exit 1
}
[ -f "$roots_file" ] || {
  printf 'Missing archive roots: %s\n' "$roots_file" >&2
  exit 1
}
[ -f "$managed_paths_file" ] || {
  printf 'Missing managed archive paths: %s\n' "$managed_paths_file" >&2
  exit 1
}
[ -f "$package_kegs_file" ] || {
  printf 'Missing package keg paths: %s\n' "$package_kegs_file" >&2
  exit 1
}

append_exclusion() {
  relative_path=$1
  case "$relative_path" in *$'\n'*|*$'\r'*)
    printf 'Unsupported Homebrew path: %s\n' "$relative_path" >&2
    exit 1
    ;;
  esac
  printf '%s\n' "$relative_path" >> "$output" || exit 1
}

: > "$output" || exit 1
: > "$kegs_output" || exit 1
allowed_roots=
while IFS= read -r managed_dir extra; do
  [ -n "$managed_dir" ] || continue
  case "$managed_dir" in \#*) continue ;; esac
  [ -z "$extra" ] || {
    printf 'Invalid archive root: %s %s\n' "$managed_dir" "$extra" >&2
    exit 1
  }
  case "$managed_dir" in Cellar|Frameworks|bin|etc|include|lib|opt|sbin|share|var) ;; *)
    printf 'Unsafe archive root: %s\n' "$managed_dir" >&2
    exit 1
    ;;
  esac
  [ ! -L "$prefix/$managed_dir" ] || {
    printf 'Homebrew archive root is a symlink: %s\n' "$managed_dir" >&2
    exit 1
  }
  allowed_roots="$allowed_roots $managed_dir"
done < "$roots_file"

# The archive only contains kegs named in its package metadata. Inventory
# existing versions for those formulae instead of walking the entire Cellar.
while IFS= read -r package_keg extra; do
  [ -n "$package_keg" ] || continue
  [ -z "$extra" ] && [[ "$package_keg" =~ ^Cellar/[A-Za-z0-9@+._-]+/[^/[:space:]]+$ ]] || {
    printf 'Unsafe package keg path: %s %s\n' "$package_keg" "$extra" >&2
    exit 1
  }
  package_rack=${package_keg%/*}
  [ ! -L "$prefix/$package_rack" ] || {
    printf 'Homebrew formula rack is a symlink: %s\n' "$package_rack" >&2
    exit 1
  }
  if [ -d "$prefix/$package_rack" ]; then
    for existing_keg in "$prefix/$package_rack"/*; do
      [ -d "$existing_keg" ] && [ ! -L "$existing_keg" ] || continue
      existing_keg=${existing_keg#"$prefix"/}
      case "$existing_keg" in *$'\n'*|*$'\r'*|*$'\t'*)
        printf 'Unsupported Homebrew keg path: %s\n' "$existing_keg" >&2
        exit 1
        ;;
      esac
      printf '%s\n' "$existing_keg" >> "$kegs_output" || exit 1
    done
  fi
  if [ -e "$prefix/$package_keg" ] || [ -L "$prefix/$package_keg" ]; then
    append_exclusion "$package_keg"
  fi
done < "$package_kegs_file"

while IFS= read -r managed_path; do
  [ -n "$managed_path" ] || continue
  case "$managed_path" in /*|*'/../'*|../*|*/..|*'//'*)
    printf 'Unsafe managed archive path: %s\n' "$managed_path" >&2
    exit 1
    ;;
  esac
  managed_root=${managed_path%%/*}
  [[ "$managed_root" =~ ^[A-Za-z0-9._+-]+$ ]] || {
    printf 'Unsafe managed archive root: %s\n' "$managed_root" >&2
    exit 1
  }
  case " $allowed_roots " in *" $managed_root "*) ;; *)
    printf 'Managed archive path has a disallowed root: %s\n' "$managed_path" >&2
    exit 1
    ;;
  esac
  managed_ancestor=$managed_path
  while [[ "$managed_ancestor" == */* ]]; do
    managed_ancestor=${managed_ancestor%/*}
    if [ -L "$prefix/$managed_ancestor" ]; then
      append_exclusion "$managed_ancestor"
      break
    fi
  done
  if [ -e "$prefix/$managed_path" ] || [ -L "$prefix/$managed_path" ]; then
    append_exclusion "$managed_path"
  fi
done < "$managed_paths_file"

LC_ALL=C sort -u "$output" -o "$output" || exit 1
LC_ALL=C sort -u "$kegs_output" -o "$kegs_output" || exit 1
