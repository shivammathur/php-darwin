#!/usr/bin/env bash

# Shared by native fixtures and release E2E tests; never shipped to clients.
php_darwin_fetch_published_installer() {
  local version=$1 destination=$2 release_repository mirror url status
  local urls=()
  php_darwin_validate_version "$version"
  release_repository=$(php_darwin_package_config release_repository) || return 1
  mirror=$(php_darwin_release_mirror "$release_repository" "$version") || return 1
  urls=("https://github.com/$release_repository/releases/download/php-$version/install.sh")
  if [ -n "$mirror" ]; then
    if [ "${PHP_DARWIN_PREFER_MIRROR:-false}" = true ]; then
      urls=("$mirror/install.sh" "${urls[@]}")
    else
      urls+=("$mirror/install.sh")
    fi
  fi
  for url in "${urls[@]}"; do
    status=$(php_darwin_request_release "$url" "$destination") || status=000
    if [ "$status" = 200 ] && [ -s "$destination" ] && bash -n "$destination"; then
      return 0
    fi
  done
  return 1
}
