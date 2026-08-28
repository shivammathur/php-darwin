#!/usr/bin/env bash

# This file is generated from the named source files below. It is deliberately
# plain shell code so the standalone installer can be audited before execution.

# Source: scripts/lib.sh



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
  },
  "x86_64": {
    "build_runner": "macos-15-intel",
    "brew_prefix": "/usr/local",
    "minimum_macos": 15,
    "platform_key": "sequoia",
    "test_runners": ["macos-15-intel", "macos-26-intel"]
  }
}
PHP_DARWIN_CONFIG_PLATFORMS_JSON
      ;;
    postinstall-paths)
      cat <<'PHP_DARWIN_CONFIG_POSTINSTALL_PATHS'
# Formula-managed configuration recreated by Homebrew post_install.
all etc/php/{config}/pear.conf
versioned etc/php/{config}/conf.d/ext-intl.ini
versioned etc/php/{config}/conf.d/ext-opcache.ini
PHP_DARWIN_CONFIG_POSTINSTALL_PATHS
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
[[ "$member" =~ ^var/php-darwin/php_[0-9]+\.[0-9]+-(nts|zts)-(debug|release)\+darwin_(arm64|x86_64)\.json$ ]] || {
  printf 'Unsafe metadata member: %s\n' "$member" >&2
  exit 1
}

tar --ignore-zeros -xOf "$archive" "$member" > "$output"
[ -s "$output" ]
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

for build in release debug; do
  for ts in nts zts; do
    formula=$(php_darwin_formula "$version" "$build" "$ts")
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
  done
done

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

[ -d "$tap_path/.git" ] || {
  printf 'Homebrew tap is not a Git repository: %s\n' "$tap_path" >&2
  exit 1
}
actual_repository=$(git -C "$tap_path" remote get-url origin) || exit 1
actual_repository=${actual_repository%.git}
[ "$actual_repository" = "${repository%.git}" ] || {
  printf 'Homebrew tap origin mismatch: %s\n' "$actual_repository" >&2
  exit 1
}
if [ -n "$expected_commit" ]; then
  actual_commit=$(git -C "$tap_path" rev-parse HEAD) || exit 1
  [ "$actual_commit" = "$expected_commit" ] || {
    printf 'Homebrew tap commit mismatch: %s\n' "$actual_commit" >&2
    exit 1
  }
fi
if [ -n "$expected_branch" ]; then
  actual_branch=$(git -C "$tap_path" symbolic-ref --short HEAD) || exit 1
  [ "$actual_branch" = "$expected_branch" ] || {
    printf 'Homebrew tap branch mismatch: %s\n' "$actual_branch" >&2
    exit 1
  }
  [ "$(git -C "$tap_path" rev-parse "refs/remotes/origin/$expected_branch")" = "$expected_commit" ] || {
    printf 'Homebrew tap remote branch does not match its snapshot commit\n' >&2
    exit 1
  }
  git -C "$tap_path" diff --quiet --no-ext-diff || {
    printf 'Homebrew tap snapshot has changed files\n' >&2
    exit 1
  }
  git -C "$tap_path" diff --cached --quiet --no-ext-diff || {
    printf 'Homebrew tap snapshot has changed index entries\n' >&2
    exit 1
  }
fi
if [ -n "$expected_hash" ]; then
  actual_hash=$(HOMEBREW_PHP_PATH="$tap_path" php_darwin_source_hash "$version") || exit 1
  [ "$actual_hash" = "$expected_hash" ] || {
    printf 'Homebrew tap formula hash mismatch\n' >&2
    exit 1
  }
  printf '%s\n' "$actual_hash"
fi
)

