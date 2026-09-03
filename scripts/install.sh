#!/usr/bin/env bash

# This file is generated from the named source files below. It is deliberately
# plain shell code so the standalone installer can be audited before execution.

# Source: scripts/lib.sh

unset php_darwin_configured_versions_data php_darwin_configured_variants_data


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

php_darwin_configure_homebrew_environment() {
  export HOMEBREW_NO_AUTO_UPDATE=1
  export HOMEBREW_NO_AUTOREMOVE=1
  export HOMEBREW_NO_ENV_HINTS=1
  export HOMEBREW_NO_INSTALL_CLEANUP=1
  export HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1
  export HOMEBREW_NO_INSTALL_FROM_API=1
}

php_darwin_is_git_worktree() {
  local tap_path=$1

  [ -d "$tap_path" ] && [ ! -L "$tap_path" ] || return 1
  [ -e "$tap_path/.git" ]
}

php_darwin_trust_entry() {
  local collection=$1
  local target=$2
  local trust_json=${3:-}
  local trust_state

  case "$collection" in taps|formulae) ;; *) return 2 ;; esac
  [ -n "$trust_json" ] || trust_json=$(brew trust --json=v1) || return 2
  trust_state=$(jq -er --arg collection "$collection" --arg target "$target" '
    if (.[$collection] | type) != "array" then
      error("invalid Homebrew trust response")
    elif (.[$collection] | index($target)) != null then
      "true"
    else
      "false"
    end
  ' <<< "$trust_json") || return 2
  [ "$trust_state" = true ]
}

php_darwin_tap_trusted() {
  php_darwin_trust_entry taps "$1" "${2:-}"
}

php_darwin_formula_trusted() {
  php_darwin_trust_entry formulae "$1" "${2:-}"
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
  if php_darwin_is_git_worktree "$tap_path"; then
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

php_darwin_remove_tap_path() {
  local brew_prefix=$1
  local tap_path=$2

  case "$tap_path" in
    "$brew_prefix/Library/Taps/"*|"$brew_prefix/Homebrew/Library/Taps/"*) ;;
    *)
      printf 'Unsafe Homebrew tap path: %s\n' "$tap_path" >&2
      return 1
      ;;
  esac
  [ -d "$tap_path" ] && [ ! -L "$tap_path" ] || {
    printf 'Homebrew tap path is not a directory: %s\n' "$tap_path" >&2
    return 1
  }
  if find "$tap_path" -mindepth 1 -delete >/dev/null 2>&1 && \
    rmdir "$tap_path" >/dev/null 2>&1; then
    return 0
  fi
  command -v sudo >/dev/null 2>&1 || return 1
  sudo -n find "$tap_path" -mindepth 1 -delete && sudo -n rmdir "$tap_path"
}

php_darwin_load_versions() {
  local channel
  local configured=
  local extra
  local seen=
  local version

  [ "${php_darwin_configured_versions_data+x}" != x ] || return 0
  while read -r channel version extra; do
    [ -n "$channel" ] || continue
    case "$channel" in \#*) continue ;; stable|nightly) ;; *) return 1 ;; esac
    [ -n "$version" ] && [ -z "$extra" ] && [[ "$version" =~ ^[0-9]+\.[0-9]+$ ]] || return 1
    case " $seen " in *" $version "*) return 1 ;; esac
    seen="$seen $version"
    configured=${configured:+"$configured"$'\n'}"$channel $version"
  done < <(php_darwin_read_config versions)
  [ -n "$configured" ] || return 1
  php_darwin_configured_versions_data=$configured
}

php_darwin_configured_versions() {
  php_darwin_load_versions || {
    printf 'Invalid PHP version configuration\n' >&2
    return 1
  }
  printf '%s\n' "$php_darwin_configured_versions_data"
}

php_darwin_load_variants() {
  local build
  local configured=
  local extra
  local seen=
  local ts

  [ "${php_darwin_configured_variants_data+x}" != x ] || return 0
  while read -r build ts extra; do
    [ -n "$build" ] || continue
    case "$build" in \#*) continue ;; release|debug) ;; *) return 1 ;; esac
    case "$ts" in nts|zts) ;; *) return 1 ;; esac
    [ -z "$extra" ] || return 1
    case " $seen " in *" $build/$ts "*) return 1 ;; esac
    seen="$seen $build/$ts"
    configured=${configured:+"$configured"$'\n'}"$build $ts"
  done < <(php_darwin_read_config variants)
  [ -n "$configured" ] || return 1
  php_darwin_configured_variants_data=$configured
}

php_darwin_configured_variants() {
  php_darwin_load_variants || {
    printf 'Invalid PHP build variant configuration\n' >&2
    return 1
  }
  printf '%s\n' "$php_darwin_configured_variants_data"
}

php_darwin_validate_version() {
  local requested_version=${1:-}
  local configured_channel
  local configured_version
  local extra

  php_darwin_load_versions || php_darwin_die 'invalid PHP version configuration'
  while read -r configured_channel configured_version extra; do
    if [ "$configured_version" = "$requested_version" ]; then
      return 0
    fi
  done <<< "$php_darwin_configured_versions_data"
  php_darwin_die "unsupported PHP version: ${requested_version:-<empty>}"
}

php_darwin_is_php_formula() {
  [[ "${1:-}" =~ ^php(@[0-9]+\.[0-9]+)?(-debug)?(-zts)?$ ]]
}

php_darwin_keg_formula_reference() {
  local brew_prefix=$1
  local formula=$2
  local keg_relative=$3
  local custom_tap=${4:-}
  local receipt
  local source_tap

  [[ "$formula" =~ ^[A-Za-z0-9@+._-]+$ ]] || return 1
  case "$keg_relative" in "Cellar/$formula/"*) ;; *) return 1 ;; esac
  receipt="$brew_prefix/$keg_relative/INSTALL_RECEIPT.json"
  source_tap=$(jq -er '.source.tap // empty | select(type == "string")' "$receipt" 2>/dev/null) || \
    source_tap=
  if [ -n "$source_tap" ]; then
    [[ "$source_tap" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 1
  fi
  if [ -n "$custom_tap" ] && [ "$source_tap" = "$custom_tap" ]; then
    printf '%s/%s\n' "$source_tap" "$formula"
  else
    printf '%s\n' "$formula"
  fi
}

php_darwin_version_channel() {
  local requested_version=${1:-}
  local configured_channel
  local configured_version
  local extra

  php_darwin_load_versions || php_darwin_die 'invalid PHP version configuration'
  while read -r configured_channel configured_version extra; do
    if [ "$configured_version" = "$requested_version" ]; then
      printf '%s\n' "$configured_channel"
      return 0
    fi
  done <<< "$php_darwin_configured_versions_data"
  php_darwin_die "unsupported PHP version: ${requested_version:-<empty>}"
}

php_darwin_validate_channel() {
  local version=${1:-}
  local expected=${2:-}
  local actual

  case "$expected" in stable|nightly) ;; *) php_darwin_die "unsupported release channel: ${expected:-<empty>}" ;; esac
  actual=$(php_darwin_version_channel "$version") || return 1
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
  local arch

  arch=$(php_darwin_normalize_arch "${1:-}") || return 1
  php_darwin_platform_value "$arch" brew_prefix
}

php_darwin_platform_value() {
  local arch=$1
  local key=$2

  case "$key" in brew_prefix|build_runner|minimum_macos|platform_key|test_runners) ;; *) return 1 ;; esac
  jq -er --arg arch "$arch" --arg key "$key" '.[$arch][$key]' \
    < <(php_darwin_read_config platforms.json)
}

php_darwin_platform_arches() {
  jq -er 'keys[]' < <(php_darwin_read_config platforms.json)
}

php_darwin_legacy_platforms() {
  local legacy_config

  legacy_config=$(php_darwin_read_config legacy-platforms.json) || return 1
  jq -cer '.platforms | select(type == "object")' <<< "$legacy_config"
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

  php_darwin_load_versions || php_darwin_die 'invalid PHP version configuration'
  while read -r channel configured_version extra; do
    [ "$channel" = nightly ] || continue
    [ -z "$nightly_version" ] || php_darwin_die 'multiple nightly PHP versions are configured'
    nightly_version=$configured_version
  done <<< "$php_darwin_configured_versions_data"
  [ -n "$nightly_version" ] || php_darwin_die 'no nightly PHP version is configured'
  printf '%s\n' "$nightly_version"
}

php_darwin_expected_asset_count() {
  local build
  local platform_count
  local ts
  local variant_count

  php_darwin_load_variants || php_darwin_die 'could not load configured variants'
  variant_count=0
  while read -r build ts; do
    variant_count=$((variant_count + 1))
  done <<< "$php_darwin_configured_variants_data"
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

php_darwin_validate_php_semver() {
  local semver=$2
  local version=$1

  [[ "$semver" =~ ^[0-9]+\.[0-9]+\.[0-9]+(alpha[0-9]+|beta[0-9]+|RC[0-9]+)?$ ]] || return 1
  case "$semver" in "$version".*) ;; *) return 1 ;; esac
}

php_darwin_formula() {
  local version=$1
  local current_version=${4:-}
  local suffix

  php_darwin_validate_version "$version"
  suffix=$(php_darwin_formula_suffix "${2:-release}" "${3:-nts}") || return 1
  [ -n "$current_version" ] || current_version=$(php_darwin_package_config current_version) || return 1
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
  suffix=$(php_darwin_formula_suffix "${2:-release}" "${3:-nts}") || return 1
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
  suffix=$(php_darwin_formula_suffix "${2:-release}" "${3:-nts}") || return 1
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
  config_id=$(php_darwin_config_id "$version" "${3:-release}" "${4:-nts}") || return 1
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
  arch=$(php_darwin_normalize_arch "${4:-}") || return 1
  printf 'php_%s-%s-%s+darwin_%s.tar.zst\n' "$version" "$ts" "$build" "$arch"
}

