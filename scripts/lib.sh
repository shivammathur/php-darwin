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

php_darwin_prepare_tap_path() {
  local tap_path=$1
  local backup_path=$2

  if [ -e "$backup_path" ] || [ -L "$backup_path" ]; then
    printf 'Homebrew tap backup path already exists: %s\n' "$backup_path" >&2
    return 1
  fi
  if [ ! -e "$tap_path" ] && [ ! -L "$tap_path" ]; then
    printf 'absent\n'
    return 0
  fi
  if [ -L "$tap_path" ]; then
    printf 'Homebrew tap path is a symlink: %s\n' "$tap_path" >&2
    return 1
  fi
  if [ ! -d "$tap_path" ]; then
    printf 'Homebrew tap path is not a directory: %s\n' "$tap_path" >&2
    return 1
  fi
  if [ -d "$tap_path/.git" ] && [ ! -L "$tap_path/.git" ]; then
    printf 'git\n'
    return 0
  fi
  if ! mv "$tap_path" "$backup_path" 2>/dev/null; then
    command -v sudo >/dev/null 2>&1 || return 1
    sudo -n mv "$tap_path" "$backup_path" || return 1
  fi
  printf 'backed-up\n'
}

php_darwin_restore_tap_path() {
  local tap_path=$1
  local backup_path=$2

  [ -d "$backup_path" ] && [ ! -L "$backup_path" ] || {
    printf 'Homebrew tap backup is not a directory: %s\n' "$backup_path" >&2
    return 1
  }
  if [ -e "$tap_path" ] || [ -L "$tap_path" ]; then
    printf 'Homebrew tap path exists during restore: %s\n' "$tap_path" >&2
    return 1
  fi
  mkdir -p "${tap_path%/*}" || return 1
  if ! mv "$backup_path" "$tap_path" 2>/dev/null; then
    command -v sudo >/dev/null 2>&1 || return 1
    sudo -n mv "$backup_path" "$tap_path"
  fi
}

php_darwin_tap_backup_path() {
  local brew_prefix=$1
  local tap_path=$2
  local tmp_dir=$3
  local backup_root="$brew_prefix/var/php-darwin"
  local tmp_name=${tmp_dir##*/}
  local tmp_suffix

  case "$tap_path" in
    "$brew_prefix/Library/Taps/"*|"$brew_prefix/Homebrew/Library/Taps/"*) ;;
    *)
      printf 'Invalid Homebrew tap path: %s\n' "$tap_path" >&2
      return 1
      ;;
  esac
  [ -d "$backup_root" ] && [ ! -L "$backup_root" ] || {
    printf 'Invalid php-darwin backup directory: %s\n' "$backup_root" >&2
    return 1
  }
  case "$tmp_name" in
    php-darwin-install.*) tmp_suffix=${tmp_name#php-darwin-install.} ;;
    *)
      printf 'Invalid php-darwin installation directory: %s\n' "$tmp_dir" >&2
      return 1
      ;;
  esac
  case "$tmp_suffix" in ''|*[!A-Za-z0-9]*)
    printf 'Invalid php-darwin installation directory: %s\n' "$tmp_dir" >&2
    return 1
    ;;
  esac
  printf '%s/tap-backup.%s\n' "$backup_root" "$tmp_name"
}

php_darwin_remove_tap_backup() {
  local brew_prefix=$1
  local backup_path=$2
  local backup_prefix="$brew_prefix/var/php-darwin/tap-backup.php-darwin-install."
  local backup_suffix

  case "$backup_path" in
    "$backup_prefix"*) backup_suffix=${backup_path#"$backup_prefix"} ;;
    *)
      printf 'Unsafe Homebrew tap backup path: %s\n' "$backup_path" >&2
      return 1
      ;;
  esac
  case "$backup_suffix" in ''|*[!A-Za-z0-9]*)
    printf 'Unsafe Homebrew tap backup path: %s\n' "$backup_path" >&2
    return 1
    ;;
  esac
  [ -d "$backup_path" ] && [ ! -L "$backup_path" ] || {
    printf 'Homebrew tap backup is not a directory: %s\n' "$backup_path" >&2
    return 1
  }
  if find "$backup_path" -mindepth 1 -delete >/dev/null 2>&1 && \
    rmdir "$backup_path" >/dev/null 2>&1; then
    return 0
  fi
  command -v sudo >/dev/null 2>&1 || return 1
  sudo -n find "$backup_path" -mindepth 1 -delete && sudo -n rmdir "$backup_path"
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

php_darwin_current_version() {
  php_darwin_package_config current_version
}

