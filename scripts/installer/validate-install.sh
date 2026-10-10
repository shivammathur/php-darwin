#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$script_dir/../.." && pwd)
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
bash "$script_dir/generate-install.sh" "$work_dir/install.sh"
cmp "$root/scripts/install.sh" "$work_dir/install.sh"
bash -n "$root/scripts/install.sh"
if grep -Eq 'PHP_DARWIN_TIMING|GITHUB_PATH|base64|PHP_DARWIN_PAYLOAD|gzip -d' "$root/scripts/install.sh"; then
  printf 'Invalid bootstrap payload\n' >&2; exit 1
fi
printf 'Bootstrap is readable and current\n'