php_darwin_download_asset() {
  local asset=$1
  local sha256=$2

  [[ "$asset" =~ ^php_[0-9]+\.[0-9]+-(nts|zts)-(debug|release)\+darwin_arm64\.tar\.zst$ ]] || return 1
  [[ "$sha256" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s.%s.tar.zst\n' "${asset%.tar.zst}" "$sha256"
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

php_darwin_release_manifest_url() {
  local release_repository=$1
  local version=$2

  [[ "$release_repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 1
  php_darwin_validate_version "$version"
  printf 'https://github.com/%s/releases/download/php-%s/php-%s-manifest.json?cache=%s\n' \
    "$release_repository" "$version" "$version" "$(date +%s)"
}

php_darwin_fetch_release_manifest() {
  local destination=$3
  local manifest_url
  local request_status

  if [ -n "${4:-}" ]; then
    manifest_url=$4
  else
    manifest_url=$(php_darwin_release_manifest_url "$1" "$2") || return 1
  fi
  request_status=$(curl --retry 3 -sSL -w '%{http_code}' "$manifest_url" -o "$destination") || return 1
  printf '%s\n' "$request_status"
}

php_darwin_validate_release_manifest() {
  local manifest=$1
  local version=$2
  local channel=${3:-}
  local asset=${4:-}
  local expected_count
  local legacy_platforms
  local manifest_result
  local platforms

  [ -n "$channel" ] || channel=$(php_darwin_version_channel "$version") || return 1
  case "$channel" in stable|nightly) ;; *) return 1 ;; esac
  [ "$(php_darwin_version_channel "$version")" = "$channel" ] || return 1
  expected_count=$(php_darwin_expected_asset_count) || return 1
  platforms=$(php_darwin_read_config platforms.json) || return 1
  legacy_platforms=$(php_darwin_legacy_platforms) || return 1
  manifest_result=$(jq -er --arg channel "$channel" --arg version "$version" \
    --arg asset "$asset" --argjson count "$expected_count" --argjson platforms "$platforms" \
    --argjson legacy_platforms "$legacy_platforms" '
    ($platforms + $legacy_platforms) as $manifest_platforms |
    ($platforms | keys) as $current_architectures |
    ($manifest_platforms | keys) as $legacy_architectures |
    ($count / ($platforms | length) * ($manifest_platforms | length)) as $legacy_count |
    select(.schema == 1 and .php_version == $version and
    (.homebrew_php_commit | type == "string" and test("^[0-9a-f]{40}$")) and
    (((.homebrew_extensions_commit // "") == "") or
      (.homebrew_extensions_commit | type == "string" and test("^[0-9a-f]{40}$"))) and
    (.source_hash | type == "string" and test("^[0-9a-f]{64}$")) and
    (.php_semver | type == "string" and startswith($version + ".") and
      test("^[0-9]+\\.[0-9]+\\.[0-9]+(alpha[0-9]+|beta[0-9]+|RC[0-9]+)?$")) and
    (has("php_src_commit") and if $channel == "nightly" then
       (.php_src_commit | type == "string" and test("^[0-9a-f]{40}$"))
     else
       (.php_src_commit == "" or .php_src_commit == null)
     end) and
    (.assets | type == "array") and
    (([.assets[].architecture] | unique) as $architectures |
      ((.assets | length == $count) and $architectures == $current_architectures) or
      ((.assets | length == $legacy_count) and $architectures == $legacy_architectures)) and
    ([.assets[].name] | unique | length) == (.assets | length) and
    ([.assets[] | (.download // .name)] | unique | length) == (.assets | length) and
    all(.assets[];
      . as $item | .architecture as $architecture |
      ($manifest_platforms[$architecture] != null) and
      (.build == "debug" or .build == "release") and
      (.thread_safety == "nts" or .thread_safety == "zts") and
      .name == ("php_" + $version + "-" + .thread_safety + "-" + .build +
        "+darwin_" + .architecture + ".tar.zst") and
      (.bytes | type == "number" and floor == . and . > 0) and
      (.minimum_macos | type == "number" and floor == . and . > 0 and
        . == $manifest_platforms[$architecture].minimum_macos) and
      (.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
      ((.download // .name) as $download |
        ($download | type == "string") and
        ($download == $item.name or
          $download == ($item.name | sub("\\.tar\\.zst$"; "." + $item.sha256 + ".tar.zst")))))) |
    if $asset == "" then
      "valid"
    else
      [.assets[] | select(.name == $asset)] as $matching |
      select($matching | length == 1) |
      [$matching[0].sha256, .homebrew_php_commit,
       (if (.php_src_commit // "") == "" then "-" else .php_src_commit end),
       .php_semver, .source_hash, ($matching[0].download // $matching[0].name),
       (if (.homebrew_extensions_commit // "") == "" then "-" else .homebrew_extensions_commit end)] |
       @tsv
    end
  ' "$manifest") || return 1
  if [ -n "$asset" ]; then
    printf '%s\n' "$manifest_result"
  else
    [ "$manifest_result" = valid ]
  fi
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
  local expected_extensions_commit=${14:-}
  local asset
  local channel
  local config_id
  local formula
  local minimum_macos
  local pear_path
  local platform_key
  local requested_formula
  local tap_snapshot

  channel=$(php_darwin_version_channel "$version") || return 1
  config_id=$(php_darwin_config_id "$version" "$build" "$ts") || return 1
  asset=$(php_darwin_asset "$version" "$build" "$ts" "$arch") || return 1
  formula=$(php_darwin_formula "$version" "$build" "$ts" "$configured_current_version") || return 1
  requested_formula=$(php_darwin_requested_formula "$version" "$build" "$ts") || return 1
  pear_path=$(php_darwin_pear_path "$version" "$formula") || return 1
  if [ -n "$configured_tap_snapshot" ]; then
    tap_snapshot=$configured_tap_snapshot
  else
    tap_snapshot=$(php_darwin_package_config tap_snapshot) || return 1
  fi
  if [ -n "$configured_minimum_macos" ] && [ -n "$configured_platform_key" ]; then
    minimum_macos=$configured_minimum_macos
    platform_key=$configured_platform_key
  else
    minimum_macos=$(php_darwin_platform_value "$arch" minimum_macos) || return 1
    platform_key=$(php_darwin_platform_value "$arch" platform_key) || return 1
  fi

  jq -er --arg version "$version" --arg channel "$channel" --arg build "$build" --arg ts "$ts" \
    --arg arch "$arch" --arg brew_prefix "$brew_prefix" --arg asset "$asset" --arg formula "$formula" \
    --arg expected_commit "$expected_commit" --arg expected_extensions_commit "$expected_extensions_commit" \
    --arg expected_php_src_commit "$expected_php_src_commit" \
    --arg pear_path "$pear_path" --arg pear_conf "etc/php/$config_id/pear.conf" \
    --arg platform_key "$platform_key" --arg requested_formula "$requested_formula" \
    --arg tap_snapshot "$tap_snapshot" --argjson macos_major "$macos_major" \
    --argjson minimum_macos "$minimum_macos" '
    . as $metadata |
    select(.schema == 1 and .php_version == $version and .build == $build and
    .thread_safety == $ts and .architecture == $arch and .brew_prefix == $brew_prefix and
    .archive == $asset and .formula == $formula and .requested_formula == $requested_formula and
    .minimum_macos == $minimum_macos and .minimum_macos <= $macos_major and
    .platform_key == $platform_key and .pear_path == $pear_path and .tap_snapshot == $tap_snapshot and
    (.pecl_extension | type == "string" and test("^[A-Za-z0-9._-]+$")) and
    (.homebrew_php_commit | type == "string" and test("^[0-9a-f]{40}$")) and
    ($expected_commit == "" or .homebrew_php_commit == $expected_commit) and
    ((.homebrew_extensions_commit // "") as $extensions_commit |
      (($extensions_commit == "" and $expected_extensions_commit == "") or
       ($extensions_commit | type == "string" and test("^[0-9a-f]{40}$") and
        ($expected_extensions_commit == "" or $extensions_commit == $expected_extensions_commit)))) and
    (.formula_sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.source_hash | type == "string" and test("^[0-9a-f]{64}$")) and
    (has("php_src_commit") and if $channel == "nightly" then
       (.php_src_commit | type == "string" and test("^[0-9a-f]{40}$")) and
       ($expected_php_src_commit == "" or .php_src_commit == $expected_php_src_commit)
     else
       (.php_src_commit == "" or .php_src_commit == null)
     end) and
    (.php_semver | type == "string" and startswith($version + ".") and
      test("^[0-9]+\\.[0-9]+\\.[0-9]+(alpha[0-9]+|beta[0-9]+|RC[0-9]+)?$")) and
    (.links | type == "array" and length > 0) and
    ([.links[].path] | unique | length) == (.links | length) and
    all(.links[];
      (.path | type == "string" and
        test("^(Frameworks|bin|etc|include|lib|sbin|share|var/homebrew/linked)/") and
        (test("(^|/)\\.\\.(/|$)") | not) and test("^[^\\r\\n\\t]+$")) and
      (.target | type == "string" and test("^[^\\r\\n\\t]+$"))) and
    ((.extensions // []) | type == "array") and
    ([((.extensions // [])[].name)] | unique | length) == ((.extensions // []) | length) and
    ([((.extensions // [])[].path)] | unique | length) == ((.extensions // []) | length) and
    all((.extensions // [])[];
      . as $extension |
      ($extension.name == "xdebug" or $extension.name == "pcov") and
      ($extension.type == (if $extension.name == "xdebug" then "zend_extension" else "extension" end)) and
      ($extension.path | type == "string" and test("^(Cellar|lib)/") and
        (test("(^|/)\\.\\.(/|$)") | not) and test("^[^\\\\\\r\\n\\t]+$") and
        endswith("/" + $extension.name + ".so"))) and
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
        (.[3] | type == "string" and test("^[^\\r\\n\\t/]+$") and . != "." and . != ".."))) and
    ((.tap_formulae // []) as $tap_formulae |
      ($tap_formulae | type == "array") and
      ([$tap_formulae[]] | unique | length) == ($tap_formulae | length) and
      (($tap_formulae | length) == 0 or ($tap_formulae | index($formula)) != null) and
      all($tap_formulae[];
        type == "string" and test("^[A-Za-z0-9@+._-]+$") and
        (. as $tap_formula | any($metadata.packages[]; .name == $tap_formula))))) |
    [.homebrew_php_commit, .source_hash,
     (.packages[] | select(.name == $formula) | .opt_target | ltrimstr("../")),
     .pecl_extension, .php_semver] | @tsv
  ' "$metadata_file"
}

php_darwin_job_running() {
  kill -0 "$1" >/dev/null 2>&1
}

php_darwin_collect_job_pids() {
  local job_pid=$1

  ps -axo pid=,ppid= | awk -v root="$job_pid" '
    { parent[$1]=$2; pid[++count]=$1 }
    END {
      for (item_index=1; item_index<=count; item_index++) {
        current=pid[item_index]
        for (depth=0; depth<count && current in parent; depth++) {
          if (parent[current] == root) { print pid[item_index]; break }
          current=parent[current]
        }
      }
    }
  '
}

php_darwin_wait_for_job_pids() {
  local attempt=0
  local attempts=$1
  local job_pid
  local running

  shift

  while [ "$attempt" -lt "$attempts" ]; do
    running=false
    for job_pid in "$@"; do
      php_darwin_job_running "$job_pid" && running=true
    done
    [ "$running" = true ] || return 0
    sleep 0.1
    attempt=$((attempt + 1))
  done
  return 1
}

php_darwin_signal_job_pids() {
  local job_pid
  local signal=$1

  shift
  for job_pid in "$@"; do
    php_darwin_job_running "$job_pid" || continue
    kill "-$signal" "$job_pid" >/dev/null 2>&1 || true
  done
}

php_darwin_reap_job() {
  local discovered_pid
  local grace_attempts=$2
  local job_pid=$1
  local tracked_pids=()

  [ -n "$job_pid" ] || return 0
  while IFS= read -r discovered_pid; do
    [ -n "$discovered_pid" ] && tracked_pids+=("$discovered_pid")
  done < <(php_darwin_collect_job_pids "$job_pid")
  if [ "$grace_attempts" -gt 0 ] && \
    php_darwin_wait_for_job_pids "$grace_attempts" "$job_pid" "${tracked_pids[@]}"; then
    wait "$job_pid" >/dev/null 2>&1 || true
    return 0
  fi
  while IFS= read -r discovered_pid; do
    [ -n "$discovered_pid" ] || continue
    case " ${tracked_pids[*]} " in *" $discovered_pid "*) ;; *) tracked_pids+=("$discovered_pid") ;; esac
  done < <(php_darwin_collect_job_pids "$job_pid")
  php_darwin_signal_job_pids TERM "$job_pid" "${tracked_pids[@]}"
  if ! php_darwin_wait_for_job_pids 10 "$job_pid" "${tracked_pids[@]}"; then
    php_darwin_signal_job_pids KILL "${tracked_pids[@]}" "$job_pid"
    php_darwin_wait_for_job_pids 10 "$job_pid" "${tracked_pids[@]}" || true
  fi
  wait "$job_pid" >/dev/null 2>&1 || true
}

php_darwin_read_config() {
  case "${1:-}" in
    archive-paths)
      cat <<'PHP_DARWIN_CONFIG_ARCHIVE_PATHS'
# Homebrew prefix roots permitted in an archive and merged during installation.
Cellar
Frameworks
bin
etc
include
lib
opt
sbin
share
var
PHP_DARWIN_CONFIG_ARCHIVE_PATHS
      ;;
    package.json)
      cat <<'PHP_DARWIN_CONFIG_PACKAGE_JSON'
{
  "current_version": "8.5",
  "extension_tap": "shivammathur/extensions",
  "extension_tap_branch": "main",
  "extension_tap_repository": "https://github.com/shivammathur/homebrew-extensions",
  "release_repository": "shivammathur/php-darwin",
  "tap": "shivammathur/php",
  "tap_branch": "main",
  "tap_repository": "https://github.com/shivammathur/homebrew-php",
  "tap_snapshot": "var/php-darwin/homebrew-php"
}
PHP_DARWIN_CONFIG_PACKAGE_JSON
      ;;
    platforms.json)
      cat <<'PHP_DARWIN_CONFIG_PLATFORMS_JSON'
{
  "arm64": {
    "build_runner": "macos-14",
    "brew_prefix": "/opt/homebrew",
    "minimum_macos": 14,
    "platform_key": "arm64_sonoma",
    "test_runners": ["macos-14", "macos-15", "macos-26", "macos-latest"]
  }
}
PHP_DARWIN_CONFIG_PLATFORMS_JSON
      ;;
    legacy-platforms.json)
      cat <<'PHP_DARWIN_CONFIG_LEGACY_PLATFORMS_JSON'
{
  "schema": 1,
  "purpose": "Validate pre-ARM64-only release manifests",
  "platforms": {
    "x86_64": {
      "minimum_macos": 15
    }
  }
}
PHP_DARWIN_CONFIG_LEGACY_PLATFORMS_JSON
      ;;
    postinstall-paths)
      cat <<'PHP_DARWIN_CONFIG_POSTINSTALL_PATHS'
# Formula-managed configuration recreated by Homebrew post_install.
all etc/php/{config}/pear.conf
versioned etc/php/{config}/conf.d/ext-intl.ini
versioned etc/php/{config}/conf.d/ext-opcache.ini
PHP_DARWIN_CONFIG_POSTINSTALL_PATHS
      ;;
    variants)
      cat <<'PHP_DARWIN_CONFIG_VARIANTS'
# build thread-safety
release nts
release zts
debug nts
debug zts
PHP_DARWIN_CONFIG_VARIANTS
      ;;
    versions)
      cat <<'PHP_DARWIN_CONFIG_VERSIONS'
# channel version
stable 5.6
stable 7.0
stable 7.1
stable 7.2
stable 7.3
stable 7.4
stable 8.0
stable 8.1
stable 8.2
stable 8.3
stable 8.4
stable 8.5
nightly 8.6
PHP_DARWIN_CONFIG_VERSIONS
      ;;
    release-manifest.json)
      cat <<'PHP_DARWIN_RELEASE_MANIFEST'
{}
PHP_DARWIN_RELEASE_MANIFEST
      ;;
    *) printf 'php-darwin: unknown embedded configuration: %s\n' "$1" >&2; return 1 ;;
  esac
}


# Source: scripts/read-metadata.sh
php_darwin_read_metadata() (

archive=${1:?}
member=${2:?}
output=${3:?}

[ -f "$archive" ] || {
  printf 'Archive not found: %s\n' "$archive" >&2
  exit 1
}
[[ "$member" =~ ^var/php-darwin/php_[0-9]+\.[0-9]+-(nts|zts)-(debug|release)\+darwin_arm64\.json$ ]] || {
  printf 'Unsafe metadata member: %s\n' "$member" >&2
  exit 1
}

if ! tar --ignore-zeros -xOf "$archive" "$member" > "$output"; then
  rm -f "$output"
  exit 1
fi
[ -s "$output" ] || {
  rm -f "$output"
  exit 1
}
)

# Source: scripts/source-hash.sh
php_darwin_source_hash() (


version=${1:?}
tap_path=${HOMEBREW_PHP_PATH:-}
php_darwin_validate_version "$version"
repository=$(php_darwin_package_config tap_repository)
branch=$(php_darwin_package_config tap_branch)
tmp_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-source.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT
hashes="$tmp_dir/formulae.tsv"

while read -r build ts; do
  formula=$(php_darwin_formula "$version" "$build" "$ts") || exit 1
  formula_file="$tmp_dir/$formula.rb"
  if [ -n "$tap_path" ]; then
    cp "$tap_path/Formula/$formula.rb" "$formula_file" || php_darwin_die "could not read $formula from the local tap"
  else
    curl --retry 3 --retry-all-errors -fsSL \
      "${repository/github.com/raw.githubusercontent.com}/$branch/Formula/$formula.rb" \
      -o "$formula_file" || php_darwin_die "could not download $formula"
  fi
  formula_hash=$(php_darwin_sha256 "$formula_file") || php_darwin_die "could not hash $formula"
  printf '%s\t%s\n' "$formula" "$formula_hash" >> "$hashes" || php_darwin_die 'could not record a formula hash'
done < <(php_darwin_configured_variants)

LC_ALL=C sort -u "$hashes" -o "$hashes" || php_darwin_die 'could not sort formula hashes'
php_darwin_sha256 "$hashes" || php_darwin_die 'could not hash formula metadata'
)

# Source: scripts/validate-tap.sh
php_darwin_validate_tap() (


tap_path=${1:?}
version=${2:?}
expected_hash=${3:-}
repository=${4:?}
expected_commit=${5:-}
expected_branch=${6:-}
require_clean=${7:-false}

php_darwin_is_git_worktree "$tap_path" || {
  printf 'Homebrew tap is not a Git repository: %s\n' "$tap_path" >&2
  exit 1
}
actual_repository=$(git -C "$tap_path" remote get-url origin) || {
  printf 'Could not resolve the Homebrew tap origin\n' >&2
  exit 1
}
actual_repository=${actual_repository%.git}
[ "$actual_repository" = "${repository%.git}" ] || {
  printf 'Homebrew tap origin mismatch: %s\n' "$actual_repository" >&2
  exit 1
}
if [ -n "$expected_commit" ]; then
  actual_commit=$(git -C "$tap_path" rev-parse HEAD) || {
    printf 'Could not resolve the Homebrew tap commit\n' >&2
    exit 1
  }
  [ "$actual_commit" = "$expected_commit" ] || {
    printf 'Homebrew tap commit mismatch: %s\n' "$actual_commit" >&2
    exit 1
  }
fi
if [ -n "$expected_branch" ]; then
  actual_branch=$(git -C "$tap_path" symbolic-ref --short HEAD) || {
    printf 'Could not resolve the Homebrew tap branch\n' >&2
    exit 1
  }
  [ "$actual_branch" = "$expected_branch" ] || {
    printf 'Homebrew tap branch mismatch: %s\n' "$actual_branch" >&2
    exit 1
  }
  remote_commit=$(git -C "$tap_path" rev-parse "refs/remotes/origin/$expected_branch") || {
    printf 'Could not resolve the Homebrew tap remote branch\n' >&2
    exit 1
  }
  [ "$remote_commit" = "$expected_commit" ] || {
    printf 'Homebrew tap remote branch does not match its snapshot commit\n' >&2
    exit 1
  }
fi
if [ -n "$expected_hash" ]; then
  actual_hash=$(HOMEBREW_PHP_PATH="$tap_path" php_darwin_source_hash "$version") || {
    printf 'Could not hash the Homebrew tap formulae\n' >&2
    exit 1
  }
  [ "$actual_hash" = "$expected_hash" ] || {
    printf 'Homebrew tap formula hash mismatch\n' >&2
    exit 1
  }
fi
if [ -n "$expected_branch" ] || [ -n "$expected_hash" ] || [ "$require_clean" = true ]; then
  tap_status=$(git -C "$tap_path" status --porcelain --untracked-files=all) || {
    printf 'Could not inspect Homebrew tap status\n' >&2
    exit 1
  }
  [ -z "$tap_status" ] || {
    printf 'Homebrew tap snapshot has changed or untracked files\n' >&2
    exit 1
  }
fi
[ -z "$expected_hash" ] || printf '%s\n' "$actual_hash"
)

# Source: scripts/tap-action.sh
php_darwin_tap_action() (


tap_path=${1:?}
cached_tap_path=${2:?}
version=${3:?}
expected_hash=${4:?}
repository=${5:?}
cached_commit=${6:?}
expected_branch=${7:?}

php_darwin_validate_tap "$tap_path" "$version" '' "$repository" \
  >/dev/null || exit 1
actual_hash=$(HOMEBREW_PHP_PATH="$tap_path" php_darwin_source_hash "$version" 2>/dev/null) || \
  actual_hash=
formula_status=$(git -C "$tap_path" status --porcelain --untracked-files=all -- Formula 2>/dev/null) || {
  printf 'Could not inspect Homebrew tap formula status\n' >&2
  exit 1
}
formula_status=$(awk 'substr($0, 1, 3) == "?? " && $0 ~ /(^|\/)\.DS_Store$/ { next } { print }' \
  <<< "$formula_status") || {
  printf 'Could not filter Homebrew tap formula status\n' >&2
  exit 1
}
if [ "$actual_hash" = "$expected_hash" ] && [ -z "$formula_status" ]; then
  printf 'keep\n'
  exit 0
fi

if ! git -C "$tap_path" diff --quiet -- . || ! git -C "$tap_path" diff --cached --quiet -- .; then
  printf 'Remove changes from %s or untap %s before retrying the cache install\n' "$tap_path" \
    "$(php_darwin_package_config tap)" >&2
  exit 1
fi
untracked_paths=$(git -C "$tap_path" ls-files --others --exclude-standard) || {
  printf 'Could not inspect untracked Homebrew tap files\n' >&2
  exit 1
}
untracked_path=
while IFS= read -r candidate_path; do
  case "$candidate_path" in .DS_Store|*/.DS_Store) ;; *) untracked_path=$candidate_path; break ;; esac
done <<< "$untracked_paths"
[ -z "$untracked_path" ] || {
  printf 'Remove changes from %s or untap %s before retrying the cache install\n' "$tap_path" \
    "$(php_darwin_package_config tap)" >&2
  exit 1
}
existing_commit=$(git -C "$tap_path" rev-parse HEAD) || {
  printf 'Could not resolve the installed Homebrew tap commit\n' >&2
  exit 1
}
actual_cached_commit=$(git -C "$cached_tap_path" rev-parse HEAD) || {
  printf 'Could not resolve the cached Homebrew tap commit\n' >&2
  exit 1
}
[ "$actual_cached_commit" = "$cached_commit" ] || {
  printf 'Cached Homebrew tap commit does not match the archive metadata\n' >&2
  exit 1
}
snapshot_commit=$(git -C "$tap_path" config --get php-darwin.snapshot-commit 2>/dev/null) || \
  snapshot_commit=
if [ -z "$snapshot_commit" ] || [ "$snapshot_commit" != "$existing_commit" ]; then
  existing_branch=$(git -C "$tap_path" symbolic-ref --short HEAD 2>/dev/null) || {
    printf 'Homebrew tap formula hash mismatch on a detached checkout; run brew untap %s before retrying\n' \
      "$(php_darwin_package_config tap)" >&2
    exit 1
  }
  remote_commit=$(git -C "$tap_path" rev-parse "refs/remotes/origin/$expected_branch" 2>/dev/null) || {
    printf 'Homebrew tap formula hash mismatch without an origin/%s reference; run brew untap %s before retrying\n' \
      "$expected_branch" "$(php_darwin_package_config tap)" >&2
    exit 1
  }
  standard_checkout=false
  if [ "$existing_branch" = "$expected_branch" ]; then
    if [ "$remote_commit" = "$existing_commit" ] || \
      git -C "$tap_path" merge-base --is-ancestor "$existing_commit" "$remote_commit" 2>/dev/null; then
      standard_checkout=true
    fi
  fi
  [ "$standard_checkout" = true ] || {
    printf 'Homebrew tap has local commits or a nonstandard branch; run brew untap %s before retrying\n' \
      "$(php_darwin_package_config tap)" >&2
    exit 1
  }
  if [ -n "$snapshot_commit" ]; then
    printf 'Homebrew updated the cached tap; preserving it and using the requested snapshot temporarily\n' >&2
  fi
  printf 'temporary\n'
  exit 0
fi
[ "$existing_commit" != "$cached_commit" ] || {
  printf 'Homebrew tap source hash differs at the same cache snapshot commit\n' >&2
  exit 1
}

comparison_status=
repository_slug=${repository#https://github.com/}
repository_slug=${repository_slug%.git}
if [[ "$repository_slug" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  comparison_status=$(curl --retry 2 -fsSL \
    "https://api.github.com/repos/$repository_slug/compare/$existing_commit...$cached_commit" 2>/dev/null | \
    jq -er '.status | select(. == "ahead" or . == "behind" or . == "identical" or . == "diverged")' \
      2>/dev/null) || comparison_status=
fi
if [ "$comparison_status" = ahead ]; then
  printf 'replace\n'
else
  # Use an older, rebased, or unorderable cache snapshot only for this install.
  # Restoring the existing cache-owned tap avoids a persistent downgrade.
  printf 'temporary\n'
fi
)

# Source: scripts/verify-links.sh
php_darwin_verify_links() (

prefix=${1:?}
verify_links_file=${2:?}
actual_links=$(mktemp "${RUNNER_TEMP:-/tmp}/php-darwin-links.XXXXXX") || exit 1
raw_links=$(mktemp "${RUNNER_TEMP:-/tmp}/php-darwin-raw-links.XXXXXX") || {
  rm -f "$actual_links"
  exit 1
}
trap 'rm -f "$actual_links" "$raw_links"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

[ -d "$prefix" ] || {
  printf 'Missing Homebrew prefix: %s\n' "$prefix" >&2
  exit 1
}
[ -s "$verify_links_file" ] || {
  printf 'Missing Homebrew link manifest: %s\n' "$verify_links_file" >&2
  exit 1
}

link_paths=()
while IFS=$'\t' read -r link_relative link_target extra; do
  [ -n "$link_relative" ] && [ -n "$link_target" ] && [ -z "$extra" ] || {
    printf 'Invalid Homebrew link record: %s\n' "$link_relative" >&2
    exit 1
  }
  [ -L "$prefix/$link_relative" ] || {
    printf 'Cached Homebrew link is missing or conflicted: %s\n' "$link_relative" >&2
    exit 1
  }
  link_paths+=("$prefix/$link_relative")
done < "$verify_links_file"

if [ "$(uname -s)" = Darwin ]; then
  stat -f $'%N\t%Y' "${link_paths[@]}" > "$raw_links" || exit 1
  awk -F '\t' -v prefix="$prefix/" '
    index($1, prefix) == 1 && NF == 2 { print substr($1, length(prefix) + 1) "\t" $2; next }
    { exit 1 }
  ' "$raw_links" > "$actual_links" || exit 1
else
  : > "$actual_links" || exit 1
  while IFS=$'\t' read -r link_relative link_target extra; do
    printf '%s\t%s\n' "$link_relative" "$(readlink "$prefix/$link_relative")" >> "$actual_links" || exit 1
  done < "$verify_links_file"
fi

if ! cmp -s "$verify_links_file" "$actual_links"; then
  diff -u "$verify_links_file" "$actual_links" >&2 || true
  printf 'Cached Homebrew links do not match the archive manifest\n' >&2
  exit 1
fi
)

# Source: scripts/existing-paths.sh
php_darwin_existing_paths() (

prefix=${1:?}
output=${2:?}
roots_file=${3:?}
kegs_output=${4:?}
managed_paths_file=${5:?}
package_kegs_file=${6:?}

[ -d "$prefix" ] || {
  printf 'Missing Homebrew prefix: %s\n' "$prefix" >&2
  exit 1
}
[ -f "$roots_file" ] || {
  printf 'Missing archive roots: %s\n' "$roots_file" >&2
  exit 1
}
[ -f "$managed_paths_file" ] || {
  printf 'Missing managed archive paths: %s\n' "$managed_paths_file" >&2
  exit 1
}
[ -f "$package_kegs_file" ] || {
  printf 'Missing package keg paths: %s\n' "$package_kegs_file" >&2
  exit 1
}

append_exclusion() {
  relative_path=$1
  case "$relative_path" in *$'\n'*|*$'\r'*)
    printf 'Unsupported Homebrew path: %s\n' "$relative_path" >&2
    exit 1
    ;;
  esac
  printf '%s\n' "$relative_path" >> "$output" || exit 1
}

: > "$output" || exit 1
: > "$kegs_output" || exit 1
allowed_roots=
while IFS= read -r managed_dir extra; do
  [ -n "$managed_dir" ] || continue
  case "$managed_dir" in \#*) continue ;; esac
  [ -z "$extra" ] || {
    printf 'Invalid archive root: %s %s\n' "$managed_dir" "$extra" >&2
    exit 1
  }
  case "$managed_dir" in Cellar|Frameworks|bin|etc|include|lib|opt|sbin|share|var) ;; *)
    printf 'Unsafe archive root: %s\n' "$managed_dir" >&2
    exit 1
    ;;
  esac
  [ ! -L "$prefix/$managed_dir" ] || {
    printf 'Homebrew archive root is a symlink: %s\n' "$managed_dir" >&2
    exit 1
  }
  allowed_roots="$allowed_roots $managed_dir"
done < "$roots_file"

# The archive only contains kegs named in its package metadata. Inventory
# existing versions for those formulae instead of walking the entire Cellar.
while IFS= read -r package_keg extra; do
  [ -n "$package_keg" ] || continue
  [ -z "$extra" ] && [[ "$package_keg" =~ ^Cellar/[A-Za-z0-9@+._-]+/[^/[:space:]]+$ ]] || {
    printf 'Unsafe package keg path: %s %s\n' "$package_keg" "$extra" >&2
    exit 1
  }
  package_rack=${package_keg%/*}
  [ ! -L "$prefix/$package_rack" ] || {
    printf 'Homebrew formula rack is a symlink: %s\n' "$package_rack" >&2
    exit 1
  }
  if [ -d "$prefix/$package_rack" ]; then
    for existing_keg in "$prefix/$package_rack"/*; do
      [ -d "$existing_keg" ] && [ ! -L "$existing_keg" ] || continue
      existing_keg=${existing_keg#"$prefix"/}
      case "$existing_keg" in *$'\n'*|*$'\r'*|*$'\t'*)
        printf 'Unsupported Homebrew keg path: %s\n' "$existing_keg" >&2
        exit 1
        ;;
      esac
      printf '%s\n' "$existing_keg" >> "$kegs_output" || exit 1
    done
  fi
  if [ -e "$prefix/$package_keg" ] || [ -L "$prefix/$package_keg" ]; then
    append_exclusion "$package_keg"
  fi
done < "$package_kegs_file"

while IFS= read -r managed_path; do
  [ -n "$managed_path" ] || continue
  case "$managed_path" in /*|*'/../'*|../*|*/..|*'//'*)
    printf 'Unsafe managed archive path: %s\n' "$managed_path" >&2
    exit 1
    ;;
  esac
  managed_root=${managed_path%%/*}
  [[ "$managed_root" =~ ^[A-Za-z0-9._+-]+$ ]] || {
    printf 'Unsafe managed archive root: %s\n' "$managed_root" >&2
    exit 1
  }
  case " $allowed_roots " in *" $managed_root "*) ;; *)
    printf 'Managed archive path has a disallowed root: %s\n' "$managed_path" >&2
    exit 1
    ;;
  esac
  managed_ancestor=$managed_path
  while [[ "$managed_ancestor" == */* ]]; do
    managed_ancestor=${managed_ancestor%/*}
    if [ -L "$prefix/$managed_ancestor" ]; then
      append_exclusion "$managed_ancestor"
      break
    fi
  done
  if [ -e "$prefix/$managed_path" ] || [ -L "$prefix/$managed_path" ]; then
    append_exclusion "$managed_path"
  fi
done < "$managed_paths_file"

LC_ALL=C sort -u "$output" -o "$output" || exit 1
LC_ALL=C sort -u "$kegs_output" -o "$kegs_output" || exit 1
)

# Source: scripts/extract.sh
php_darwin_extract() (

archive=${1:?}
prefix=${2:?}
exclude_file=${3:?}
archive_members=$(mktemp "${RUNNER_TEMP:-/tmp}/php-darwin-archive-members.XXXXXX") || exit 1
extract_members=$(mktemp "${RUNNER_TEMP:-/tmp}/php-darwin-extract-members.XXXXXX") || {
  rm -f "$archive_members"
  exit 1
}
permission_records=
stat_style=

path_uid() {
  case "$stat_style" in
    bsd) stat -f '%u' "$1" ;;
    gnu) stat -c '%u' "$1" ;;
  esac
}

path_gid() {
  case "$stat_style" in
    bsd) stat -f '%g' "$1" ;;
    gnu) stat -c '%g' "$1" ;;
  esac
}

path_mode() {
  case "$stat_style" in
    bsd) stat -f '%Lp' "$1" ;;
    gnu) stat -c '%a' "$1" ;;
  esac
}

restore_permissions() {
  local absolute_path
  local changed_owner
  local extra
  local gid
  local mode
  local relative_path
  local status=0
  local uid

  [ -n "$permission_records" ] && [ -s "$permission_records" ] || return 0
  while IFS=$'\t' read -r relative_path uid gid mode changed_owner extra; do
    [ -n "$relative_path" ] && [ -z "$extra" ] || {
      status=1
      continue
    }
    absolute_path="$prefix/$relative_path"
    if [ ! -d "$absolute_path" ] || [ -L "$absolute_path" ]; then
      printf 'Could not restore extraction directory: %s\n' "$relative_path" >&2
      status=1
      continue
    fi
    if ! chmod "$mode" "$absolute_path" 2>/dev/null && \
      ! sudo -n chmod "$mode" "$absolute_path"; then
      printf 'Could not restore extraction permissions: %s\n' "$relative_path" >&2
      status=1
    fi
    if [ "$changed_owner" = true ] && ! sudo -n chown "$uid:$gid" "$absolute_path"; then
      printf 'Could not restore extraction ownership: %s\n' "$relative_path" >&2
      status=1
    fi
  done < "$permission_records"
  [ "$status" -ne 0 ] || : > "$permission_records"
  return "$status"
}

# shellcheck disable=SC2329
cleanup() {
  local temporary_file

  trap '' HUP INT TERM
  restore_permissions || true
  for temporary_file in "$archive_members" "$extract_members" "$permission_records"; do
    [ -z "$temporary_file" ] || rm -f "$temporary_file"
  done
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

[ -f "$archive" ] || {
  printf 'Archive not found: %s\n' "$archive" >&2
  exit 1
}
[ -d "$prefix" ] || {
  printf 'Extraction prefix not found: %s\n' "$prefix" >&2
  exit 1
}
[ -f "$exclude_file" ] || {
  printf 'Extraction exclusion list not found: %s\n' "$exclude_file" >&2
  exit 1
}
case "$(uname -s)" in
  Darwin) stat_style=bsd ;;
  *) stat_style=gnu ;;
esac

tar --ignore-zeros -tf "$archive" > "$archive_members" || {
  printf 'Could not list archive members: %s\n' "$archive" >&2
  exit 1
}
awk '
  FILENAME == ARGV[1] {
    if ($0 == "" || $0 ~ /[\t\r]/ || $0 ~ /^\// || $0 ~ /(^|\/)\.\.($|\/)/ ||
        $0 ~ /(^|\/)\.($|\/)/ || $0 ~ /\/\// || $0 ~ /\/$/) exit 2
    excluded[$0]=1
    next
  }
  {
    path=$0
    if (path == "" || path ~ /[\t\r]/ || path ~ /^\// || path ~ /(^|\/)\.\.($|\/)/ ||
        path ~ /(^|\/)\.($|\/)/ || path ~ /\/\// || path ~ /\/$/) exit 3
    candidate=path
    while (1) {
      if (candidate in excluded) next
      if (!sub("/[^/]+$", "", candidate)) break
    }
    print path
  }
' "$exclude_file" "$archive_members" > "$extract_members"
filter_status=$?
case "$filter_status" in
  0) ;;
  2) printf 'Unsafe extraction exclusion path\n' >&2; exit 1 ;;
  3) printf 'Unsafe archive member\n' >&2; exit 1 ;;
  *) printf 'Could not filter archive members\n' >&2; exit 1 ;;
esac
[ -s "$extract_members" ] || {
  printf 'Archive has no extractable members: %s\n' "$archive" >&2
  exit 1
}

permission_records=$(mktemp "${RUNNER_TEMP:-/tmp}/php-darwin-permissions.XXXXXX") || exit 1
awk '
  {
    path=$0
    while (sub("/[^/]+$", "", path)) print path
  }
' "$extract_members" | LC_ALL=C sort -u > "$archive_members" || exit 1
: > "$permission_records" || exit 1
current_uid=$(id -u) || exit 1
current_gid=$(id -g) || exit 1
while IFS= read -r relative_path; do
  absolute_path="$prefix/$relative_path"
  [ ! -L "$absolute_path" ] || {
    printf 'Extraction parent is a symlink: %s\n' "$relative_path" >&2
    exit 1
  }
  [ -d "$absolute_path" ] || continue
  [ ! -w "$absolute_path" ] || continue
  uid=$(path_uid "$absolute_path") || exit 1
  gid=$(path_gid "$absolute_path") || exit 1
  mode=$(path_mode "$absolute_path") || exit 1
  if [ "$uid" = "$current_uid" ]; then
    changed_owner=false
  else
    changed_owner=true
  fi
  printf '%s\t%s\t%s\t%s\t%s\n' "$relative_path" "$uid" "$gid" "$mode" \
    "$changed_owner" >> "$permission_records" || exit 1
  if [ "$changed_owner" = true ]; then
    command -v sudo >/dev/null 2>&1 && \
      sudo -n chown "$current_uid:$current_gid" "$absolute_path" || exit 1
  fi
  chmod u+rwx "$absolute_path" || exit 1
  [ -w "$absolute_path" ] || exit 1
done < "$archive_members"

[ ! -s "$permission_records" ] || \
  printf 'Temporarily granting access to protected Homebrew directories\n'
tar --ignore-zeros -xkmpf "$archive" --no-same-owner -C "$prefix" -T "$extract_members"
extract_status=$?
restore_permissions || exit 1
exit "$extract_status"
)

# Source: scripts/install-package.sh



php_darwin_set_phase input
version=${1:-}
build=${2:-release}
ts=${3:-nts}
local_archive=${4:-}
arch=$(php_darwin_normalize_arch "$(uname -m)") || exit 1

php_darwin_set_phase environment
[ "$(uname -s)" = Darwin ] || php_darwin_die 'the cache installer only supports macOS'
for required_command in brew curl jq tar zstd; do
  command -v "$required_command" >/dev/null 2>&1 || php_darwin_die "$required_command is required"
done

install_config=$(jq -ers --arg arch "$arch" '
  def install_string: type == "string" and length > 0 and test("^[^\\r\\n\\t]+$");
  .[0] as $package | .[1][$arch] as $platform |
  select(($package.current_version | install_string) and
    ($package.release_repository | install_string) and
    ($package.tap | install_string) and
    ($package.tap_repository | install_string) and
    ($package.tap_branch | install_string) and
    ($package.tap_snapshot | install_string) and
    ($platform.brew_prefix | install_string) and
    ($platform.minimum_macos | type == "number" and floor == . and . > 0) and
    ($platform.platform_key | install_string)) |
  [$package.current_version, $package.release_repository, $package.tap,
   $package.tap_repository, $package.tap_branch, $package.tap_snapshot,
   $platform.brew_prefix, ($platform.minimum_macos | tostring), $platform.platform_key] | @tsv
' < <(php_darwin_read_config package.json; php_darwin_read_config platforms.json)) || \
  php_darwin_die 'could not read the package and platform configuration'
IFS=$'\t' read -r current_version package_release_repository tap tap_repository tap_branch \
  tap_snapshot expected_prefix minimum_macos platform_key install_config_extra <<< "$install_config" || \
  php_darwin_die 'could not parse the package and platform configuration'
[ -z "$install_config_extra" ] && [ -n "$platform_key" ] || \
  php_darwin_die 'package and platform configuration fields are invalid'
[ -n "$version" ] || version=$current_version
php_darwin_validate_version "$version"
channel=$(php_darwin_version_channel "$version") || exit 1
php_darwin_validate_build "$build"
php_darwin_validate_ts "$ts"
requested_formula=$(php_darwin_requested_formula "$version" "$build" "$ts") || exit 1
formula=$(php_darwin_formula "$version" "$build" "$ts" "$current_version") || exit 1
config_id=$(php_darwin_config_id "$version" "$build" "$ts") || exit 1
asset=$(php_darwin_asset "$version" "$build" "$ts" "$arch") || exit 1
pear_path=$(php_darwin_pear_path "$version" "$formula") || exit 1
internal_metadata_path=$(php_darwin_metadata_path "$asset") || exit 1

brew_command=$(command -v brew)
if [ "$brew_command" = "$expected_prefix/bin/brew" ]; then
  brew_prefix=$expected_prefix
else
  brew_prefix=$(brew --prefix) || php_darwin_die 'could not determine the Homebrew prefix'
fi
[ "$brew_prefix" = "$expected_prefix" ] || php_darwin_die "architecture $arch requires Homebrew at $expected_prefix, found $brew_prefix"
internal_metadata_dir="$brew_prefix/${internal_metadata_path%/*}"
macos_version=$(sw_vers -productVersion) || php_darwin_die 'could not determine the macOS version'
macos_major=${macos_version%%.*}
case "$tap_snapshot" in var/php-darwin/*) ;; *)
  php_darwin_die "unsafe Homebrew tap snapshot path: $tap_snapshot"
  ;;
esac
case "$tap_snapshot" in *$'\n'*|*$'\r'*|*$'\t'*|*'/../'*|../*|*/..|*'//'* )
  php_darwin_die "unsafe Homebrew tap snapshot path: $tap_snapshot"
  ;;
esac

[ ! -L "$internal_metadata_dir" ] || php_darwin_die 'embedded metadata directory is a symlink'
[ ! -e "$internal_metadata_dir" ] || [ -d "$internal_metadata_dir" ] || \
  php_darwin_die 'embedded metadata path is not a directory'
mkdir -p "$internal_metadata_dir" || php_darwin_die 'could not create the embedded metadata directory'

while IFS= read -r managed_dir extra; do
  [ -n "$managed_dir" ] || continue
  case "$managed_dir" in \#*) continue ;; esac
  [ -z "$extra" ] || php_darwin_die "invalid archive root: $managed_dir $extra"
  case "$managed_dir" in Cellar|Frameworks|bin|etc|include|lib|opt|sbin|share|var) ;; *)
    php_darwin_die "unsafe archive root: $managed_dir"
    ;;
  esac
  [ ! -L "$brew_prefix/$managed_dir" ] || \
    php_darwin_die "Homebrew directory is a symlink: $brew_prefix/$managed_dir"
  [ -d "$brew_prefix/$managed_dir" ] || mkdir -p "$brew_prefix/$managed_dir" || \
    php_darwin_die "could not create Homebrew directory: $brew_prefix/$managed_dir"
  [ -w "$brew_prefix/$managed_dir" ] || \
    php_darwin_die "Homebrew directory is not writable: $brew_prefix/$managed_dir"
done < <(php_darwin_read_config archive-paths)

php_darwin_configure_homebrew_environment

tmp_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-install.XXXXXX") || \
  php_darwin_die 'could not create the installation directory'
archive_roots_file="$tmp_dir/archive-paths.txt"
php_darwin_read_config archive-paths > "$archive_roots_file" || \
  php_darwin_die 'could not stage the archive root configuration'
tap_log="$tmp_dir/homebrew-tap.log"
tap_pid=
tap_action_file="$tmp_dir/homebrew-tap-action.txt"
homebrew_prepare_log="$tmp_dir/homebrew-prepare.log"
homebrew_prepare_pid=
homebrew_prepare_phase_file="$tmp_dir/homebrew-prepare-phase.txt"
tap_path_file="$tmp_dir/homebrew-tap-path.txt"
tap_trust_file="$tmp_dir/homebrew-tap-trust.txt"
trust_json_file="$tmp_dir/homebrew-trust.json"
missing_log="$tmp_dir/homebrew-missing.log"
missing_pid=
missing_status=
missing_output=
archive_hash_file="$tmp_dir/archive.sha256"
archive_hash_log="$tmp_dir/archive-hash.log"
archive_hash_pid=
linked_php_references=()
linked_dependency_references=()
postinstall_paths_file="$tmp_dir/postinstall-paths.txt"
postinstall_candidates_file="$tmp_dir/postinstall-candidates.txt"
postinstall_backup_dir="$tmp_dir/postinstall-backup"
postinstall_restored_file="$tmp_dir/postinstall-restored.txt"
pear_backup="$tmp_dir/pear-backup"
pear_backed_up=false
pear_restored=false
previous_opt_links="$tmp_dir/previous-opt-links.tsv"
new_state_paths_file="$tmp_dir/new-state-paths.txt"
target_keg_backup="$tmp_dir/target-keg-backup"
target_keg_backed_up=false
formula_trust_marker="$tmp_dir/formula-trust-added"
formula_trust_pending="$tmp_dir/formula-trust-pending"
tap_was_trusted=false
tap_installed=false
tap_path=
tap_path_backup=
tap_path_backed_up=false
tap_snapshot_backup="$tmp_dir/homebrew-tap-snapshot-backup"
tap_snapshot_backed_up=false
tap_snapshot_extracted=false
tap_replaced=false
tap_restore_after_install=false
dependencies_started_with_pending_tap=false
tap_snapshot_path="$brew_prefix/$tap_snapshot"
: > "$previous_opt_links" || php_darwin_die 'could not create the Homebrew opt-link backup'
: > "$postinstall_restored_file" || php_darwin_die 'could not create the restored-state list'
: > "$new_state_paths_file" || php_darwin_die 'could not create the new-state list'
archive_mutation_started=false
runtime_verified=false
preserve_tmp_dir=false
php_darwin_collect_dependencies() {
  [ -n "$missing_pid" ] || return 0
  if wait "$missing_pid"; then
    missing_status=0
  else
    missing_status=$?
  fi
  missing_pid=
  missing_output=$(cat "$missing_log") || php_darwin_die 'could not read Homebrew dependency diagnostics'
}

php_darwin_validate_dependencies() {
  [ -n "$missing_status" ] || return 0
  [ "$missing_status" -eq 0 ] || [ -n "$missing_output" ] || \
    php_darwin_die 'Homebrew dependency validation failed without diagnostics'
  if [ -n "$missing_output" ]; then
    php_darwin_die "cache has missing Homebrew dependencies: $missing_output"
  fi
  missing_status=
  missing_output=
}

php_darwin_wait_for_dependencies() {
  php_darwin_collect_dependencies
  php_darwin_validate_dependencies
}

php_darwin_resolve_tap_and_dependencies() {
  if [ -n "$tap_pid" ]; then
    # Do not replace the tap while Homebrew is reading the outgoing formula.
    # Its result is authoritative only if that tap remains installed.
    php_darwin_collect_dependencies
    php_darwin_wait_for_tap
    if [ "$tap_replaced" = true ] && [ "$dependencies_started_with_pending_tap" = true ]; then
      missing_status=
      missing_output=
      php_darwin_set_phase homebrew.dependencies
      brew missing "$tap/$formula" > "$missing_log" 2>&1 &
      missing_pid=$!
    fi
  else
    php_darwin_wait_for_tap
  fi
  php_darwin_set_phase homebrew.dependencies
  php_darwin_wait_for_dependencies
}

php_darwin_wait_for_tap() {
  local tap_action
  local tap_status

  [ -n "$tap_pid" ] || return 0
  if wait "$tap_pid"; then
    tap_status=0
  else
    tap_status=$?
  fi
  tap_pid=
  if [ "$tap_status" -ne 0 ]; then
    php_darwin_set_phase homebrew.tap
    cat "$tap_log" >&2
    php_darwin_die "could not validate $tap"
  fi
  php_darwin_set_phase homebrew.tap
  tap_action=$(cat "$tap_action_file") || php_darwin_die "could not read the $tap tap action"
  case "$tap_action" in
    keep)
      find "$tap_snapshot_path" -mindepth 1 -delete || \
        php_darwin_die 'could not remove the unused Homebrew tap snapshot'
      rmdir "$tap_snapshot_path" || php_darwin_die 'could not remove the empty Homebrew tap snapshot'
      tap_snapshot_extracted=false
      ;;
    replace|temporary)
      [ "$tap_action" != temporary ] || tap_restore_after_install=true
      tap_path_backed_up=true
      if ! mv "$tap_path" "$tap_path_backup" 2>/dev/null; then
        command -v sudo >/dev/null 2>&1 || \
          php_darwin_die "could not back up the older $tap snapshot"
        sudo -n mv "$tap_path" "$tap_path_backup" || \
          php_darwin_die "could not back up the older $tap snapshot"
      fi
      tap_installed=true
      if ! mv "$tap_snapshot_path" "$tap_path" 2>/dev/null; then
        command -v sudo >/dev/null 2>&1 || \
          php_darwin_die "could not install the cached $tap snapshot"
        sudo -n mv "$tap_snapshot_path" "$tap_path" || \
          php_darwin_die "could not install the cached $tap snapshot"
      fi
      tap_snapshot_extracted=false
      tap_replaced=true
      ;;
    *) php_darwin_die "invalid $tap tap action: $tap_action" ;;
  esac
}

php_darwin_wait_for_homebrew_prepare() {
  local failed_phase
  local prepare_status

  [ -n "$homebrew_prepare_pid" ] || return 0
  if wait "$homebrew_prepare_pid"; then
    prepare_status=0
  else
    prepare_status=$?
  fi
  homebrew_prepare_pid=
  if [ "$prepare_status" -ne 0 ]; then
    failed_phase=$(cat "$homebrew_prepare_phase_file" 2>/dev/null) || \
      failed_phase=homebrew.prepare
    case "$failed_phase" in
      homebrew.trust-state|homebrew.tap-path|homebrew.unlink) ;;
      *) failed_phase=homebrew.prepare ;;
    esac
    php_darwin_set_phase "$failed_phase"
    cat "$homebrew_prepare_log" >&2
    case "$failed_phase" in
      homebrew.trust-state) php_darwin_die "could not read the $tap trust state" ;;
      homebrew.tap-path) php_darwin_die "could not resolve the $tap repository path" ;;
      homebrew.unlink) php_darwin_die 'could not unlink the active Homebrew PHP formulae' ;;
      *) php_darwin_die 'could not prepare Homebrew for cache installation' ;;
    esac
  fi
  tap_path=$(cat "$tap_path_file") || php_darwin_die "could not read the $tap repository path"
  tap_was_trusted=$(cat "$tap_trust_file") || \
    php_darwin_die "could not read the $tap trust state"
  case "$tap_was_trusted" in true|false) ;; *) php_darwin_die "invalid $tap trust state" ;; esac
}

php_darwin_start_archive_hash() {
  local archive_to_hash=$1

  (
    php_darwin_sha256 "$archive_to_hash" > "$archive_hash_file"
  ) > "$archive_hash_log" 2>&1 &
  archive_hash_pid=$!
}

php_darwin_wait_for_archive_hash() {
  local hash_status

  [ -n "$archive_hash_pid" ] || return 0
  if wait "$archive_hash_pid"; then
    hash_status=0
  else
    hash_status=$?
  fi
  archive_hash_pid=
  if [ "$hash_status" -ne 0 ]; then
    cat "$archive_hash_log" >&2
    php_darwin_die "could not hash $asset"
  fi
  actual_hash=$(cat "$archive_hash_file") || php_darwin_die "could not read the $asset hash"
}

php_darwin_restore_formula_trust() {
  local added_formula
  local added_formulae=()
  local formulae_to_untrust=()
  local trust_entries_file
  local trust_json
  local trust_status

  [ -f "$formula_trust_marker" ] || [ -f "$formula_trust_pending" ] || return 0
  trust_entries_file=$formula_trust_marker
  [ -s "$trust_entries_file" ] || trust_entries_file=$formula_trust_pending
  while IFS= read -r added_formula; do
    case "$added_formula" in "$tap/"*) added_formulae+=("$added_formula") ;; *) return 1 ;; esac
  done < "$trust_entries_file"
  [ "${#added_formulae[@]}" -gt 0 ] || return 1
  trust_json=$(brew trust --json=v1) || return 1
  for added_formula in "${added_formulae[@]}"; do
    if php_darwin_formula_trusted "$added_formula" "$trust_json"; then
      formulae_to_untrust+=("$added_formula")
    else
      trust_status=$?
      [ "$trust_status" -eq 1 ] || return 1
    fi
  done
  if [ "${#formulae_to_untrust[@]}" -gt 0 ]; then
    brew untrust --formula "${formulae_to_untrust[@]}" || {
      printf 'Run brew untrust --formula %s to remove trust added by the failed cache install\n' \
        "${formulae_to_untrust[*]}" >&2
      return 1
    }
  fi
  rm -f "$formula_trust_marker" "$formula_trust_pending"
}

