#!/usr/bin/env bash

php_darwin_macports_script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
php_darwin_macports_root=$(cd "$php_darwin_macports_script_dir/../.." && pwd)

php_darwin_macports_die() {
  printf 'php-darwin-macports: %s\n' "$*" >&2
  exit 1
}

php_darwin_macports_config() {
  local key=$1

  jq -er --arg key "$key" '.[$key]' "$php_darwin_macports_root/conf/macports.json"
}

php_darwin_macports_validate_version() {
  local version=$1

  [[ "$version" =~ ^[0-9]+\.[0-9]+$ ]] || php_darwin_macports_die "invalid PHP version: $version"
}

php_darwin_macports_validate_build() {
  case "$1" in debug|release) ;; *) php_darwin_macports_die "invalid build type: $1" ;; esac
}

php_darwin_macports_validate_ts() {
  case "$1" in nts|zts) ;; *) php_darwin_macports_die "invalid thread-safety mode: $1" ;; esac
}

php_darwin_macports_port_prefix() {
  local version=$1

  php_darwin_macports_validate_version "$version"
  printf 'php%s\n' "${version/./}"
}

php_darwin_macports_prefix() {
  local version=$1
  local build=$2
  local ts=$3
  local prefix_root

  php_darwin_macports_validate_version "$version"
  php_darwin_macports_validate_build "$build"
  php_darwin_macports_validate_ts "$ts"
  prefix_root=$(php_darwin_macports_config prefix_root) || \
    php_darwin_macports_die 'could not read the MacPorts prefix root'
  printf '%s/%s/%s-%s\n' "$prefix_root" "$version" "$ts" "$build"
}

php_darwin_macports_archive() {
  local version=$1
  local build=$2
  local ts=$3

  php_darwin_macports_validate_version "$version"
  php_darwin_macports_validate_build "$build"
  php_darwin_macports_validate_ts "$ts"
  printf 'php_%s-%s-%s+darwin_x86_64-macports.tar.zst\n' "$version" "$ts" "$build"
}

php_darwin_macports_metadata() {
  local archive

  archive=$(php_darwin_macports_archive "$1" "$2" "$3") || return 1
  printf '%s.json\n' "${archive%.tar.zst}"
}

php_darwin_macports_release_tag() {
  local version=$1
  local suffix

  php_darwin_macports_validate_version "$version"
  suffix=$(php_darwin_macports_config release_tag_suffix) || \
    php_darwin_macports_die 'could not read the Intel release suffix'
  printf 'php-%s-%s\n' "$version" "$suffix"
}

php_darwin_macports_ports() {
  local extra
  local port_prefix=$1
  local suffix
  local variants

  [[ "$port_prefix" =~ ^php[0-9]+$ ]] || php_darwin_macports_die "invalid PHP port prefix: $port_prefix"
  while read -r suffix variants extra; do
    [ -n "$suffix" ] || continue
    case "$suffix" in \#*) continue ;; esac
    [ -z "$extra" ] || php_darwin_macports_die "invalid MacPorts entry: $suffix $variants $extra"
    [[ "$suffix" =~ ^[a-z0-9_]+$ ]] || php_darwin_macports_die "invalid MacPorts suffix: $suffix"
    if [ -n "$variants" ]; then
      [[ "$variants" =~ ^\+[a-z0-9_]+$ ]] || php_darwin_macports_die "invalid MacPorts variants: $variants"
    fi
    if [ "$suffix" = php ]; then
      printf '%s\t%s\n' "$port_prefix" "$variants"
    else
      printf '%s-%s\t%s\n' "$port_prefix" "$suffix" "$variants"
    fi
  done < "$php_darwin_macports_root/conf/macports-ports"
}

php_darwin_macports_sha256() {
  shasum -a 256 "$1" | awk '{print $1}'
}
