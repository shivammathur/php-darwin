#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

tap_path=${1:?}
version=${2:?}
expected_hash=${3:-}
repository=${4:?}
expected_commit=${5:-}
expected_branch=${6:-}

[ -d "$tap_path/.git" ] || {
  printf 'Homebrew tap is not a Git repository: %s\n' "$tap_path" >&2
  exit 1
}
actual_repository=$(git -C "$tap_path" remote get-url origin) || exit 1
actual_repository=${actual_repository%.git}
[ "$actual_repository" = "${repository%.git}" ] || {
  printf 'Homebrew tap origin mismatch: %s\n' "$actual_repository" >&2
  exit 1
}
if [ -n "$expected_commit" ]; then
  actual_commit=$(git -C "$tap_path" rev-parse HEAD) || exit 1
  [ "$actual_commit" = "$expected_commit" ] || {
    printf 'Homebrew tap commit mismatch: %s\n' "$actual_commit" >&2
    exit 1
  }
fi
if [ -n "$expected_branch" ]; then
  actual_branch=$(git -C "$tap_path" symbolic-ref --short HEAD) || exit 1
  [ "$actual_branch" = "$expected_branch" ] || {
    printf 'Homebrew tap branch mismatch: %s\n' "$actual_branch" >&2
    exit 1
  }
  [ "$(git -C "$tap_path" rev-parse "refs/remotes/origin/$expected_branch")" = "$expected_commit" ] || {
    printf 'Homebrew tap remote branch does not match its snapshot commit\n' >&2
    exit 1
  }
  [ -z "$(git -C "$tap_path" status --porcelain --untracked-files=all)" ] || {
    printf 'Homebrew tap snapshot has changed or untracked files\n' >&2
    exit 1
  }
fi
if [ -n "$expected_hash" ]; then
  actual_hash=$(HOMEBREW_PHP_PATH="$tap_path" bash "$script_dir/source-hash.sh" "$version") || exit 1
  [ "$actual_hash" = "$expected_hash" ] || {
    printf 'Homebrew tap formula hash mismatch\n' >&2
    exit 1
  }
  printf '%s\n' "$actual_hash"
fi
