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
printf 'Intel/Homebrew POC configuration is valid\n'