php_darwin_nightly_version() {
  local channel
  local configured_version
  local extra
  local nightly_version=

  while read -r channel configured_version extra; do
    [ -n "$channel" ] || continue
    case "$channel" in \#*) continue ;; esac
    [ -z "$extra" ] || php_darwin_die "invalid version configuration for PHP $configured_version"
    [ "$channel" = nightly ] || continue
    [ -z "$nightly_version" ] || php_darwin_die 'multiple nightly PHP versions are configured'
    nightly_version=$configured_version
  done < <(php_darwin_read_config versions)
  [ -n "$nightly_version" ] || php_darwin_die 'no nightly PHP version is configured'
  printf '%s\n' "$nightly_version"
}

php_darwin_expected_asset_count() {
  local platform_count
  local variant_count

  variant_count=$(awk '!/^#/ && NF == 2 { count++ } END { print count+0 }' \
    < <(php_darwin_read_config variants)) || php_darwin_die 'could not count configured variants'
  platform_count=$(jq -er 'keys | length | select(. > 0)' \
    < <(php_darwin_read_config platforms.json)) || php_darwin_die 'could not count configured platforms'
  printf '%s\n' "$((variant_count * platform_count))"
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

  [[ "$asset" =~ ^php_[0-9]+\.[0-9]+-(nts|zts)-(debug|release)\+darwin_arm64\.tar\.zst$ ]] || \
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

php_darwin_checksum_from_file() {
  local checksum_file=$1
  local asset=$2

  [ -f "$checksum_file" ] || {
    printf 'Checksum file not found: %s\n' "$checksum_file" >&2
    return 1
  }
  awk -v name="$asset" '
    !NF { next }
    NF != 2 || $1 !~ /^[0-9a-f]+$/ || length($1) != 64 { invalid=1; next }
    $2 == name { matches++; hash=$1 }
    END {
      if (invalid || matches != 1) exit 1
      print hash
    }
  ' "$checksum_file"
}

php_darwin_validate_release_manifest() {
  local manifest=$1
  local version=$2
  local channel=${3:-$(php_darwin_version_channel "$version")}
  local asset=${4:-}
  local expected_count
  local manifest_result
  local platforms

  case "$channel" in stable|nightly) ;; *) return 1 ;; esac
  [ "$(php_darwin_version_channel "$version")" = "$channel" ] || return 1
  expected_count=$(php_darwin_expected_asset_count)
  platforms=$(php_darwin_read_config platforms.json) || return 1
  manifest_result=$(jq -er --arg channel "$channel" --arg version "$version" \
    --arg asset "$asset" --argjson count "$expected_count" --argjson platforms "$platforms" '
    select(.schema == 1 and .php_version == $version and
    (.homebrew_php_commit | type == "string" and test("^[0-9a-f]{40}$")) and
    (.source_hash | type == "string" and test("^[0-9a-f]{64}$")) and
    (.php_semver | type == "string" and startswith($version + ".") and
      test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) and
    (if $channel == "nightly" then
       (.php_src_commit | type == "string" and test("^[0-9a-f]{40}$"))
     else
       (.php_src_commit == "" or .php_src_commit == null)
     end) and
    (.assets | type == "array" and length == $count) and
    ([.assets[].name] | unique | length) == (.assets | length) and
    all(.assets[];
      .architecture as $architecture |
      ($architecture == "arm64") and
      (.build == "debug" or .build == "release") and
      (.thread_safety == "nts" or .thread_safety == "zts") and
      .name == ("php_" + $version + "-" + .thread_safety + "-" + .build +
        "+darwin_" + .architecture + ".tar.zst") and
      (.bytes | type == "number" and floor == . and . > 0) and
      (.minimum_macos | type == "number" and floor == . and . > 0 and
        . == $platforms[$architecture].minimum_macos) and
      (.sha256 | type == "string" and test("^[0-9a-f]{64}$")))) |
    if $asset == "" then
      "valid"
    else
      [.assets[] | select(.name == $asset)] as $matching |
      select($matching | length == 1) |
      [$matching[0].sha256, .homebrew_php_commit,
       (if (.php_src_commit // "") == "" then "-" else .php_src_commit end),
       .php_semver, .source_hash] |
      @tsv
    end
  ' "$manifest") || return 1
  if [ -n "$asset" ]; then
    printf '%s\n' "$manifest_result"
  else
    [ "$manifest_result" = valid ]
  fi
}

php_darwin_manifest_asset_sha256() {
  local manifest=$1
  local asset=$2

  jq -er --arg asset "$asset" '
    [.assets[] | select(.name == $asset) | .sha256] |
    select(length == 1) | .[0] | select(type == "string" and test("^[0-9a-f]{64}$"))
  ' "$manifest"
}

php_darwin_validate_cache_metadata() {
  local metadata_file=$1
  local version=$2
  local build=$3
  local ts=$4
  local arch=$5
  local brew_prefix=$6
  local macos_major=$7
  local expected_commit=${8:-}
  local expected_php_src_commit=${9:-}
  local configured_current_version=${10:-}
  local configured_tap_snapshot=${11:-}
  local configured_minimum_macos=${12:-}
  local configured_platform_key=${13:-}
  local asset
  local channel
  local formula
  local minimum_macos
  local pear_path
  local platform_key
  local requested_formula
  local tap_snapshot

  channel=$(php_darwin_version_channel "$version")
  asset=$(php_darwin_asset "$version" "$build" "$ts" "$arch")
  formula=$(php_darwin_formula "$version" "$build" "$ts" "$configured_current_version")
  requested_formula=$(php_darwin_requested_formula "$version" "$build" "$ts")
  pear_path=$(php_darwin_pear_path "$version" "$formula")
  if [ -n "$configured_tap_snapshot" ]; then
    tap_snapshot=$configured_tap_snapshot
  else
    tap_snapshot=$(php_darwin_package_config tap_snapshot)
  fi
  if [ -n "$configured_minimum_macos" ] && [ -n "$configured_platform_key" ]; then
    minimum_macos=$configured_minimum_macos
    platform_key=$configured_platform_key
  else
    minimum_macos=$(jq -er --arg arch "$arch" '.[$arch].minimum_macos' \
      < <(php_darwin_read_config platforms.json)) || return 1
    platform_key=$(jq -er --arg arch "$arch" '.[$arch].platform_key' \
      < <(php_darwin_read_config platforms.json)) || return 1
  fi

  jq -er --arg version "$version" --arg channel "$channel" --arg build "$build" --arg ts "$ts" \
    --arg arch "$arch" --arg brew_prefix "$brew_prefix" --arg asset "$asset" --arg formula "$formula" \
    --arg expected_commit "$expected_commit" --arg expected_php_src_commit "$expected_php_src_commit" \
    --arg pear_path "$pear_path" --arg pear_conf "etc/php/$(php_darwin_config_id "$version" "$build" "$ts")/pear.conf" \
    --arg platform_key "$platform_key" --arg requested_formula "$requested_formula" \
    --arg tap_snapshot "$tap_snapshot" --argjson macos_major "$macos_major" \
    --argjson minimum_macos "$minimum_macos" '
    select(.schema == 1 and .php_version == $version and .build == $build and
    .thread_safety == $ts and .architecture == $arch and .brew_prefix == $brew_prefix and
    .archive == $asset and .formula == $formula and .requested_formula == $requested_formula and
    .minimum_macos == $minimum_macos and .minimum_macos <= $macos_major and
    .platform_key == $platform_key and .pear_path == $pear_path and .tap_snapshot == $tap_snapshot and
    (.pecl_extension | type == "string" and test("^[A-Za-z0-9._-]+$")) and
    (.homebrew_php_commit | type == "string" and test("^[0-9a-f]{40}$")) and
    ($expected_commit == "" or .homebrew_php_commit == $expected_commit) and
    (.formula_sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.source_hash | type == "string" and test("^[0-9a-f]{64}$")) and
    (if $channel == "nightly" then
       (.php_src_commit | type == "string" and test("^[0-9a-f]{40}$")) and
       ($expected_php_src_commit == "" or .php_src_commit == $expected_php_src_commit)
     else
       (.php_src_commit == "" or .php_src_commit == null)
     end) and
    (.php_semver | type == "string" and startswith($version + ".") and
      test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) and
    (.links | type == "array" and length > 0) and
    ([.links[].path] | unique | length) == (.links | length) and
    all(.links[];
      (.path | type == "string" and
        test("^(Frameworks|bin|etc|include|lib|sbin|share|var/homebrew/linked)/") and
        (test("(^|/)\\.\\.(/|$)") | not) and test("^[^\\r\\n\\t]+$")) and
      (.target | type == "string" and test("^[^\\r\\n\\t]+$"))) and
    (.state_paths | type == "array" and length > 0) and
    ([.state_paths[]] | unique | length) == (.state_paths | length) and
    any(.state_paths[]; . == $pear_conf) and
    all(.state_paths[];
      type == "string" and test("^(etc|var)/") and
      (test("^var/homebrew/(linked|locks|pinned)(/|$)") | not) and
      (test("(^|/)\\.\\.(/|$)") | not) and test("^[^\\r\\n\\t]+$")) and
    (.packages | type == "array" and length > 0) and
    ([.packages[].name] | unique | length) == (.packages | length) and
    any(.packages[]; .name == $formula) and
    all(.packages[];
      (.name | type == "string" and test("^[A-Za-z0-9@+._-]+$")) and
      (.keg_only | type == "boolean") and
      (.name as $name | .opt_target | split("/") |
        length == 4 and .[0] == ".." and .[1] == "Cellar" and .[2] == $name and
        (.[3] | type == "string" and test("^[^\\r\\n\\t/]+$") and . != "." and . != "..")))) |
    [.homebrew_php_commit, .source_hash,
     (.packages[] | select(.name == $formula) | .opt_target | ltrimstr("../")),
     .pecl_extension, .php_semver] | @tsv
  ' "$metadata_file"
}