# Source: scripts/verify-links.sh
php_darwin_verify_links() (

prefix=${1:?}
verify_links_file=${2:?}
actual_links="$verify_links_file.actual.$$"
raw_links="$verify_links_file.raw.$$"
trap 'rm -f "$actual_links" "$raw_links"' EXIT

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
  tar_pattern=${relative_path//\\/\\\\}
  tar_pattern=${tar_pattern//\[/\\[}
  tar_pattern=${tar_pattern//\]/\\]}
  tar_pattern=${tar_pattern//\*/\\*}
  tar_pattern=${tar_pattern//\?/\\?}
  printf '%s\n' "$tar_pattern" >> "$output" || exit 1
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

tar --ignore-zeros -xkmpf "$archive" --no-same-owner -X "$exclude_file" -C "$prefix"
)

# Source: scripts/install-package.sh



php_darwin_set_phase input
version=${1:-8.5}
build=${2:-release}
ts=${3:-nts}
local_archive=${4:-}
arch=$(php_darwin_normalize_arch "$(uname -m)")
package_values=$(jq -er --arg arch "$arch" \
  --argjson platforms "$(php_darwin_read_config platforms.json)" '
  [.current_version, .release_repository, .tap, .tap_repository, .tap_branch, .tap_snapshot,
   $platforms[$arch].brew_prefix] |
  select(all(.[]; type == "string" and length > 0)) | @tsv
' < <(php_darwin_read_config package.json)) || php_darwin_die 'could not load the package configuration'
IFS=$'\t' read -r package_current_version package_release_repository package_tap package_tap_repository \
  package_tap_branch package_tap_snapshot expected_prefix <<< "$package_values" || \
  php_darwin_die 'could not parse the package configuration'
php_darwin_validate_version "$version"
php_darwin_validate_build "$build"
php_darwin_validate_ts "$ts"
formula_suffix=
[ "$build" = debug ] && formula_suffix=-debug
[ "$ts" = zts ] && formula_suffix="$formula_suffix-zts"
requested_formula="php@$version$formula_suffix"
formula=$requested_formula
[ "$version" != "$package_current_version" ] || formula="php$formula_suffix"
config_id="$version$formula_suffix"
asset="php_$version-$ts-$build+darwin_$arch.tar.zst"
tap=$package_tap
tap_repository=$package_tap_repository
tap_branch=$package_tap_branch
tap_snapshot=$package_tap_snapshot
pear_path=$(php_darwin_pear_path "$version" "$formula")
internal_metadata_path=$(php_darwin_metadata_path "$asset")

php_darwin_set_phase environment
[ "$(uname -s)" = Darwin ] || php_darwin_die 'the cache installer only supports macOS'
command -v brew >/dev/null 2>&1 || php_darwin_die 'Homebrew is required'
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

export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_AUTOREMOVE=1
export HOMEBREW_NO_ENV_HINTS=1
export HOMEBREW_NO_INSTALL_CLEANUP=1
export HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1
export HOMEBREW_NO_INSTALL_FROM_API=1

tmp_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-install.XXXXXX") || \
  php_darwin_die 'could not create the installation directory'
archive_roots_file="$tmp_dir/archive-paths.txt"
php_darwin_read_config archive-paths > "$archive_roots_file" || \
  php_darwin_die 'could not stage the archive root configuration'
tap_log="$tmp_dir/homebrew-tap.log"
tap_pid=
unlink_log="$tmp_dir/homebrew-unlink.log"
unlink_pid=
missing_log="$tmp_dir/homebrew-missing.log"
missing_pid=
new_formulae=()
linked_php_formulae=()
postinstall_paths_file="$tmp_dir/postinstall-paths.txt"
postinstall_candidates_file="$tmp_dir/postinstall-candidates.txt"
postinstall_backup_dir="$tmp_dir/postinstall-backup"
pear_backup="$tmp_dir/pear-backup"
previous_opt_links="$tmp_dir/previous-opt-links.tsv"
tap_installed=false
tap_path=
tap_snapshot_backup="$tmp_dir/homebrew-tap-snapshot-backup"
tap_snapshot_backed_up=false
tap_snapshot_extracted=false
tap_snapshot_path="$brew_prefix/$tap_snapshot"
: > "$previous_opt_links" || php_darwin_die 'could not create the Homebrew opt-link backup'
archive_mutation_started=false
php_darwin_wait_for_dependencies() {
  local missing
  local missing_status

  [ -n "$missing_pid" ] || return 0
  if wait "$missing_pid"; then
    missing_status=0
  else
    missing_status=$?
  fi
  missing_pid=
  missing=$(cat "$missing_log") || php_darwin_die 'could not read Homebrew dependency diagnostics'
  case "$missing" in
    *"Refusing to load formula"*"from untrusted tap $tap"*)
      php_darwin_wait_for_tap
      if brew missing "$formula" > "$missing_log" 2>&1; then
        missing_status=0
      else
        missing_status=$?
      fi
      missing=$(cat "$missing_log") || \
        php_darwin_die 'could not read retried Homebrew dependency diagnostics'
      ;;
  esac
  [ "$missing_status" -eq 0 ] || [ -n "$missing" ] || \
    php_darwin_die 'Homebrew dependency validation failed without diagnostics'
  if [ -n "$missing" ]; then
    php_darwin_die "cache has missing Homebrew dependencies: $missing"
  fi
}

php_darwin_wait_for_tap() {
  local tap_status

  [ -n "$tap_pid" ] || return 0
  if wait "$tap_pid"; then
    tap_status=0
  else
    tap_status=$?
  fi
  tap_pid=
  if [ "$tap_status" -ne 0 ]; then
    cat "$tap_log" >&2
    php_darwin_die "could not validate and trust $tap"
  fi
}

php_darwin_wait_for_unlink() {
  local unlink_status

  [ -n "$unlink_pid" ] || return 0
  if wait "$unlink_pid"; then
    unlink_status=0
  else
    unlink_status=$?
  fi
  unlink_pid=
  if [ "$unlink_status" -ne 0 ]; then
    cat "$unlink_log" >&2
    php_darwin_die 'could not unlink the previously active Homebrew PHP formulae'
  fi
}

php_darwin_install_cleanup() {
  cleanup_status=$?
  rollback_status=ok
  rollback_log="$tmp_dir/rollback.log"
  trap - EXIT
  : > "$rollback_log"
  for background_pid in "$tap_pid" "$unlink_pid" "$missing_pid"; do
    [ -n "$background_pid" ] || continue
    kill "$background_pid" >/dev/null 2>&1 || true
    wait "$background_pid" >/dev/null 2>&1 || true
  done
  if [ "$cleanup_status" -ne 0 ]; then
    if [ "$tap_installed" = true ]; then
      if [ -d "$tap_path" ] && [ ! -L "$tap_path" ]; then
        find "$tap_path" -mindepth 1 -delete >> "$rollback_log" 2>&1 && \
          rmdir "$tap_path" >> "$rollback_log" 2>&1 || rollback_status=failed
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
      rollback_formulae=()
      for new_formula in "${new_formulae[@]}"; do
        [ -d "$brew_prefix/Cellar/$new_formula" ] && rollback_formulae+=("$new_formula")
      done
      if [ "${#rollback_formulae[@]}" -gt 0 ]; then
        brew uninstall --force --ignore-dependencies "${rollback_formulae[@]}" >> "$rollback_log" 2>&1 || \
          rollback_status=failed
      fi
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
    if [ -e "$pear_backup" ] || [ -L "$pear_backup" ]; then
      rm -rf "${brew_prefix:?}/${pear_path:?}" >> "$rollback_log" 2>&1 || rollback_status=failed
      mkdir -p "$brew_prefix/${pear_path%/*}" >> "$rollback_log" 2>&1 && \
        mv "$pear_backup" "$brew_prefix/$pear_path" >> "$rollback_log" 2>&1 || rollback_status=failed
    elif [ "$archive_mutation_started" = true ]; then
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
        elif [ "$archive_mutation_started" = true ]; then
          rm -rf "${brew_prefix:?}/${postinstall_path:?}" >> "$rollback_log" 2>&1 || rollback_status=failed
        fi
      done < "$postinstall_paths_file"
    fi
    if [ "$archive_mutation_started" = true ]; then
      rm -f "$brew_prefix/$internal_metadata_path" >> "$rollback_log" 2>&1 || rollback_status=failed
    fi
    if [ "${#linked_php_formulae[@]}" -gt 0 ]; then
      brew link --overwrite --force "${linked_php_formulae[@]}" >> "$rollback_log" 2>&1 || \
        rollback_status=failed
    fi
  fi
  if [ "$cleanup_status" -ne 0 ]; then
    if [ "$rollback_status" = failed ]; then
      printf 'php-darwin: rollback failed; Homebrew diagnostics follow\n' >&2
      cat "$rollback_log" >&2
    fi
    printf 'php-darwin: rollback %s\n' "$rollback_status" >&2
  fi
  rm -rf "$tmp_dir"
  exit "$cleanup_status"
}
trap php_darwin_install_cleanup EXIT

# Unlinking the runner's active PHP and reading the cache are independent.
# Start the Homebrew operation before the archive fetch so it is normally
# complete by the time the collision inventory needs the prefix to be stable.
for linked_php_path in "$brew_prefix/var/homebrew/linked"/php*; do
  [ -L "$linked_php_path" ] || continue
  linked_php_formula=${linked_php_path##*/}
  [[ "$linked_php_formula" =~ ^php(@[0-9]+\.[0-9]+)?(-debug)?(-zts)?$ ]] || continue
  linked_php_formulae+=("$linked_php_formula")
done
if [ "${#linked_php_formulae[@]}" -gt 0 ]; then
  brew unlink "${linked_php_formulae[@]}" > "$unlink_log" 2>&1 &
  unlink_pid=$!
fi

archive="$tmp_dir/$asset"
external_metadata=
cached_source_hash=

php_darwin_validate_cache_metadata() {
  local metadata_file=$1
  local expected_commit=${2:-}

  jq -er --arg version "$version" --arg build "$build" --arg ts "$ts" \
    --arg arch "$arch" --arg brew_prefix "$brew_prefix" --arg asset "$asset" --arg formula "$formula" \
    --arg expected_commit "$expected_commit" --arg pear_path "$pear_path" \
    --arg pear_conf "etc/php/$config_id/pear.conf" \
    --arg requested_formula "$requested_formula" --arg tap_snapshot "$tap_snapshot" \
    --argjson macos_major "$macos_major" '
    select(.schema == 1 and .php_version == $version and .build == $build and
    .thread_safety == $ts and .architecture == $arch and .brew_prefix == $brew_prefix and
    .archive == $asset and .formula == $formula and .requested_formula == $requested_formula and
    .minimum_macos <= $macos_major and .pear_path == $pear_path and
    .tap_snapshot == $tap_snapshot and
    (.pecl_extension | type == "string" and test("^[A-Za-z0-9._-]+$")) and
    (.homebrew_php_commit | type == "string" and test("^[0-9a-f]{40}$")) and
    ($expected_commit == "" or .homebrew_php_commit == $expected_commit) and
    (.formula_sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.source_hash | type == "string" and test("^[0-9a-f]{64}$")) and
    (.php_semver | type == "string" and startswith($version + ".") and test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) and
    (.links | type == "array" and length > 0) and
    ([.links[].path] | unique | length) == (.links | length) and
    all(.links[];
      (.path | type == "string" and test("^(Frameworks|bin|etc|include|lib|sbin|share|var/homebrew/linked)/") and
        (test("(^|/)\\.\\.(/|$)") | not) and test("^[^\\r\\n\\t]+$")) and
      (.target | type == "string" and test("^[^\\r\\n\\t]+$"))) and
    (.state_paths | type == "array" and length > 0) and
    any(.state_paths[]; . == $pear_conf) and
    all(.state_paths[];
      type == "string" and test("^(etc|var)/") and (test("(^|/)\\.\\.(/|$)") | not) and
      test("^[^\\r\\n\\t]+$")) and
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
     .pecl_extension] | @tsv
  ' "$metadata_file"
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
  expected_hash=$(awk -v name="$asset" '$2 == name { print $1; found=1; exit } END { exit !found }' "$checksum") || \
    php_darwin_die "checksum file does not contain $asset"
  [[ "$expected_hash" =~ ^[0-9a-f]{64}$ ]] || php_darwin_die "checksum is invalid for $asset"
  actual_hash=$(php_darwin_sha256 "$archive") || php_darwin_die "could not hash $asset"
  [ "$actual_hash" = "$expected_hash" ] || php_darwin_die "checksum mismatch for $asset"
  cp "$external_metadata" "$metadata_copy" || php_darwin_die 'could not copy external cache metadata'
else
  release_repository=${PHP_DARWIN_RELEASE_REPOSITORY:-$package_release_repository}
  [[ "$release_repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || \
    php_darwin_die "invalid release repository: $release_repository"
  release_url=${PHP_DARWIN_RELEASE_URL:-https://github.com/$release_repository/releases/download/php-$version/$asset}
  curl --retry 3 --retry-all-errors -fsSL "$release_url" -o "$archive" || \
    php_darwin_die "could not download $release_url"
  php_darwin_read_metadata "$archive" "$internal_metadata_path" "$metadata_copy" || \
    php_darwin_die 'could not read metadata from the release archive'
fi

php_darwin_set_phase cache.metadata
expected_metadata_commit=${HOMEBREW_PHP_COMMIT:-}
metadata_values=$(php_darwin_validate_cache_metadata "$metadata_copy" "$expected_metadata_commit") || \
  php_darwin_die 'cache metadata did not match the runner or request'
IFS=$'\t' read -r metadata_homebrew_commit cached_source_hash target_keg_relative pecl_extension \
  <<< "$metadata_values" || \
  php_darwin_die 'could not parse the validated cache metadata'

php_darwin_set_phase homebrew.tap
tap_path=$(brew --repository "$tap") || php_darwin_die "could not resolve the $tap repository"
case "$tap_path" in
  "$brew_prefix/Library/Taps/"*|"$brew_prefix/Homebrew/Library/Taps/"*) ;;
  *) php_darwin_die "unexpected Homebrew tap path: $tap_path" ;;
esac
[ ! -L "$tap_path" ] || php_darwin_die "Homebrew tap path is a symlink: $tap_path"

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
  php_darwin_wait_for_unlink
  brew uninstall --force --ignore-dependencies "$formula" >/dev/null || \
    php_darwin_die "could not remove the existing cached $formula keg"
fi
php_darwin_postinstall_paths "$version" "$formula" "$build" "$ts" > "$postinstall_candidates_file" || \
  php_darwin_die 'could not resolve formula-managed post-install paths'
: > "$postinstall_paths_file" || php_darwin_die 'could not create the post-install path list'
while IFS= read -r postinstall_path; do
  if jq -e --arg path "$postinstall_path" '.state_paths | index($path) != null' \
    "$metadata_copy" >/dev/null; then
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
fi
rm -f "$brew_prefix/$internal_metadata_path" || php_darwin_die 'could not remove stale archive metadata'
existing_kegs="$tmp_dir/existing-kegs.txt"
changed_formulae_file="$tmp_dir/changed-formulae.txt"
linkable_formulae_file="$tmp_dir/linkable-formulae.txt"
packages_file="$tmp_dir/packages.tsv"
package_kegs_file="$tmp_dir/package-kegs.txt"
links_file="$tmp_dir/links.tsv"
managed_paths_file="$tmp_dir/managed-paths.txt"
exclude_file="$tmp_dir/existing-paths.txt"
metadata_records_file="$tmp_dir/metadata-records.tsv"
: > "$packages_file" || php_darwin_die 'could not create the Homebrew package receipt list'
: > "$package_kegs_file" || php_darwin_die 'could not create the Homebrew keg path list'
: > "$managed_paths_file" || php_darwin_die 'could not create the managed archive path list'
: > "$links_file" || php_darwin_die 'could not create the Homebrew link list'
jq -r '[
    (.packages[] | ["package", .name, .opt_target, (.keg_only | tostring)]),
    (.packages[] | ["keg", (.opt_target | ltrimstr("../"))]),
    (.links[] | ["managed", .path]),
    (.state_paths[] | ["managed", .]),
    (.packages[] | ["managed", ("opt/" + .name)]),
    (.links[] | ["link", .path, .target])
  ][] | @tsv' "$metadata_copy" > "$metadata_records_file" || \
  php_darwin_die 'could not read embedded Homebrew installation records'
awk -F '\t' -v packages="$packages_file" -v kegs="$package_kegs_file" \
  -v managed="$managed_paths_file" -v links="$links_file" '
  $1 == "package" && NF == 4 { print $2 "\t" $3 "\t" $4 > packages; next }
  $1 == "keg" && NF == 2 { print $2 > kegs; next }
  $1 == "managed" && NF == 2 { print $2 > managed; next }
  $1 == "link" && NF == 3 { print $2 "\t" $3 > links; next }
  { exit 1 }
' "$metadata_records_file" || php_darwin_die 'could not split embedded Homebrew installation records'
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
php_darwin_wait_for_unlink
php_darwin_existing_paths "$brew_prefix" "$exclude_file" \
  "$archive_roots_file" \
  "$existing_kegs" "$managed_paths_file" "$package_kegs_file" || \
  php_darwin_die 'could not record existing Homebrew paths'
: > "$changed_formulae_file"
: > "$linkable_formulae_file"
while IFS=$'\t' read -r package_name opt_target keg_only; do
  keg_relative=${opt_target#../}
  if ! grep -Fxq "$keg_relative" "$existing_kegs"; then
    printf '%s\n' "$package_name" >> "$changed_formulae_file"
    package_preexisting=false
    if awk -v prefix="Cellar/$package_name/" 'index($0, prefix) == 1 { found=1; exit } END { exit !found }' \
      "$existing_kegs"; then
      package_preexisting=true
    else
      new_formulae+=("$package_name")
    fi
    if [ "$package_name" != "$formula" ] && [ "$keg_only" = false ] && \
      [ "$package_preexisting" = true ]; then
      printf '%s\n' "$package_name" >> "$linkable_formulae_file"
    fi
  fi
done < "$packages_file"
[ -s "$changed_formulae_file" ] || php_darwin_die 'cache extraction would not add any Homebrew kegs'
grep -Fxq "$formula" "$changed_formulae_file" || php_darwin_die "cache extraction would not add $formula"

php_darwin_set_phase archive.extract
archive_mutation_started=true
tap_snapshot_extracted=true
php_darwin_extract "$archive" "$brew_prefix" "$exclude_file" || \
  php_darwin_die "could not extract $asset into Homebrew"

php_darwin_set_phase homebrew.tap
[ -d "$tap_snapshot_path/.git" ] && [ ! -L "$tap_snapshot_path" ] || \
  php_darwin_die 'cache did not contain a valid Homebrew tap snapshot'
if [ -e "$tap_path" ]; then
  [ -d "$tap_path/.git" ] && [ ! -L "$tap_path" ] || \
    php_darwin_die "installed Homebrew tap is not a Git repository: $tap_path"
  php_darwin_validate_tap "$tap_snapshot_path" "$version" '' \
    "$tap_repository" "$metadata_homebrew_commit" "$tap_branch" >/dev/null || \
    php_darwin_die 'cached Homebrew tap snapshot validation failed'
  find "$tap_snapshot_path" -mindepth 1 -delete || \
    php_darwin_die 'could not remove the extracted Homebrew tap snapshot'
  rmdir "$tap_snapshot_path" || php_darwin_die 'could not remove the empty Homebrew tap snapshot'
  tap_snapshot_extracted=false
else
  tap_parent=${tap_path%/*}
  [ ! -L "$tap_parent" ] || php_darwin_die "Homebrew tap owner path is a symlink: $tap_parent"
  mkdir -p "$tap_parent" || php_darwin_die "could not create the Homebrew tap owner path: $tap_parent"
  mv "$tap_snapshot_path" "$tap_path" || php_darwin_die "could not install the $tap snapshot"
  tap_snapshot_extracted=false
  tap_installed=true
fi
(
  tap_status=0
  if [ "$tap_installed" = true ]; then
    php_darwin_validate_tap "$tap_path" "$version" '' "$tap_repository" \
      "$metadata_homebrew_commit" "$tap_branch" >/dev/null || tap_status=$?
  elif [ -n "$cached_source_hash" ]; then
    php_darwin_validate_tap "$tap_path" "$version" "$cached_source_hash" \
      "$tap_repository" >/dev/null || tap_status=$?
  else
    php_darwin_validate_tap "$tap_path" "$version" '' "$tap_repository" \
      "$metadata_homebrew_commit" >/dev/null || tap_status=$?
  fi
  if [ "$tap_status" -eq 0 ]; then
    brew trust --tap "$tap" || tap_status=$?
  fi
  exit "$tap_status"
) > "$tap_log" 2>&1 &
tap_pid=$!

php_darwin_set_phase homebrew.receipts
metadata="$brew_prefix/$internal_metadata_path"
[ -f "$metadata" ] || php_darwin_die 'cache did not contain embedded installation metadata'
jq -en --slurpfile extracted "$metadata" --slurpfile expected "$metadata_copy" \
  '$extracted[0] == $expected[0]' >/dev/null || \
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
brew missing "$formula" > "$missing_log" 2>&1 &
missing_pid=$!

php_darwin_set_phase homebrew.configure
mkdir -p "$brew_prefix/lib/php/pecl/$pecl_extension" \
  "$brew_prefix/$pear_path/doc" "$brew_prefix/$pear_path/data" "$brew_prefix/$pear_path/cfg" \
  "$brew_prefix/$pear_path/htdocs" "$brew_prefix/$pear_path/test" || \
  php_darwin_die 'could not create formula-managed PEAR and PECL directories'
while IFS= read -r postinstall_path; do
  [ -n "$postinstall_path" ] || continue
  if [ ! -e "$brew_prefix/$postinstall_path" ] && [ ! -L "$brew_prefix/$postinstall_path" ] && \
    { [ -e "$postinstall_backup_dir/$postinstall_path" ] || \
      [ -L "$postinstall_backup_dir/$postinstall_path" ]; }; then
    mkdir -p "$brew_prefix/${postinstall_path%/*}" || \
      php_darwin_die "could not restore the parent for $postinstall_path"
    mv "$postinstall_backup_dir/$postinstall_path" "$brew_prefix/$postinstall_path" || \
      php_darwin_die "could not preserve $postinstall_path"
  fi
done < "$postinstall_paths_file"
[ -d "$brew_prefix/$pear_path" ] || php_darwin_die "cache did not install $pear_path"
[ -s "$brew_prefix/etc/php/$config_id/pear.conf" ] || php_darwin_die 'cache did not install the Homebrew PEAR configuration'
grep -Fq "$brew_prefix/$pear_path" "$brew_prefix/etc/php/$config_id/pear.conf" || \
  php_darwin_die 'cached PEAR configuration has the wrong shared path'
grep -Fq "$brew_prefix/lib/php/pecl/$pecl_extension" "$brew_prefix/etc/php/$config_id/pear.conf" || \
  php_darwin_die 'cached PEAR configuration has the wrong extension path'
[ -L "$brew_prefix/opt/$formula/pecl" ] && [ -d "$brew_prefix/opt/$formula/pecl" ] || \
  php_darwin_die 'cached PHP PECL link has no shared directory target'

php_darwin_set_phase homebrew.link
linkable_formulae=()
while IFS= read -r linkable_formula; do
  [ -n "$linkable_formula" ] && linkable_formulae+=("$linkable_formula")
done < "$linkable_formulae_file"
if [ "${#linkable_formulae[@]}" -gt 0 ]; then
  php_darwin_set_phase homebrew.dependencies
  php_darwin_wait_for_dependencies
  php_darwin_set_phase homebrew.link
  brew unlink "${linkable_formulae[@]}" >/dev/null || \
    php_darwin_die 'could not unlink the changed Homebrew dependencies'
  brew link --overwrite "${linkable_formulae[@]}" >/dev/null || \
    php_darwin_die 'could not link the extracted Homebrew dependencies'
fi
php_darwin_verify_links "$brew_prefix" "$links_file" || \
  php_darwin_die 'cached Homebrew links did not match the archive metadata'

php_darwin_set_phase runtime.verify
php_bin="$brew_prefix/opt/$formula/bin/php"
[ -x "$php_bin" ] || php_darwin_die "PHP binary missing after cache extraction: $php_bin"
installed_semver=$($php_bin -r 'echo PHP_VERSION;') || php_darwin_die 'cached PHP could not report its version'
[ "${installed_semver%.*}" = "$version" ] || php_darwin_die "cache installed PHP $installed_semver for requested $version"

php_darwin_set_phase homebrew.dependencies
php_darwin_wait_for_dependencies
php_darwin_set_phase homebrew.tap
php_darwin_wait_for_tap

if [ "$tap_snapshot_backed_up" = true ]; then
  [ ! -e "$tap_snapshot_path" ] && [ ! -L "$tap_snapshot_path" ] || \
    php_darwin_die 'could not restore the previous Homebrew tap snapshot over an existing path'
  mv "$tap_snapshot_backup" "$tap_snapshot_path" || \
    php_darwin_die 'could not restore the previous Homebrew tap snapshot'
  tap_snapshot_backed_up=false
fi

if [ -n "${GITHUB_PATH:-}" ]; then
  printf '%s\n%s\n' "$brew_prefix/opt/$formula/bin" "$brew_prefix/opt/$formula/sbin" >> "$GITHUB_PATH"
fi
php_darwin_set_phase complete
printf 'Installed PHP %s (%s, %s, %s) from %s\n' \
  "$installed_semver" "$build" "$ts" "$arch" "$asset"
