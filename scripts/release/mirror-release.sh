#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib/lib.sh
. "$script_dir/../lib/lib.sh"
staging=${1:?release staging directory required}
mode=${2:-all}
case "$mode" in all|installer-only) ;; *) php_darwin_die "invalid mirror mode: $mode" ;; esac
version=${PHP_VERSION:?}
php_darwin_validate_version "$version"
tag=php-$version
manifest="$staging/$tag-manifest.json"
php_darwin_validate_release_manifest "$manifest" "$version" >/dev/null
[ -s "$staging/install.sh" ] || php_darwin_die 'release installer is missing'
bash -n "$staging/install.sh"
[ -n "${CF_R2_AWS_ACCESS_KEY_ID:-}" ] && [ -n "${CF_R2_AWS_SECRET_ACCESS_KEY:-}" ] &&
  [ -n "${CF_R2_AWS_S3_ENDPOINT:-}" ] || php_darwin_die 'Cloudflare credentials are required'
mirror=$(php_darwin_release_mirror shivammathur/php-darwin "$version")
[ -n "$mirror" ] || php_darwin_die 'the release mirror URL is empty'
node "$script_dir/mirror-release.cjs" "$staging" "$version" "$mirror" "$mode"