php_darwin_install_cleanup() {
  cleanup_status=$?
  rollback_status=ok
  rollback_attempted=false
  rollback_log="$tmp_dir/rollback.log"
  trap - EXIT
  trap '' HUP INT TERM
  : > "$rollback_log"
  # Give the potentially mutating Homebrew preparation a bounded opportunity
  # to finish. Read-only validation jobs can be stopped immediately.
  php_darwin_reap_job "$homebrew_prepare_pid" 20
  php_darwin_reap_job "$tap_pid" 0
  php_darwin_reap_job "$missing_pid" 0
  php_darwin_reap_job "$archive_hash_pid" 0
  if [ "$cleanup_status" -ne 0 ] && [ "$runtime_verified" = false ]; then
    rollback_attempted=true
    if [ "$tap_installed" = true ]; then
      if [ ! -e "$tap_path" ] && [ ! -L "$tap_path" ]; then
        :
      elif [ -d "$tap_path" ] && [ ! -L "$tap_path" ]; then
        php_darwin_remove_tap_path "$brew_prefix" "$tap_path" >> "$rollback_log" 2>&1 || \
          rollback_status=failed
      else
        rollback_status=failed
      fi
    fi
    if [ "$tap_path_backed_up" = true ]; then
      if [ ! -e "$tap_path_backup" ] && [ ! -L "$tap_path_backup" ] && \
        { [ -e "$tap_path" ] || [ -L "$tap_path" ]; }; then
        tap_path_backed_up=false
      elif php_darwin_restore_tap_path "$tap_path" "$tap_path_backup" >> "$rollback_log" 2>&1; then
        tap_path_backed_up=false
      else
        rollback_status=failed
      fi
    fi
    if [ "$tap_snapshot_extracted" = true ] && \
      { [ -e "$tap_snapshot_path" ] || [ -L "$tap_snapshot_path" ]; }; then
      if [ -d "$tap_snapshot_path" ] && [ ! -L "$tap_snapshot_path" ]; then
        find "$tap_snapshot_path" -mindepth 1 -delete >> "$rollback_log" 2>&1 && \
          rmdir "$tap_snapshot_path" >> "$rollback_log" 2>&1 || rollback_status=failed
      else
        rollback_status=failed
      fi
    fi
    if [ "$tap_snapshot_backed_up" = true ] && [ -d "$tap_snapshot_backup" ]; then
      mkdir -p "${tap_snapshot_path%/*}" >> "$rollback_log" 2>&1 && \
        mv "$tap_snapshot_backup" "$tap_snapshot_path" >> "$rollback_log" 2>&1 || rollback_status=failed
    fi
    if [ -s "${changed_formulae_file:-}" ]; then
      if [ -s "${links_file:-}" ]; then
        while IFS=$'\t' read -r rollback_link rollback_target; do
          rollback_owned=false
          while IFS= read -r rollback_formula; do
            case "$rollback_target" in *"Cellar/$rollback_formula/"*) rollback_owned=true; break ;; esac
          done < "$changed_formulae_file"
          if [ "$rollback_owned" = true ] && [ -L "$brew_prefix/$rollback_link" ] && \
            [ "$(readlink "$brew_prefix/$rollback_link")" = "$rollback_target" ]; then
            rm -f "$brew_prefix/$rollback_link" >> "$rollback_log" 2>&1 || rollback_status=failed
          fi
        done < "$links_file"
      fi
      if [ -s "${packages_file:-}" ]; then
        while IFS=$'\t' read -r rollback_formula rollback_opt_target rollback_keg_only; do
          case "$rollback_keg_only" in true|false) ;; *) rollback_status=failed; continue ;; esac
          grep -Fxq "$rollback_formula" "$changed_formulae_file" || continue
          rollback_opt="$brew_prefix/opt/$rollback_formula"
          if [ -L "$rollback_opt" ] && [ "$(readlink "$rollback_opt")" = "$rollback_opt_target" ]; then
            rm -f "$rollback_opt" >> "$rollback_log" 2>&1 || rollback_status=failed
          fi
          rollback_keg=${rollback_opt_target#../}
          case "$rollback_keg" in "Cellar/$rollback_formula/"*)
            rm -rf "${brew_prefix:?}/${rollback_keg:?}" >> "$rollback_log" 2>&1 || rollback_status=failed
            ;;
          esac
        done < "$packages_file"
      fi
      while IFS=$'\t' read -r rollback_formula rollback_opt_target; do
        rollback_opt="$brew_prefix/opt/$rollback_formula"
        if [ -e "$rollback_opt" ] && [ ! -L "$rollback_opt" ]; then
          rollback_status=failed
          continue
        fi
        if [ ! -L "$rollback_opt" ] || [ "$(readlink "$rollback_opt")" != "$rollback_opt_target" ]; then
          rm -f "$rollback_opt" >> "$rollback_log" 2>&1 && \
            ln -s "$rollback_opt_target" "$rollback_opt" >> "$rollback_log" 2>&1 || rollback_status=failed
        fi
      done < "$previous_opt_links"
    fi
    if [ "$target_keg_backed_up" = true ]; then
      if [ -e "$brew_prefix/$target_keg_relative" ] || [ -L "$brew_prefix/$target_keg_relative" ]; then
        rm -rf "${brew_prefix:?}/${target_keg_relative:?}" >> "$rollback_log" 2>&1 || \
          rollback_status=failed
      fi
      mkdir -p "$brew_prefix/${target_keg_relative%/*}" >> "$rollback_log" 2>&1 && \
        mv "$target_keg_backup" "$brew_prefix/$target_keg_relative" >> "$rollback_log" 2>&1 || \
        rollback_status=failed
      target_keg_backed_up=false
    fi
    if [ "$archive_mutation_started" = true ] && [ -s "$new_state_paths_file" ]; then
      while IFS= read -r rollback_state_path; do
        [ -n "$rollback_state_path" ] || continue
        rm -rf "${brew_prefix:?}/${rollback_state_path:?}" >> "$rollback_log" 2>&1 || \
          rollback_status=failed
      done < "$new_state_paths_file"
    fi
    if [ "$pear_backed_up" = true ]; then
      rm -rf "${brew_prefix:?}/${pear_path:?}" >> "$rollback_log" 2>&1 || rollback_status=failed
      mkdir -p "$brew_prefix/${pear_path%/*}" >> "$rollback_log" 2>&1 && \
        mv "$pear_backup" "$brew_prefix/$pear_path" >> "$rollback_log" 2>&1 || rollback_status=failed
      pear_backed_up=false
    elif [ "$archive_mutation_started" = true ] && [ "$pear_restored" = false ]; then
      rm -rf "${brew_prefix:?}/${pear_path:?}" >> "$rollback_log" 2>&1 || rollback_status=failed
    fi
    if [ -s "$postinstall_paths_file" ]; then
      while IFS= read -r postinstall_path; do
        [ -n "$postinstall_path" ] || continue
        if [ -e "$postinstall_backup_dir/$postinstall_path" ] || \
          [ -L "$postinstall_backup_dir/$postinstall_path" ]; then
          rm -rf "${brew_prefix:?}/${postinstall_path:?}" >> "$rollback_log" 2>&1 || rollback_status=failed
          mkdir -p "$brew_prefix/${postinstall_path%/*}" >> "$rollback_log" 2>&1 && \
            mv "$postinstall_backup_dir/$postinstall_path" "$brew_prefix/$postinstall_path" \
              >> "$rollback_log" 2>&1 || rollback_status=failed
        elif grep -Fxq "$postinstall_path" "$postinstall_restored_file"; then
          continue
        elif [ "$archive_mutation_started" = true ]; then
          rm -rf "${brew_prefix:?}/${postinstall_path:?}" >> "$rollback_log" 2>&1 || rollback_status=failed
        fi
      done < "$postinstall_paths_file"
    fi
    if [ "$archive_mutation_started" = true ]; then
      rm -f "$brew_prefix/$internal_metadata_path" >> "$rollback_log" 2>&1 || rollback_status=failed
    fi
    if [ "${#linked_php_references[@]}" -gt 0 ]; then
      brew link --overwrite --force "${linked_php_references[@]}" >> "$rollback_log" 2>&1 || \
        rollback_status=failed
    fi
    if [ "${#linked_dependency_references[@]}" -gt 0 ]; then
      brew link --overwrite "${linked_dependency_references[@]}" >> "$rollback_log" 2>&1 || \
        rollback_status=failed
    fi
    php_darwin_restore_formula_trust >> "$rollback_log" 2>&1 || rollback_status=failed
  fi
  if [ "$cleanup_status" -ne 0 ]; then
    if [ "$rollback_attempted" = false ]; then
      printf 'php-darwin: verified installation preserved after post-install interruption\n' >&2
    elif [ "$rollback_status" = failed ]; then
      printf 'php-darwin: rollback failed; Homebrew diagnostics follow\n' >&2
      cat "$rollback_log" >&2
    fi
    [ "$rollback_attempted" = false ] || printf 'php-darwin: rollback %s\n' "$rollback_status" >&2
  fi
  if [ "$runtime_verified" = true ] && [ "$tap_snapshot_backed_up" = true ]; then
    preserve_tmp_dir=true
    printf 'php-darwin: restore the previous cache tap with: sudo mv %s %s\n' \
      "$tap_snapshot_backup" "$tap_snapshot_path" >&2
  fi
  if [ "$preserve_tmp_dir" = true ]; then
    printf 'php-darwin: preserved recovery files in %s\n' "$tmp_dir" >&2
  else
    rm -rf "$tmp_dir"
  fi
  exit "$cleanup_status"
}
trap php_darwin_install_cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Homebrew preparation and reading the cache are independent. Keep Homebrew
# operations serial within one worker while overlapping them with the archive
# download, checksum, and metadata validation.
for linked_php_path in "$brew_prefix/var/homebrew/linked"/php*; do
  [ -L "$linked_php_path" ] || continue
  linked_php_formula=${linked_php_path##*/}
  php_darwin_is_php_formula "$linked_php_formula" || continue
  linked_php_target=$(readlink "$linked_php_path") || \
    php_darwin_die "could not read the linked Homebrew formula $linked_php_formula"
  case "$linked_php_target" in "../../../Cellar/$linked_php_formula/"*) ;; *)
    php_darwin_die "invalid linked Homebrew formula target: $linked_php_target"
    ;;
  esac
  linked_php_reference=$(php_darwin_keg_formula_reference "$brew_prefix" "$linked_php_formula" \
    "${linked_php_target#../../../}" "$tap") || \
    php_darwin_die "could not resolve the installed Homebrew formula $linked_php_formula"
  linked_php_references+=("$linked_php_reference")
