#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$script_dir/../.." && pwd)
manifest=${1:?}
output=${2:?}
work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-intel-install.XXXXXX") || exit 1
trap 'rm -rf "$work_dir"' EXIT
generated="$work_dir/install.sh"
staged="$work_dir/intel-install.sh"

PHP_DARWIN_RELEASE_MANIFEST="$manifest" bash "$root/scripts/generate-install.sh" "$generated" >/dev/null || exit 1
awk '
  NR == 1 {
    print
    print "export PHP_DARWIN_BACKEND=intel"
    print "export PHP_DARWIN_RELEASE_TAG_SUFFIX=-intel-poc"
    next
  }
  { print }
' "$generated" > "$staged" || exit 1
bash -n "$staged" || exit 1
chmod 0755 "$staged" || exit 1
mkdir -p "${output%/*}" || exit 1
mv "$staged" "$output" || exit 1
