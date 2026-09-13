#!/usr/bin/env bash
set -euo pipefail

[ "${GITHUB_ACTIONS:-}" = true ] || { printf 'Native source cache tests require an Actions runner\n' >&2; exit 1; }
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_FROM_API=1 HOMEBREW_NO_INSTALL_CLEANUP=1
export HOMEBREW_NO_AUTOREMOVE=1 HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1
tap=php-darwin/source-cache-test
library="$tap/php-darwin-cache-lib"
app="$tap/php-darwin-cache-app"
fixtures="${GITHUB_WORKSPACE:?}/.source-cache-fixtures"

case "${1:?}" in
  prepare)
    mkdir -p "$fixtures"
    python3 - "$fixtures" <<'PY'
import gzip, io, pathlib, sys, tarfile
root = pathlib.Path(sys.argv[1])
files = {
    'library.c': b'int cached_value(void) { return 42; }\n',
    'library.h': b'int cached_value(void);\n',
    'app.c': b'#include <stdio.h>\n#include "library.h"\nint main(void) { printf("%d\\n", cached_value()); return cached_value() != 42; }\n',
}
with gzip.GzipFile(filename=str(root/'source.tar.gz'), mode='wb', mtime=0) as gz:
    with tarfile.open(fileobj=gz, mode='w') as archive:
        for name, contents in sorted(files.items()):
            info = tarfile.TarInfo('source/' + name)
            info.size = len(contents)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(contents))
PY
    source_hash=$(shasum -a 256 "$fixtures/source.tar.gz" | awk '{print $1}')
    brew tap-new --no-git "$tap"
    tap_path=$(brew --repository "$tap")
    cat > "$tap_path/Formula/php-darwin-cache-lib.rb" <<EOF
class PhpDarwinCacheLib < Formula
  desc "Source bottle cache test library"
  homepage "https://github.com/shivammathur/php-darwin"
  url "file://$fixtures/source.tar.gz"
  version "1.0.0"
  sha256 "$source_hash"
  license "MIT"
  def install
    system ENV.cc, "-dynamiclib", "library.c", "-o", "libcachedvalue.dylib",
           "-install_name", "#{opt_lib}/libcachedvalue.dylib"
    lib.install "libcachedvalue.dylib"
    include.install "library.h"
  end
end
EOF
    cat > "$tap_path/Formula/php-darwin-cache-app.rb" <<EOF
class PhpDarwinCacheApp < Formula
  desc "Source bottle cache test consumer"
  homepage "https://github.com/shivammathur/php-darwin"
  url "file://$fixtures/source.tar.gz"
  version "1.0.0"
  sha256 "$source_hash"
  license "MIT"
  depends_on "$library"
  def install
    dependency = Formula["$library"]
    system ENV.cc, "app.c", "-I#{dependency.opt_include}", "-L#{dependency.opt_lib}",
           "-lcachedvalue", "-o", "php-darwin-cache-app"
    bin.install "php-darwin-cache-app"
  end
  def post_install
    (var/"php-darwin-source-cache-test").mkpath
    (var/"php-darwin-source-cache-test/postinstall").write "ready"
  end
end
EOF
    brew trust "$tap"
    ;;
  verify)
    [ "$("$(brew --prefix "$app")/bin/php-darwin-cache-app")" = 42 ]
    [ "$(cat "$(brew --prefix)/var/php-darwin-source-cache-test/postinstall")" = ready ]
    brew linkage --test "$app" "$library"
    # Verify the actual native packages, not just cache status messages.
    while IFS= read -r -d '' bottle; do
      tar -tzf "$bottle" > "$fixtures/bottle-contents.txt"
      grep -q 'INSTALL_RECEIPT.json' "$fixtures/bottle-contents.txt"
      grep -q '/.brew/.*\.rb' "$fixtures/bottle-contents.txt"
    done < <(find .source-bottle-cache -name '*.tar.gz' -print0)
    ;;
  reset)
    brew uninstall --force --ignore-dependencies "$app" "$library"
    rm -rf .source-bottle-cache
    rm -f "$(brew --prefix)/var/php-darwin-source-cache-test/postinstall"
    ;;
  bump)
    tap_path=$(brew --repository "$tap")
    sed -i '' 's/version "1.0.0"/version "1.0.1"/' "$tap_path/Formula/php-darwin-cache-app.rb"
    ;;
  cleanup)
    brew uninstall --force --ignore-dependencies "$app" "$library" || true
    brew untap --force "$tap" || true
    rm -rf "$(brew --prefix)/var/php-darwin-source-cache-test"
    ;;
  *) exit 1 ;;
esac