done
: > "$homebrew_prepare_phase_file" || php_darwin_die 'could not create the Homebrew preparation phase file'
(
  printf 'homebrew.trust-state\n' > "$homebrew_prepare_phase_file" || exit 1
  trust_json=$(brew trust --json=v1) || exit 1
  printf '%s\n' "$trust_json" > "$trust_json_file" || exit 1
  if php_darwin_tap_trusted "$tap" "$trust_json"; then
    printf 'true\n' > "$tap_trust_file" || exit 1
  else
    trust_status=$?
    [ "$trust_status" -eq 1 ] || exit 1
    printf 'false\n' > "$tap_trust_file" || exit 1
  fi
  printf 'homebrew.tap-path\n' > "$homebrew_prepare_phase_file" || exit 1
  brew --repository "$tap" > "$tap_path_file" || exit 1
  if [ "${#linked_php_references[@]}" -gt 0 ]; then
    printf 'homebrew.unlink\n' > "$homebrew_prepare_phase_file" || exit 1
    brew unlink "${linked_php_references[@]}" || exit 1
  fi
) > "$homebrew_prepare_log" 2>&1 &
homebrew_prepare_pid=$!

archive="$tmp_dir/$asset"
external_metadata=
cached_source_hash=
manifest_homebrew_commit=
manifest_php_src_commit=
manifest_php_semver=
manifest_source_hash=
manifest_download_asset=
manifest_extensions_commit=
manifest_from_embedded=false
release_archive_error=

