#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$script_dir/../.." && pwd)

export PHP_DARWIN_BACKEND=intel
export PHP_DARWIN_RELEASE_TAG_SUFFIX=-intel-poc
exec bash "$root/scripts/install-package.sh" "$@"
