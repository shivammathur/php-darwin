#!/usr/bin/env bash

php_darwin_root=${PHP_DARWIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}

php_darwin_read_config() {
  cat "$php_darwin_root/conf/$1"
}

php_darwin_die() {
  if [ -n "${PHP_DARWIN_PHASE:-}" ]; then
    printf 'php-darwin: %s failed: %s\n' "$PHP_DARWIN_PHASE" "$*" >&2
  else
    printf 'php-darwin: %s\n' "$*" >&2
  fi
  exit 1
}

php_darwin_set_phase() {
  PHP_DARWIN_PHASE=$1
}

php_darwin_validate_version() {
  local requested_version=${1:-}
  local configured_channel
  local configured_version
  local extra

  while read -r configured_channel configured_version extra; do
    [ -n "$configured_channel" ] || continue
    case "$configured_channel" in \#*) continue ;; esac
    if [ "$configured_version" = "$requested_version" ]; then
      return 0
    fi
  done < <(php_darwin_read_config versions)
  php_darwin_die "unsupported PHP version: ${requested_version:-<empty>}"
}

php_darwin_version_channel() {
  local requested_version=${1:-}
  local configured_channel
  local configured_version
  local extra

  while read -r configured_channel configured_version extra; do
    [ -n "$configured_channel" ] || continue
    case "$configured_channel" in \#*) continue ;; esac
    if [ "$configured_version" = "$requested_version" ]; then
      printf '%s\n' "$configured_channel"
      return 0
    fi
  done < <(php_darwin_read_config versions)
  php_darwin_die "unsupported PHP version: ${requested_version:-<empty>}"
}

php_darwin_validate_channel() {
  local version=${1:-}
  local expected=${2:-}
  local actual

  case "$expected" in stable|nightly) ;; *) php_darwin_die "unsupported release channel: ${expected:-<empty>}" ;; esac
  actual=$(php_darwin_version_channel "$version")
  [ "$actual" = "$expected" ] || php_darwin_die "PHP $version is $actual, not $expected"
}

php_darwin_validate_build() {
  case "${1:-}" in
    release|debug) ;;
    *) php_darwin_die "build must be release or debug: ${1:-<empty>}" ;;
  esac
}

php_darwin_validate_ts() {
  case "${1:-}" in
    nts|zts) ;;
    *) php_darwin_die "thread safety must be nts or zts: ${1:-<empty>}" ;;
  esac
}

php_darwin_normalize_arch() {
  case "${1:-$(uname -m)}" in
    arm64|aarch64) printf 'arm64\n' ;;
    x86_64|amd64) printf 'x86_64\n' ;;
    *) php_darwin_die "unsupported architecture: ${1:-<empty>}" ;;
  esac
}

php_darwin_expected_prefix() {
  jq -er --arg arch "$(php_darwin_normalize_arch "${1:-}")" '.[$arch].brew_prefix' \
    < <(php_darwin_read_config platforms.json) || php_darwin_die 'Homebrew prefix is not configured'
}

php_darwin_package_config() {
  jq -er --arg key "$1" '.[$key]' < <(php_darwin_read_config package.json) || \
    php_darwin_die "package configuration is missing: $1"
}

php_darwin_formula_suffix() {
  local build=${1:-release}
  local ts=${2:-nts}
  local suffix=

  php_darwin_validate_build "$build"
  php_darwin_validate_ts "$ts"
  [ "$build" = debug ] && suffix=-debug
  [ "$ts" = zts ] && suffix="$suffix-zts"
  printf '%s\n' "$suffix"
}

php_darwin_formula() {
  local version=$1
  local current_version=${4:-}
  local suffix

  php_darwin_validate_version "$version"
  suffix=$(php_darwin_formula_suffix "${2:-release}" "${3:-nts}")
  [ -n "$current_version" ] || current_version=$(php_darwin_package_config current_version)
  if [ "$version" = "$current_version" ]; then
    printf 'php%s\n' "$suffix"
  else
    printf 'php@%s%s\n' "$version" "$suffix"
  fi
}

php_darwin_requested_formula() {
  local version=$1
  local suffix

  php_darwin_validate_version "$version"
  suffix=$(php_darwin_formula_suffix "${2:-release}" "${3:-nts}")
  printf 'php@%s%s\n' "$version" "$suffix"
}

php_darwin_pear_path() {
  local version=$1
  local formula=$2
  local formula_version

  php_darwin_validate_version "$version"
  case "$formula" in
    php@*)
      formula_version=${formula#php@}
      case "$formula_version" in
        "$version"|"$version-debug"|"$version-zts"|"$version-debug-zts") ;;
        *) php_darwin_die "invalid versioned PHP formula for PEAR state: $formula" ;;
      esac
      printf 'share/pear@%s\n' "$formula_version"
      ;;
    php|php-debug|php-zts|php-debug-zts) printf 'share/pear\n' ;;
    *) php_darwin_die "invalid PHP formula for PEAR state: $formula" ;;
  esac
}

php_darwin_config_id() {
  local version=$1
  local suffix

  php_darwin_validate_version "$version"
  suffix=$(php_darwin_formula_suffix "${2:-release}" "${3:-nts}")
  printf '%s%s\n' "$version" "$suffix"
}

php_darwin_metadata_path() {
  local asset=$1

  [[ "$asset" =~ ^php_[0-9]+\.[0-9]+-(nts|zts)-(debug|release)\+darwin_(arm64|x86_64)\.tar\.zst$ ]] || \
    php_darwin_die "invalid cache archive name: $asset"
  printf 'var/php-darwin/%s.json\n' "${asset%.tar.zst}"
}

php_darwin_postinstall_paths() {
  local version=$1
  local formula=$2
  local config_id
  local scope
  local configured_path
  local extra

  php_darwin_validate_version "$version"
  config_id=$(php_darwin_config_id "$version" "${3:-release}" "${4:-nts}")
  while read -r scope configured_path extra; do
    [ -n "$scope" ] || continue
    case "$scope" in \#*) continue ;; esac
    [ -z "$extra" ] || php_darwin_die "invalid post-install path: $scope $configured_path $extra"
    case "$scope" in
      all) ;;
      versioned) [[ "$formula" = php@* ]] || continue ;;
      *) php_darwin_die "invalid post-install path scope: $scope" ;;
    esac
    configured_path=${configured_path//\{config\}/$config_id}
    case "$configured_path" in
      "etc/php/$config_id/"*) printf '%s\n' "$configured_path" ;;
      *) php_darwin_die "unsafe post-install path: $configured_path" ;;
    esac
  done < <(php_darwin_read_config postinstall-paths)
}

php_darwin_asset() {
  local version=$1
  local version_major
  local version_minor
  local build=${2:-release}
  local ts=${3:-nts}
  local arch

  IFS=. read -r version_major version_minor _ <<< "$version"
  php_darwin_validate_version "$version_major.$version_minor"
  php_darwin_validate_build "$build"
  php_darwin_validate_ts "$ts"
  arch=$(php_darwin_normalize_arch "${4:-}")
  printf 'php_%s-%s-%s+darwin_%s.tar.zst\n' "$version" "$ts" "$build" "$arch"
}

php_darwin_sha256() {
  local hash_output

  if command -v sha256sum >/dev/null 2>&1; then
    hash_output=$(sha256sum "$1") || return 1
  else
    hash_output=$(shasum -a 256 "$1") || return 1
  fi
  printf '%s\n' "${hash_output%% *}"
}