php_darwin_use_release_manifest() {
  local manifest_file=$1
  local manifest_values

  manifest_values=$(php_darwin_validate_release_manifest \
    "$manifest_file" "$version" "$channel" "$asset") || return 1
  IFS=$'\t' read -r expected_hash manifest_homebrew_commit manifest_php_src_commit \
    manifest_php_semver manifest_source_hash manifest_download_asset manifest_extensions_commit \
    <<< "$manifest_values" || return 1
  [ -n "$expected_hash" ] && [ -n "$manifest_homebrew_commit" ] && \
    [ -n "$manifest_php_src_commit" ] && [ -n "$manifest_php_semver" ] && \
    [ -n "$manifest_source_hash" ] && [ -n "$manifest_download_asset" ] && \
    [ -n "$manifest_extensions_commit" ] || return 1
  [ "$manifest_php_src_commit" != - ] || manifest_php_src_commit=
  [ "$manifest_extensions_commit" != - ] || manifest_extensions_commit=
}

php_darwin_refresh_release_manifest() {
  manifest_url=${PHP_DARWIN_MANIFEST_URL:-}
  [ -n "$manifest_url" ] || manifest_url=$(php_darwin_release_manifest_url "$release_repository" "$version") || \
    php_darwin_die 'could not construct the release manifest URL'
  manifest_status=$(php_darwin_fetch_release_manifest "$release_repository" "$version" \
    "$release_manifest" "$manifest_url") || php_darwin_die "could not request $manifest_url"
  [ "$manifest_status" = 200 ] || \
    php_darwin_die "could not fetch the PHP $version release manifest (HTTP $manifest_status)"
  php_darwin_use_release_manifest "$release_manifest" || \
    php_darwin_die 'release manifest did not match the requested PHP version'
  manifest_from_embedded=false
}

