#!/usr/bin/env bash
# The producer validates metadata before checking its exact managed archive paths.
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib/lib.sh
. "$script_dir/../lib/lib.sh"
metadata=${1:?}
contents=${2:?}
work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-managed-paths.XXXXXX") || exit 1
trap 'rm -rf "$work_dir"' EXIT
asset=$(jq -er '.archive' "$metadata") || exit 1
tap_snapshot=$(php_darwin_package_config tap_snapshot) || exit 1
# Only the supported controller may be added; do not permit arbitrary var/ paths.
jq -e '.installer == {schema:1,path:"var/php-darwin/installer/install.sh"}' "$metadata" >/dev/null || \
  php_darwin_die 'archive has invalid packaged installer metadata'
managed_paths="$work_dir/verify-managed-paths.txt"
jq -r '.installer.path, .links[].path, .state_paths[], .extensions[].path, (.packages[].name | "opt/" + .)' "$metadata" \
  > "$managed_paths" || php_darwin_die 'could not create the managed archive path list'
printf '%s\n' "$(php_darwin_metadata_path "$asset")" >> "$managed_paths" || \
  php_darwin_die 'could not add the managed metadata path'
LC_ALL=C sort -u "$managed_paths" -o "$managed_paths" || \
  php_darwin_die 'could not sort managed archive paths'
missing_managed_path=$(awk '
  NR == FNR { contents[$0]=1; next }
  !($0 in contents) { print; exit }
' "$contents" "$managed_paths") || php_darwin_die 'could not compare managed paths with archive contents'
[ -z "$missing_managed_path" ] || \
  php_darwin_die "archive does not contain managed path: $missing_managed_path"
invalid_managed_path=$(awk -v pear="$(jq -r '.pear_path' "$metadata")/" -v tap="$tap_snapshot/" '
  NR == FNR { exact[$0]=1; next }
  index($0, "Cellar/") == 1 || index($0, pear) == 1 || index($0, tap) == 1 || ($0 in exact) { next }
  { print; exit }
' "$managed_paths" "$contents") || php_darwin_die 'could not validate managed archive paths'
[ -z "$invalid_managed_path" ] || \
  php_darwin_die "archive contains an unmanaged path: $invalid_managed_path"
