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
  while read -r channel version extra; do
    [ -n "$channel" ] || continue
    case "$channel" in \#*) continue ;; esac
    [ -z "$extra" ] || php_darwin_die "invalid version configuration for PHP $version"
    [ "$channel" = stable ] && version_values+=("$version")
  done < "$script_dir/../conf/versions"
fi

for version in "${version_values[@]}"; do
  current=$(bash "$script_dir/source-hash.sh" "$version") || \
    php_darwin_die "could not compute the PHP $version source hash"
  manifest="$work_dir/php-$version-manifest.json"
  manifest_url="https://github.com/$release_repository/releases/download/php-$version/php-$version-manifest.json?cache=$(date +%s)"
  published=
  if ! http_status=$(curl --retry 3 -sSL -w '%{http_code}' "$manifest_url" -o "$manifest"); then
    php_darwin_die "could not request the PHP $version release manifest"
  fi
  case "$http_status" in
    200)
      if php_darwin_validate_release_manifest "$manifest" "$version" stable 2>/dev/null; then
        published=$(jq -er '.source_hash' "$manifest") || \
          php_darwin_die "could not read the PHP $version published source hash"
      fi
      ;;
    404) ;;
    *) php_darwin_die "could not fetch the PHP $version release manifest (HTTP $http_status)" ;;
  esac
  if [ "$published" = "$current" ]; then
    printf 'PHP %s is current (%s)\n' "$version" "$current"
    continue
  fi

  if [ -n "$published" ]; then
    printf 'Dispatching PHP %s: published source %s, current source %s\n' "$version" "$published" "$current"
  else
    printf 'Dispatching PHP %s: no valid release manifest, current source %s\n' "$version" "$current"
  fi
  gh workflow run cache-stable.yml --repo "${GITHUB_REPOSITORY:-shivammathur/php-darwin}" \
    --ref "${GITHUB_REF_NAME:-main}" -f php-version="$version" -f builds='debug release' \
    -f ts='nts zts' -f publish=true || exit 1
done
