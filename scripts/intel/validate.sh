#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$script_dir/../.." && pwd)
# shellcheck source=scripts/lib.sh
. "$root/scripts/lib.sh"

export PHP_DARWIN_BACKEND=intel
bash -n "$script_dir"/*.sh || php_darwin_die 'Intel shell syntax validation failed'
jq -e '
  keys == ["x86_64"] and .x86_64.brew_prefix == "/usr/local" and
  .x86_64.build_runner == "macos-15-intel" and .x86_64.minimum_macos == 15 and
  .x86_64.platform_key == "x86_64_sequoia" and
  .x86_64.test_runners == ["macos-15-intel", "macos-26-intel"]
' "$root/conf/intel-platforms.json" >/dev/null || php_darwin_die 'invalid Intel platform configuration'
[ "$(php_darwin_normalize_arch amd64)" = x86_64 ] || php_darwin_die 'Intel architecture alias failed'
[ "$(php_darwin_expected_asset_count)" -eq 1 ] || php_darwin_die 'Intel POC must contain one asset'
[ "$(php_darwin_asset 8.5 release nts x86_64)" = 'php_8.5-nts-release+darwin_x86_64.tar.zst' ] || \
  php_darwin_die 'Intel cache asset naming failed'
[ "$(php_darwin_expected_prefix x86_64)" = /usr/local ] || php_darwin_die 'Intel Homebrew prefix failed'
grep -Fq '${PHP_DARWIN_BACKEND:-homebrew}' "$root/scripts/read-metadata.sh" || \
  php_darwin_die 'metadata extraction is not gated by the Intel backend'
fixture=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-intel-validation.XXXXXX") || exit 1
trap 'rm -rf "$fixture"' EXIT
member=var/php-darwin/php_8.5-nts-release+darwin_x86_64.json
mkdir -p "$fixture/source/${member%/*}" || exit 1
printf '{}\n' > "$fixture/source/$member" || exit 1
tar -cf "$fixture/intel.tar" -C "$fixture/source" "$member" || exit 1
PHP_DARWIN_BACKEND=intel bash "$root/scripts/read-metadata.sh" \
  "$fixture/intel.tar" "$member" "$fixture/metadata.json" || \
  php_darwin_die 'Intel metadata extraction failed'
if PHP_DARWIN_BACKEND=homebrew bash "$root/scripts/read-metadata.sh" "$fixture/intel.tar" "$member" \
  "$fixture/default-metadata.json" >/dev/null 2>&1; then
  php_darwin_die 'the ARM-only metadata reader accepted Intel without the isolated backend'
fi
printf 'Intel/Homebrew POC configuration is valid\n'
