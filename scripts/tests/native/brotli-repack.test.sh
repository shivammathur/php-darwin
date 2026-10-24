#!/usr/bin/env bash
set -euo pipefail
source scripts/lib/lib.sh
export ARCHIVE_DIR="$PWD/builds/$ARCH"
export PHP_DARWIN_EXTENSIONS=''
export PHP_DARWIN_TEST_PREVIOUS_INSTALLER=true
export PHP_DARWIN_TEST_WARM=true
bash scripts/build/cleanup-taps.sh
bash scripts/build/check-homebrew.sh
for BUILD in release debug; do
  for TS in nts zts; do
    export BUILD TS
    cleanup() { bash scripts/tests/native/install.test.sh reset; }
    trap cleanup EXIT
    bash scripts/tests/native/install.test.sh all
    prefix=$(brew --prefix)
    formula=$(php_darwin_formula "$PHP_VERSION" "$BUILD" "$TS")
    python3 scripts/tests/native/brotli-repack.test.py "$prefix" "$prefix/opt/$formula/bin/php"
    cleanup
    trap - EXIT
  done
done
