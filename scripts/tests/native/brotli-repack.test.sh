#!/usr/bin/env bash
set -euo pipefail
source scripts/lib/lib.sh
export ARCHIVE_DIR="$PWD/builds/$ARCH"
export PHP_DARWIN_EXTENSIONS=''
for BUILD in release debug; do
  for TS in nts zts; do
    export BUILD TS
    cleanup() { bash scripts/tests/native/install.test.sh reset; }
    trap cleanup EXIT
    bash scripts/tests/native/install.test.sh all
    prefix=$(brew --prefix)
    formula=$(php_darwin_formula "$PHP_VERSION" "$BUILD" "$TS")
    python3 scripts/tests/native/brotli-repack.test.py "$prefix" "$prefix/opt/$formula/bin/php"
    pack="$PWD/builds/extensions/swoole-$PHP_VERSION-$BUILD-$TS-$ARCH"
    if [ -d "$pack" ]; then
      EXTENSION_PACK=swoole EXTENSION_PACK_OUTPUT="$pack" node scripts/tests/native/extension-pack.test.cjs
    fi
    cleanup
    trap - EXIT
  done
done
