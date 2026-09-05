#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

only_version=${ONLY_VERSION:-}
release_repository=$(php_darwin_package_config release_repository)
work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-update.XXXXXX") || \
  php_darwin_die 'could not create the release update directory'
trap 'rm -rf "$work_dir"' EXIT

if [ -n "$only_version" ]; then
  php_darwin_validate_channel "$only_version" stable
  version_values=("$only_version")
else
  version_values=()
  configured_versions=$(php_darwin_configured_versions) || \
    php_darwin_die 'could not read the configured PHP versions'
  while read -r channel version; do
    [ "$channel" = stable ] && version_values+=("$version")
  done <<< "$configured_versions"
  [ "${#version_values[@]}" -gt 0 ] || php_darwin_die 'no stable PHP versions are configured'
fi

for version in "${version_values[@]}"; do
  current=$(bash "$script_dir/source-hash.sh" "$version") || \
    php_darwin_die "could not compute the PHP $version source hash"
  current_extensions=$(bash "$script_dir/extensions-source-hash.sh" "$version") || \
    php_darwin_die "could not compute the PHP $version cached extension source hash"
  manifest="$work_dir/php-$version-manifest.json"
  published=
  published_extensions=
  if ! http_status=$(php_darwin_fetch_release_manifest "$release_repository" "$version" "$manifest"); then
    php_darwin_die "could not request the PHP $version release manifest"
  fi
  case "$http_status" in
    200)
      if php_darwin_validate_release_manifest "$manifest" "$version" stable 2>/dev/null; then
        published=$(jq -er '.source_hash' "$manifest") || \
          php_darwin_die "could not read the PHP $version published source hash"
        published_extensions=$(bash "$script_dir/manifest-extensions-source-hash.sh" "$manifest" "$version") || \
          php_darwin_die "could not read the PHP $version published cached extension source hash"
      fi
      ;;
    404) ;;
    *) php_darwin_die "could not fetch the PHP $version release manifest (HTTP $http_status)" ;;
  esac
  if [ "$published" = "$current" ] && [ "$published_extensions" = "$current_extensions" ]; then
    printf 'PHP %s is current (PHP %s, extensions %s)\n' "$version" "$current" "$current_extensions"
    continue
  fi

  if [ -n "$published" ]; then
    printf 'Dispatching PHP %s: published PHP source %s, current PHP source %s; published extensions %s, current extensions %s\n' \
      "$version" "$published" "$current" "${published_extensions:-missing}" "$current_extensions"
  else
    printf 'Dispatching PHP %s: no valid release manifest, current source %s\n' "$version" "$current"
  fi
  gh workflow run cache-stable.yml --repo "${GITHUB_REPOSITORY:-shivammathur/php-darwin}" \
    --ref "${GITHUB_REF_NAME:-main}" -f php-version="$version" -f builds='debug release' \
    -f ts='nts zts' -f publish=true || exit 1
done
