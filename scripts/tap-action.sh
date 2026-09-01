#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

tap_path=${1:?}
cached_tap_path=${2:?}
version=${3:?}
expected_hash=${4:?}
repository=${5:?}
cached_commit=${6:?}
expected_branch=${7:?}

bash "$script_dir/validate-tap.sh" "$tap_path" "$version" '' "$repository" '' '' true \
  >/dev/null || exit 1
actual_hash=$(HOMEBREW_PHP_PATH="$tap_path" bash "$script_dir/source-hash.sh" "$version" 2>/dev/null) || \
  actual_hash=
if [ "$actual_hash" = "$expected_hash" ]; then
  printf 'keep\n'
  exit 0
fi

existing_commit=$(git -C "$tap_path" rev-parse HEAD) || exit 1
snapshot_commit=$(git -C "$tap_path" config --get php-darwin.snapshot-commit 2>/dev/null) || \
  snapshot_commit=
if [ "$snapshot_commit" != "$existing_commit" ]; then
  [ -z "$snapshot_commit" ] && \
    [ "$(git -C "$tap_path" rev-parse --is-shallow-repository)" = true ] && \
    [ "$(git -C "$tap_path" symbolic-ref --short HEAD)" = "$expected_branch" ] && \
    [ "$(git -C "$tap_path" rev-parse "refs/remotes/origin/$expected_branch")" = "$existing_commit" ] || {
    printf 'Homebrew tap formula hash mismatch on an unmarked checkout\n' >&2
    exit 1
  }
fi
[ "$(git -C "$cached_tap_path" rev-parse HEAD)" = "$cached_commit" ] || exit 1
existing_time=$(git -C "$tap_path" show -s --format=%ct "$existing_commit") || exit 1
cached_time=$(git -C "$cached_tap_path" show -s --format=%ct "$cached_commit") || exit 1
[[ "$existing_time" =~ ^[0-9]+$ ]] && [[ "$cached_time" =~ ^[0-9]+$ ]] || exit 1
[ "$cached_time" -gt "$existing_time" ] || {
  printf 'Homebrew tap formula hash mismatch and the cached snapshot is not newer\n' >&2
  exit 1
}
printf 'replace\n'