php_darwin_download_release_archive() {
  local archive_curl_status
  local archive_http_status

  release_archive_error=
  release_url=${PHP_DARWIN_RELEASE_URL:-https://github.com/$release_repository/releases/download/php-$version/$manifest_download_asset}
  # Do not retry a retired immutable name: a single 404 should immediately
  # fall through to the current manifest instead of consuming the fetch budget.
  archive_http_status=$(curl --retry 3 -fsSL -w '%{http_code}' "$release_url" -o "$archive")
  archive_curl_status=$?
  if [ "$archive_curl_status" -ne 0 ]; then
    if [ "$archive_http_status" = 404 ]; then
      release_archive_error=not-found
    else
      release_archive_error=download
    fi
    return 1
  fi
  [ "$archive_http_status" = 200 ] || {
    release_archive_error=download
    return 1
  }
  php_darwin_start_archive_hash "$archive"
  php_darwin_wait_for_archive_hash
  [ "$actual_hash" = "$expected_hash" ] || {
    release_archive_error=checksum
    return 1
  }
}

php_darwin_set_phase fetch
metadata_copy="$tmp_dir/cache-metadata.json"
if [ -n "$local_archive" ]; then
  archive=$local_archive
  checksum="$local_archive.sha256"
  external_metadata="$(dirname "$local_archive")/${asset%.tar.zst}.json"
  [ -f "$archive" ] || php_darwin_die "archive not found: $archive"
  [ -f "$checksum" ] || php_darwin_die "checksum not found: $checksum"
  [ -f "$external_metadata" ] || php_darwin_die "metadata not found: $external_metadata"
  expected_hash=$(php_darwin_checksum_from_file "$checksum" "$asset") || \
    php_darwin_die "checksum file does not contain $asset"
  php_darwin_start_archive_hash "$archive"
  cp "$external_metadata" "$metadata_copy" || php_darwin_die 'could not copy external cache metadata'
  php_darwin_wait_for_archive_hash
  [ "$actual_hash" = "$expected_hash" ] || php_darwin_die "checksum mismatch for $asset"
else
  release_repository=${PHP_DARWIN_RELEASE_REPOSITORY:-$package_release_repository}
  [[ "$release_repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || \
    php_darwin_die "invalid release repository: $release_repository"
  release_manifest="$tmp_dir/php-$version-manifest.json"
  if php_darwin_read_config release-manifest.json > "$release_manifest" 2>/dev/null; then
    if php_darwin_use_release_manifest "$release_manifest"; then
      manifest_from_embedded=true
    else
      php_darwin_refresh_release_manifest
    fi
  else
    php_darwin_refresh_release_manifest
  fi
  if ! php_darwin_download_release_archive; then
    if [ "$manifest_from_embedded" = true ] && [ "$release_archive_error" = not-found ] && \
      [ -z "${PHP_DARWIN_RELEASE_URL:-}" ]; then
      printf 'Embedded release archive was retired; retrying with the current release manifest\n' >&2
      php_darwin_refresh_release_manifest
      if ! php_darwin_download_release_archive; then
        case "$release_archive_error" in
          checksum) php_darwin_die "checksum mismatch for the current release archive $asset" ;;
          *) php_darwin_die "could not download the current release archive from $release_url" ;;
        esac
      fi
    else
      case "$release_archive_error" in
        checksum) php_darwin_die "checksum mismatch for $asset" ;;
        *) php_darwin_die "could not download $release_url" ;;
      esac
    fi
  fi
  [ "$actual_hash" = "$expected_hash" ] || php_darwin_die "checksum mismatch for $asset"
  php_darwin_read_metadata "$archive" "$internal_metadata_path" "$metadata_copy" || \
    php_darwin_die 'could not read metadata from the verified release archive'
