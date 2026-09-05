#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

version=${PHP_VERSION:-}
[ -n "$version" ] || version=$(php_darwin_nightly_version) || exit 1
force=${FORCE:-false}
manifest_override=${PHP_DARWIN_MANIFEST_PATH:-}
release_repository=$(php_darwin_package_config release_repository)
work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-nightly-update.XXXXXX") || \
  php_darwin_die 'could not create the nightly update directory'
trap 'rm -rf "$work_dir"' EXIT
manifest="$work_dir/php-$version-manifest.json"

php_darwin_validate_channel "$version" nightly
case "$force" in true|false) ;; *) php_darwin_die "force must be true or false: $force" ;; esac
current=$(bash "$script_dir/php-src-commit.sh" "$version") || \
  php_darwin_die "could not resolve the PHP $version source commit"
current_extensions=$(bash "$script_dir/extensions-source-hash.sh" "$version") || \
  php_darwin_die "could not resolve the PHP $version cached extension source hash"
published=
published_extensions=

if [ -n "$manifest_override" ]; then
  [ -f "$manifest_override" ] || php_darwin_die "nightly manifest not found: $manifest_override"
  cp "$manifest_override" "$manifest" || php_darwin_die 'could not copy the nightly manifest fixture'
  http_status=200
else
  if ! http_status=$(php_darwin_fetch_release_manifest "$release_repository" "$version" "$manifest"); then
    php_darwin_die "could not request the PHP $version release manifest"
  fi
fi

case "$http_status" in
  200)
    if php_darwin_validate_release_manifest "$manifest" "$version" nightly 2>/dev/null; then
      published=$(jq -er '.php_src_commit' "$manifest") || \
        php_darwin_die "could not read the PHP $version published source commit"
      published_extensions=$(bash "$script_dir/manifest-extensions-source-hash.sh" "$manifest" "$version") || \
        php_darwin_die "could not read the PHP $version published cached extension source hash"
    fi
    ;;
  404) ;;
  *) php_darwin_die "could not fetch the PHP $version release manifest (HTTP $http_status)" ;;
esac

build=false
if [ "$force" = true ] || [ "$published" != "$current" ] || \
  [ "$published_extensions" != "$current_extensions" ]; then
  build=true
fi
if [ "$build" = true ]; then
  if [ -n "$published" ]; then
    printf 'PHP %s nightly changed: php-src %s to %s; extensions %s to %s\n' \
      "$version" "$published" "$current" "${published_extensions:-missing}" "$current_extensions"
  else
    printf 'PHP %s nightly has no valid published source commit; current commit is %s\n' "$version" "$current"
  fi
else
  printf 'PHP %s nightly is current (php-src %s, extensions %s)\n' \
    "$version" "$current" "$current_extensions"
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  printf 'build=%s\nphp-src-commit=%s\nphp-version=%s\n' "$build" "$current" "$version" >> "$GITHUB_OUTPUT" || \
    php_darwin_die 'could not write nightly freshness outputs'
fi
