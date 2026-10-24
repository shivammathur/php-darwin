#!/usr/bin/env bash
set -euo pipefail
source scripts/lib/lib.sh
export ARCHIVE_DIR="$PWD/builds/$ARCH"
export PHP_DARWIN_EXTENSIONS=''
export PHP_DARWIN_TEST_PREVIOUS_INSTALLER=true
export PHP_DARWIN_TEST_WARM=true
if [ "$PHP_VERSION/$ARCH" = 8.0/x86_64 ]; then
  # The original 8.0 Intel FPM crashes in OPcache startup with JIT enabled,
  # and Xdebug, with either Brotli 1.2.0 or 1.2.1. Keep the payload/configuration unchanged.
  export PHP_DARWIN_TEST_FPM_NO_JIT=true
  echo 'Testing PHP 8.0 Intel FPM with JIT disabled for its existing OPcache/Xdebug startup failure'
fi
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