fi

php_darwin_set_phase cache.metadata
expected_metadata_commit=${HOMEBREW_PHP_COMMIT:-$manifest_homebrew_commit}
metadata_values=$(php_darwin_validate_cache_metadata "$metadata_copy" "$version" "$build" "$ts" "$arch" \
  "$brew_prefix" "$macos_major" "$expected_metadata_commit" "$manifest_php_src_commit" \
  "$current_version" "$tap_snapshot" "$minimum_macos" "$platform_key" \
  "$manifest_extensions_commit") || \
  php_darwin_die 'cache metadata did not match the runner or request'
IFS=$'\t' read -r metadata_homebrew_commit cached_source_hash target_keg_relative pecl_extension \
  metadata_php_semver <<< "$metadata_values" || \
  php_darwin_die 'could not parse the validated cache metadata'
if [ -n "$manifest_source_hash" ]; then
  [ "$cached_source_hash" = "$manifest_source_hash" ] || \
    php_darwin_die 'cache metadata source hash does not match the release manifest'
  [ "$metadata_php_semver" = "$manifest_php_semver" ] || \
    php_darwin_die 'cache PHP version does not match the release manifest'
fi

existing_kegs="$tmp_dir/existing-kegs.txt"
changed_formulae_file="$tmp_dir/changed-formulae.txt"
packages_file="$tmp_dir/packages.tsv"
package_kegs_file="$tmp_dir/package-kegs.txt"
links_file="$tmp_dir/links.tsv"
managed_paths_file="$tmp_dir/managed-paths.txt"
exclude_file="$tmp_dir/existing-paths.txt"
metadata_records_file="$tmp_dir/metadata-records.tsv"
state_paths_inventory="$tmp_dir/state-paths-inventory.txt"
extension_paths_inventory="$tmp_dir/extension-paths-inventory.tsv"
tap_formulae_file="$tmp_dir/tap-formulae.txt"
: > "$packages_file" || php_darwin_die 'could not create the Homebrew package receipt list'
: > "$package_kegs_file" || php_darwin_die 'could not create the Homebrew keg path list'
: > "$managed_paths_file" || php_darwin_die 'could not create the managed archive path list'
: > "$links_file" || php_darwin_die 'could not create the Homebrew link list'
: > "$state_paths_inventory" || php_darwin_die 'could not create the Homebrew state path list'
: > "$extension_paths_inventory" || php_darwin_die 'could not create the cached extension path list'
jq -er '
  if ((.tap_formulae // []) | length) > 0 then .tap_formulae[] else .formula end
' "$metadata_copy" > "$tap_formulae_file" || \
  php_darwin_die 'could not read embedded custom-tap formulae'
jq -r '[
    (.packages[] | ["package", .name, .opt_target, (.keg_only | tostring)]),
    (.packages[] | ["keg", (.opt_target | ltrimstr("../"))]),
    (.links[] | ["managed", .path]),
    ((.extensions // [])[] | ["extension", .name, .type, .path]),
    ((.extensions // [])[] | ["managed", .path]),
    (.packages[] | ["managed", ("opt/" + .name)]),
    (.links[] | ["link", .path, .target])
  ][] | @tsv' "$metadata_copy" > "$metadata_records_file" || \
  php_darwin_die 'could not read embedded Homebrew installation records'
awk -F '\t' -v packages="$packages_file" -v kegs="$package_kegs_file" \
  -v extensions="$extension_paths_inventory" -v managed="$managed_paths_file" -v links="$links_file" '
  $1 == "package" && NF == 4 { print $2 "\t" $3 "\t" $4 > packages; next }
  $1 == "keg" && NF == 2 { print $2 > kegs; next }
  $1 == "extension" && NF == 4 { print $2 "\t" $3 "\t" $4 > extensions; next }
  $1 == "managed" && NF == 2 { print $2 > managed; next }
  $1 == "link" && NF == 3 { print $2 "\t" $3 > links; next }
  { exit 1 }
' "$metadata_records_file" || php_darwin_die 'could not split embedded Homebrew installation records'
jq -er '.state_paths[]' "$metadata_copy" > "$state_paths_inventory" || \
  php_darwin_die 'could not read embedded Homebrew state paths'
cat "$state_paths_inventory" >> "$managed_paths_file" || \
  php_darwin_die 'could not add embedded Homebrew state paths'
while IFS= read -r state_path; do
  if [ ! -e "$brew_prefix/$state_path" ] && [ ! -L "$brew_prefix/$state_path" ]; then
    printf '%s\n' "$state_path" >> "$new_state_paths_file" || \
      php_darwin_die "could not record new Homebrew state path: $state_path"
  fi
done < "$state_paths_inventory"
while IFS=$'\t' read -r extension extension_type extension_path; do
  [ -n "$extension_path" ] || continue
  if [ ! -e "$brew_prefix/$extension_path" ] && [ ! -L "$brew_prefix/$extension_path" ]; then
    printf '%s\n' "$extension_path" >> "$new_state_paths_file" || \
      php_darwin_die "could not record new cached extension path: $extension_path"
  fi
done < "$extension_paths_inventory"

php_darwin_set_phase homebrew.tap
php_darwin_wait_for_homebrew_prepare
case "$tap_path" in
  "$brew_prefix/Library/Taps/"*|"$brew_prefix/Homebrew/Library/Taps/"*) ;;
  *) php_darwin_die "unexpected Homebrew tap path: $tap_path" ;;
esac
[ ! -L "$tap_path" ] || php_darwin_die "Homebrew tap path is a symlink: $tap_path"
tap_path_backup=$(php_darwin_tap_backup_path "$brew_prefix" "$tap_path" "$tmp_dir") || \
  php_darwin_die 'could not resolve the Homebrew tap backup path'
tap_path_state=$(php_darwin_prepare_tap_path "$tap_path" "$tap_path_backup") || \
  php_darwin_die "could not prepare the $tap tap path"
case "$tap_path_state" in
  backed-up) tap_path_backed_up=true ;;
  absent|git) ;;
  *) php_darwin_die "invalid $tap tap-path state: $tap_path_state" ;;
esac

php_darwin_set_phase cache.validation

# Keep older kegs side-by-side as Homebrew does during an upgrade. An exact
# cached keg must be removed before extraction; otherwise Homebrew only needs
# to unlink the active PHP formulae. Formula-managed post-install state is
# moved aside so the cache can replace it and restore it if installation fails.
php_darwin_set_phase homebrew.prepare
if [ -e "$tap_snapshot_path" ] || [ -L "$tap_snapshot_path" ]; then
  [ -d "$tap_snapshot_path" ] && [ ! -L "$tap_snapshot_path" ] || \
    php_darwin_die "Homebrew tap snapshot path is not a directory: $tap_snapshot"
  mv "$tap_snapshot_path" "$tap_snapshot_backup" || \
    php_darwin_die 'could not back up the existing Homebrew tap snapshot'
  tap_snapshot_backed_up=true
fi
if [ -d "$brew_prefix/$target_keg_relative" ]; then
  target_opt_path="$brew_prefix/opt/$formula"
  if [ -L "$target_opt_path" ]; then
    target_opt_previous=$(readlink "$target_opt_path") || \
      php_darwin_die "could not read the existing Homebrew opt link for $formula"
    case "$target_opt_previous" in "../Cellar/$formula/"*) ;; *)
      php_darwin_die "unsupported existing Homebrew opt link for $formula: $target_opt_previous"
      ;;
    esac
    printf '%s\t%s\n' "$formula" "$target_opt_previous" >> "$previous_opt_links" || \
      php_darwin_die "could not preserve the existing Homebrew opt link for $formula"
  fi
  mv "$brew_prefix/$target_keg_relative" "$target_keg_backup" || \
    php_darwin_die "could not back up the existing cached $formula keg"
  target_keg_backed_up=true
fi
php_darwin_postinstall_paths "$version" "$formula" "$build" "$ts" > "$postinstall_candidates_file" || \
  php_darwin_die 'could not resolve formula-managed post-install paths'
: > "$postinstall_paths_file" || php_darwin_die 'could not create the post-install path list'
while IFS= read -r postinstall_path; do
  if grep -Fxq "$postinstall_path" "$state_paths_inventory"; then
    printf '%s\n' "$postinstall_path" >> "$postinstall_paths_file" || \
      php_darwin_die "could not record $postinstall_path"
  else
    case "$postinstall_path" in */pear.conf)
      php_darwin_die "cache metadata omitted $postinstall_path"
      ;;
    esac
  fi
done < "$postinstall_candidates_file"
mkdir -p "$postinstall_backup_dir" || php_darwin_die 'could not create the post-install backup directory'
while IFS= read -r postinstall_path; do
  [ -n "$postinstall_path" ] || continue
  if [ -e "$brew_prefix/$postinstall_path" ] || [ -L "$brew_prefix/$postinstall_path" ]; then
    mkdir -p "$postinstall_backup_dir/${postinstall_path%/*}" || \
      php_darwin_die "could not prepare the backup for $postinstall_path"
    mv "$brew_prefix/$postinstall_path" "$postinstall_backup_dir/$postinstall_path" || \
      php_darwin_die "could not back up $postinstall_path"
  fi
done < "$postinstall_paths_file"
if [ -e "$brew_prefix/$pear_path" ] || [ -L "$brew_prefix/$pear_path" ]; then
  mv "$brew_prefix/$pear_path" "$pear_backup" || php_darwin_die "could not back up $pear_path"
  pear_backed_up=true
fi
rm -f "$brew_prefix/$internal_metadata_path" || php_darwin_die 'could not remove stale archive metadata'
printf '%s\n' "$internal_metadata_path" >> "$managed_paths_file" || \
  php_darwin_die 'could not add the embedded metadata path'
printf '%s\n' "$pear_path" >> "$managed_paths_file" || \
  php_darwin_die 'could not add the formula-managed PEAR path'
printf '%s\n' "$tap_snapshot" >> "$managed_paths_file" || \
  php_darwin_die 'could not add the Homebrew tap snapshot path'
cat "$postinstall_paths_file" >> "$managed_paths_file" || \
  php_darwin_die 'could not add formula-managed post-install paths'
LC_ALL=C sort -u "$managed_paths_file" -o "$managed_paths_file" || \
  php_darwin_die 'could not sort managed archive paths'
