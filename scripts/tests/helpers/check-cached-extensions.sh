#!/usr/bin/env bash
# Check archive defaults independently of the runner configuration preserved by installation.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib/lib.sh
. "$script_dir/../../lib/lib.sh"

archive=${1:?}
metadata=${2:?}
php_bin=${3:?}
brew_prefix=${4:?}
config_id=${5:?}
[[ "$config_id" =~ ^[0-9]+\.[0-9]+(-debug)?(-zts)?$ ]] || php_darwin_die 'invalid PHP configuration ID'

config_root=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/php-darwin-defaults.XXXXXX")
trap 'rm -rf "$config_root"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# The installer has already verified the archive and its metadata. Extract the
# actual packaged INI files so this also detects accidentally enabled extensions.
jq -er --arg prefix "etc/php/$config_id/" \
  '.state_paths[] | select(startswith($prefix))' "$metadata" > "$config_root/paths.txt"
tar --ignore-zeros -xf "$archive" --no-same-owner --numeric-owner -C "$config_root" -T "$config_root/paths.txt"
config_dir="$config_root/etc/php/$config_id"
[ -f "$config_dir/php.ini" ] || php_darwin_die 'the archive PHP configuration is missing'
mkdir -p "$config_dir/conf.d"
export PHPRC="$config_dir/php.ini" PHP_INI_SCAN_DIR="$config_dir/conf.d"

while IFS=$'\t' read -r extension extension_type extension_path; do
  [ -f "$brew_prefix/$extension_path" ] && [ ! -L "$brew_prefix/$extension_path" ] || \
    php_darwin_die "the archive did not install cached $extension"
  "$php_bin" -n -d "$extension_type=$brew_prefix/$extension_path" -r \
    "if (!extension_loaded('$extension')) { exit(1); }" || \
    php_darwin_die "cached $extension failed its explicit load test"
  if ! "$php_bin" -c "$config_dir/php.ini" -r "if (extension_loaded('$extension')) { exit(1); }"; then
    "$php_bin" -c "$config_dir/php.ini" --ini >&2 || true
    php_darwin_die "$extension is enabled by default in the cache"
  fi
done < <(jq -r '(.extensions // [])[] | [.name,.type,.path] | @tsv' "$metadata")
