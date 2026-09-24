#!/usr/bin/env bash
set -euo pipefail

[ "${GITHUB_ACTIONS:-}" = true ] || { printf 'Extension source cache tests require an Actions runner\n' >&2; exit 1; }
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib/lib.sh
. "$script_dir/../../lib/lib.sh"
php_darwin_configure_homebrew_environment
formula=$(php_darwin_formula "${PHP_VERSION:?}" "${BUILD:?}" "${TS:?}")
brew_prefix=$(brew --prefix)
pin_dir="${RUNNER_TEMP:?}/php-darwin-extension-test-pins"

case "${1:?}" in
  prepare)
    brew install --verbose jq zstd
    # Reuse the published PHP archive so these tests compile only extensions.
    # Builds leave a detached tap at their pinned revision. Let the archive
    # supply its matching tap, while preserving every installed PHP keg.
    tap=$(php_darwin_package_config tap)
    tap_path=$(php_darwin_tap_repository_path "$tap")
    if [ -d "$tap_path" ]; then
      HOMEBREW_DEVELOPER=1 brew untap "$tap"
    fi
    PHP_DARWIN_PREFER_MIRROR=true bash "$script_dir/../../install.sh" "$PHP_VERSION" "$BUILD" "$TS"
    # Match build.sh: keep the installed dependency versions used by this PHP
    # archive instead of letting extension installation upgrade the whole graph.
    mkdir -p "$pin_dir"
    brew list --pinned | LC_ALL=C sort -u > "$pin_dir/before"
    {
      brew deps --include-build --installed --formula "$formula"
      printf '%s\n' "$formula" autoconf pkgconf
    } | sed 's|.*/||' | LC_ALL=C sort -u > "$pin_dir/dependencies"
    brew list --formula | LC_ALL=C sort -u > "$pin_dir/installed"
    LC_ALL=C comm -12 "$pin_dir/dependencies" "$pin_dir/installed" > "$pin_dir/preserve"
    pins=()
    while IFS= read -r dependency; do pins+=("$dependency"); done < "$pin_dir/preserve"
    brew info --json=v2 --formula "${pins[@]}" | \
      jq -r '.formulae[] | select(.outdated == false) | .name' | LC_ALL=C sort -u > "$pin_dir/current"
    LC_ALL=C comm -23 "$pin_dir/current" "$pin_dir/before" > "$pin_dir/added"
    pins=()
    while IFS= read -r dependency; do pins+=("$dependency"); done < "$pin_dir/added"
    [ "${#pins[@]}" -eq 0 ] || brew pin --formula "${pins[@]}"
    brew tap shivammathur/extensions
    brew trust shivammathur/extensions
    tap_path=$(brew --repository shivammathur/extensions)
    printf 'HOMEBREW_EXTENSIONS_COMMIT=%s\n' "$(git -C "$tap_path" rev-parse HEAD)" >> "$GITHUB_ENV"
    ;;
  verify)
    python3 - "$formula" "$BUILD" "$TS" <<'PY'
import hashlib, json, pathlib, sys, tarfile
formula, build, ts = sys.argv[1:]
seen = set()
for file in pathlib.Path('.source-bottle-cache').glob('*/metadata.json'):
    metadata = json.loads(file.read_text())
    inputs = metadata['inputs']
    if 'context' not in inputs:
        continue
    assert inputs['context']['build'] == build and inputs['context']['ts'] == ts
    assert inputs['context']['php']['api']
    assert any(dep['name'] == 'shivammathur/php/' + formula for dep in inputs['dependencies']), inputs
    # These are PHP's build dependencies, unnecessary for an extension using
    # the installed PHP binary and headers. Previously this compiled LLVM.
    assert not any(dep['name'] in {'llvm', 're2c', 'httpd'} for dep in inputs['dependencies']), inputs
    bottle = file.parent / metadata['file']
    assert hashlib.sha256(bottle.read_bytes()).hexdigest() == metadata['sha256']
    extension = inputs['formula'].split('/')[-1].split('@')[0]
    with tarfile.open(bottle) as archive:
        assert any(name.endswith('/' + extension + '.so') for name in archive.getnames())
        assert any(name.endswith('/INSTALL_RECEIPT.json') for name in archive.getnames())
    seen.add(extension)
assert seen == {'xdebug', 'pcov'}, seen
PY
    extension_dir=$("$brew_prefix/opt/$formula/bin/php-config" --extension-dir)
    for extension in xdebug pcov; do
      otool -L "$extension_dir/$extension.so"
      shasum -a 256 "$extension_dir/$extension.so"
    done
    ;;
  reset)
    # build-extensions.sh already removed the temporary formulae. Clearing the
    # working cache ensures the next install reads the GitHub Release assets.
    rm -rf .source-bottle-cache
    ;;
  cleanup)
    pins=()
    if [ -f "$pin_dir/added" ]; then
      while IFS= read -r dependency; do pins+=("$dependency"); done < "$pin_dir/added"
      [ "${#pins[@]}" -eq 0 ] || brew unpin --formula "${pins[@]}"
      brew list --pinned | LC_ALL=C sort -u > "$pin_dir/after"
      cmp "$pin_dir/before" "$pin_dir/after"
    fi
    rm -rf "$pin_dir"
    ;;
  *) exit 1 ;;
esac