php_darwin_existing_paths "$brew_prefix" "$exclude_file" \
  "$archive_roots_file" \
  "$existing_kegs" "$managed_paths_file" "$package_kegs_file" || \
  php_darwin_die 'could not record existing Homebrew paths'
: > "$changed_formulae_file"
while IFS=$'\t' read -r package_name opt_target keg_only; do
  keg_relative=${opt_target#../}
  if ! grep -Fxq "$keg_relative" "$existing_kegs"; then
    printf '%s\n' "$package_name" >> "$changed_formulae_file"
    package_preexisting=false
    if awk -v prefix="Cellar/$package_name/" 'index($0, prefix) == 1 { found=1; exit } END { exit !found }' \
      "$existing_kegs"; then
      package_preexisting=true
    fi
    if [ "$package_name" != "$formula" ] && [ "$keg_only" = false ] && \
      [ "$package_preexisting" = true ]; then
      dependency_link="$brew_prefix/var/homebrew/linked/$package_name"
      if [ -L "$dependency_link" ]; then
        dependency_target=$(readlink "$dependency_link") || \
          php_darwin_die "could not read the linked dependency $package_name"
        case "$dependency_target" in "../../../Cellar/$package_name/"*) ;; *)
          php_darwin_die "invalid linked dependency target for $package_name: $dependency_target"
          ;;
        esac
        linked_dependency_references+=("$package_name")
      fi
    fi
  fi
done < "$packages_file"
[ -s "$changed_formulae_file" ] || php_darwin_die 'cache extraction would not add any Homebrew kegs'
grep -Fxq "$formula" "$changed_formulae_file" || php_darwin_die "cache extraction would not add $formula"
if [ "${#linked_dependency_references[@]}" -gt 0 ]; then
  php_darwin_set_phase homebrew.unlink
  brew unlink "${linked_dependency_references[@]}" >/dev/null || \
    php_darwin_die 'could not unlink the existing Homebrew dependencies'
fi

php_darwin_set_phase archive.extract
archive_mutation_started=true
tap_snapshot_extracted=true
php_darwin_extract "$archive" "$brew_prefix" "$exclude_file" || \
  php_darwin_die "could not extract $asset into Homebrew"

php_darwin_set_phase homebrew.tap
[ -d "$tap_snapshot_path/.git" ] && [ ! -L "$tap_snapshot_path" ] || \
  php_darwin_die 'cache did not contain a valid Homebrew tap snapshot'
php_darwin_validate_tap "$tap_snapshot_path" "$version" '' \
  "$tap_repository" "$metadata_homebrew_commit" "$tap_branch" >/dev/null || \
  php_darwin_die 'cached Homebrew tap snapshot validation failed'
if [ -e "$tap_path" ]; then
  php_darwin_is_git_worktree "$tap_path" || \
    php_darwin_die "installed Homebrew tap is not a Git repository: $tap_path"
  php_darwin_tap_action "$tap_path" "$tap_snapshot_path" "$version" \
    "$cached_source_hash" "$tap_repository" "$metadata_homebrew_commit" "$tap_branch" \
    > "$tap_action_file" 2> "$tap_log" &
  tap_pid=$!
else
  tap_parent=${tap_path%/*}
  [ ! -L "$tap_parent" ] || php_darwin_die "Homebrew tap owner path is a symlink: $tap_parent"
  mkdir -p "$tap_parent" || php_darwin_die "could not create the Homebrew tap owner path: $tap_parent"
  mv "$tap_snapshot_path" "$tap_path" || php_darwin_die "could not install the $tap snapshot"
  tap_snapshot_extracted=false
  tap_installed=true
fi

php_darwin_set_phase homebrew.receipts
metadata="$brew_prefix/$internal_metadata_path"
[ -f "$metadata" ] || php_darwin_die 'cache did not contain embedded installation metadata'
cmp -s "$metadata" "$metadata_copy" || \
  php_darwin_die 'extracted installation metadata changed during archive extraction'
rm -f "$metadata" || php_darwin_die 'could not remove embedded installation metadata'
while IFS=$'\t' read -r package_name opt_target keg_only; do
  keg_relative=${opt_target#../}
  [ -d "$brew_prefix/$keg_relative" ] || php_darwin_die "cache did not install $keg_relative"
  if grep -Fxq "$package_name" "$changed_formulae_file"; then
    opt_path="$brew_prefix/opt/$package_name"
    if [ -e "$opt_path" ] && [ ! -L "$opt_path" ]; then
      php_darwin_die "Homebrew opt path is not a symlink: $opt_path"
    fi
    if [ ! -L "$opt_path" ] || [ "$(readlink "$opt_path")" != "$opt_target" ]; then
      if [ -L "$opt_path" ]; then
        previous_opt_target=$(readlink "$opt_path") || \
          php_darwin_die "could not read the previous Homebrew opt link for $package_name"
        case "$previous_opt_target" in *$'\n'*|*$'\r'*|*$'\t'*)
          php_darwin_die "unsupported previous Homebrew opt link for $package_name"
          ;;
        esac
        printf '%s\t%s\n' "$package_name" "$previous_opt_target" >> "$previous_opt_links" || \
          php_darwin_die "could not back up the Homebrew opt link for $package_name"
      fi
      rm -f "$opt_path" || php_darwin_die "could not replace the Homebrew opt link for $package_name"
      ln -s "$opt_target" "$opt_path" || php_darwin_die "could not create the Homebrew opt link for $package_name"
    fi
  fi
done < "$packages_file"
if [ -n "$tap_pid" ] && [ ! -f "$tap_path/Formula/$formula.rb" ]; then
  php_darwin_wait_for_tap
fi
if [ "$tap_was_trusted" = false ]; then
  formula_trust_references=()
  php_darwin_wait_for_tap
  php_darwin_set_phase homebrew.trust
  trust_json=$(cat "$trust_json_file") || php_darwin_die 'could not read the initial Homebrew trust state'
  while IFS= read -r package_name; do
    formula_reference="$tap/$package_name"
    if php_darwin_formula_trusted "$formula_reference" "$trust_json"; then
      continue
    fi
    trust_status=$?
    [ "$trust_status" -eq 1 ] || php_darwin_die "could not read trust for $formula_reference"
    formula_trust_references+=("$formula_reference")
  done < "$tap_formulae_file"
  if [ "${#formula_trust_references[@]}" -gt 0 ]; then
    printf '%s\n' "${formula_trust_references[@]}" > "$formula_trust_pending" || \
      php_darwin_die 'could not record formula trust added by the cache installation'
    printf 'Trusting %s installed Homebrew formula(s) from %s\n' \
      "${#formula_trust_references[@]}" "$tap"
    brew trust --formula "${formula_trust_references[@]}" || \
      php_darwin_die "could not trust installed Homebrew formulae from $tap"
    mv "$formula_trust_pending" "$formula_trust_marker" || \
      php_darwin_die 'could not commit formula trust added by the cache installation'
  fi
fi
php_darwin_set_phase homebrew.dependencies
[ -z "$tap_pid" ] || dependencies_started_with_pending_tap=true
brew missing "$tap/$formula" > "$missing_log" 2>&1 &
missing_pid=$!

php_darwin_set_phase homebrew.configure
[ -d "$brew_prefix/$pear_path" ] || php_darwin_die "cache did not install $pear_path"
while IFS= read -r postinstall_path; do
  [ -n "$postinstall_path" ] || continue
  if [ -e "$postinstall_backup_dir/$postinstall_path" ] || \
    [ -L "$postinstall_backup_dir/$postinstall_path" ]; then
    rm -rf "${brew_prefix:?}/${postinstall_path:?}" || \
      php_darwin_die "could not replace cached $postinstall_path with the existing file"
    mkdir -p "$brew_prefix/${postinstall_path%/*}" || \
      php_darwin_die "could not restore the parent for $postinstall_path"
    mv "$postinstall_backup_dir/$postinstall_path" "$brew_prefix/$postinstall_path" || \
      php_darwin_die "could not preserve $postinstall_path"
    printf '%s\n' "$postinstall_path" >> "$postinstall_restored_file" || \
      php_darwin_die "could not record the restored $postinstall_path"
  fi
done < "$postinstall_paths_file"
if [ "$pear_backed_up" = true ]; then
  rm -rf "${brew_prefix:?}/${pear_path:?}" || php_darwin_die "could not replace cached $pear_path"
  mkdir -p "$brew_prefix/${pear_path%/*}" || php_darwin_die "could not restore the parent for $pear_path"
  mv "$pear_backup" "$brew_prefix/$pear_path" || php_darwin_die "could not preserve $pear_path"
  pear_backed_up=false
  pear_restored=true
fi
mkdir -p "$brew_prefix/lib/php/pecl/$pecl_extension" \
  "$brew_prefix/$pear_path/doc" "$brew_prefix/$pear_path/data" "$brew_prefix/$pear_path/cfg" \
  "$brew_prefix/$pear_path/htdocs" "$brew_prefix/$pear_path/test" || \
  php_darwin_die 'could not create formula-managed PEAR and PECL directories'
[ -s "$brew_prefix/etc/php/$config_id/pear.conf" ] || php_darwin_die 'cache did not install the Homebrew PEAR configuration'
grep -Fq "$brew_prefix/$pear_path" "$brew_prefix/etc/php/$config_id/pear.conf" || \
  php_darwin_die 'cached PEAR configuration has the wrong shared path'
grep -Fq "$brew_prefix/lib/php/pecl/$pecl_extension" "$brew_prefix/etc/php/$config_id/pear.conf" || \
  php_darwin_die 'cached PEAR configuration has the wrong extension path'
[ -L "$brew_prefix/opt/$formula/pecl" ] && [ -d "$brew_prefix/opt/$formula/pecl" ] || \
  php_darwin_die 'cached PHP PECL link has no shared directory target'

php_darwin_set_phase homebrew.link
php_darwin_verify_links "$brew_prefix" "$links_file" || \
  php_darwin_die 'cached Homebrew links did not match the archive metadata'

php_darwin_set_phase homebrew.dependencies
php_darwin_resolve_tap_and_dependencies

php_darwin_set_phase runtime.verify
php_bin="$brew_prefix/opt/$formula/bin/php"
[ -x "$php_bin" ] || php_darwin_die "PHP binary missing after cache extraction: $php_bin"
installed_semver=$($php_bin -n -r 'echo PHP_VERSION;' 2>/dev/null) || \
  php_darwin_die 'cached PHP could not report its version'
[ "${installed_semver%.*}" = "$version" ] || php_darwin_die "cache installed PHP $installed_semver for requested $version"
while IFS=$'\t' read -r extension extension_type extension_path; do
  [ -f "$brew_prefix/$extension_path" ] && [ ! -L "$brew_prefix/$extension_path" ] || \
    php_darwin_die "cached $extension module is missing after extraction"
  "$php_bin" -n -d "$extension_type=$brew_prefix/$extension_path" -r \
    "if (!extension_loaded('$extension')) { exit(1); }" || \
    php_darwin_die "cached $extension module does not load"
done < "$extension_paths_inventory"
runtime_verified=true
php_darwin_set_phase complete

if [ "$tap_snapshot_backed_up" = true ]; then
  if { [ ! -e "$tap_snapshot_path" ] && [ ! -L "$tap_snapshot_path" ]; } && \
    { mv "$tap_snapshot_backup" "$tap_snapshot_path" 2>/dev/null || \
      { command -v sudo >/dev/null 2>&1 && sudo -n mv "$tap_snapshot_backup" "$tap_snapshot_path"; }; }; then
    tap_snapshot_backed_up=false
  else
    preserve_tmp_dir=true
    printf 'php-darwin: restore the previous cache tap with: sudo mv %s %s\n' \
      "$tap_snapshot_backup" "$tap_snapshot_path" >&2
  fi
fi
if [ "$tap_restore_after_install" = true ]; then
  # Formula trust is needed only while the temporary cached tap is active.
  # Dependency link operations use bare rack names and do not load core formulae.
  if php_darwin_remove_tap_path "$brew_prefix" "$tap_path"; then
    tap_installed=false
    if php_darwin_restore_tap_path "$tap_path" "$tap_path_backup"; then
      tap_path_backed_up=false
      tap_restore_after_install=false
      if ! php_darwin_restore_formula_trust; then
        preserve_tmp_dir=true
      fi
    else
      printf 'php-darwin: restore the original tap with: sudo mv %s %s\n' \
        "$tap_path_backup" "$tap_path" >&2
    fi
  else
    printf 'php-darwin: remove %s, then restore the original tap with: sudo mv %s %s\n' \
      "$tap_path" "$tap_path_backup" "$tap_path" >&2
  fi
elif [ "$tap_path_backed_up" = true ]; then
  # The new tap is committed at this point. A best-effort cleanup failure must
  # not trigger rollback from a backup that may already be partially removed.
  tap_path_backed_up=false
  tap_installed=false
  php_darwin_remove_tap_backup "$brew_prefix" "$tap_path_backup" || \
    printf 'php-darwin: could not remove the retired Homebrew tap backup: %s\n' \
      "$tap_path_backup" >&2
fi
printf 'Installed PHP %s (%s, %s, %s) from %s\n' \
  "$installed_semver" "$build" "$ts" "$arch" "$asset"
