#!/usr/bin/env bash
# Check archive defaults independently of the runner configuration preserved by installation.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib/lib.sh
. "$script_dir/../../lib/lib.sh"

archive=${1:?}
metadata=${2:?}
php_bin=${3:?}
_brew_prefix=${4:?}
config_id=${5:?}
[[ "$config_id" =~ ^[0-9]+\.[0-9]+(-debug)?(-zts)?$ ]] || php_darwin_die 'invalid PHP configuration ID'

config_root=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/php-darwin-defaults.XXXXXX")
trap 'rm -rf "$config_root"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# The installer preserves shared PECL modules and user configuration. Validate
# the new archive's modules and defaults independently of those older files.
jq -er --arg prefix "etc/php/$config_id/" \
  '[.state_paths[] | select(startswith($prefix))] + [(.extensions // [])[].path] | .[]' \
  "$metadata" > "$config_root/paths.txt"
tar --ignore-zeros -xf "$archive" --no-same-owner --numeric-owner -C "$config_root" -T "$config_root/paths.txt"
config_dir="$config_root/etc/php/$config_id"
[ -f "$config_dir/php.ini" ] || php_darwin_die 'the archive PHP configuration is missing'
mkdir -p "$config_dir/conf.d"
export PHPRC="$config_dir/php.ini" PHP_INI_SCAN_DIR="$config_dir/conf.d"

while IFS=$'\t' read -r extension extension_type extension_path; do
  [ -s "$config_root/$extension_path" ] && [ ! -L "$config_root/$extension_path" ] || \
    php_darwin_die "the archive is missing cached $extension"
  "$php_bin" -n -d "$extension_type=$config_root/$extension_path" -r \
    "if (!extension_loaded('$extension')) { exit(1); }" || \
    php_darwin_die "cached $extension failed its explicit load test"
  if ! "$php_bin" -c "$config_dir/php.ini" -r "if (extension_loaded('$extension')) { exit(1); }"; then
    "$php_bin" -c "$config_dir/php.ini" --ini >&2 || true
    php_darwin_die "$extension is enabled by default in the cache"
  fi
done < <(jq -r '(.extensions // [])[] | [.name,.type,.path] | @tsv' "$metadata")
