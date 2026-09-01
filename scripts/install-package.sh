#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

php_darwin_set_phase input
version=${1:-}
build=${2:-release}
ts=${3:-nts}
local_archive=${4:-}
arch=$(php_darwin_normalize_arch "$(uname -m)")

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
channel=$(php_darwin_version_channel "$version")
php_darwin_validate_build "$build"
php_darwin_validate_ts "$ts"
requested_formula=$(php_darwin_requested_formula "$version" "$build" "$ts")
formula=$(php_darwin_formula "$version" "$build" "$ts" "$current_version")
config_id=$(php_darwin_config_id "$version" "$build" "$ts")
asset=$(php_darwin_asset "$version" "$build" "$ts" "$arch")
pear_path=$(php_darwin_pear_path "$version" "$formula")
internal_metadata_path=$(php_darwin_metadata_path "$asset")

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
homebrew_prepare_log="$tmp_dir/homebrew-prepare.log"
homebrew_prepare_pid=
homebrew_prepare_phase_file="$tmp_dir/homebrew-prepare-phase.txt"
tap_path_file="$tmp_dir/homebrew-tap-path.txt"
tap_trust_file="$tmp_dir/homebrew-tap-trust.txt"
formula_trust_file="$tmp_dir/homebrew-formula-trust.txt"
missing_log="$tmp_dir/homebrew-missing.log"
missing_pid=
archive_hash_file="$tmp_dir/archive.sha256"
archive_hash_log="$tmp_dir/archive-hash.log"
archive_hash_pid=
linked_php_formulae=()
linked_dependency_formulae=()
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
formula_was_trusted=false
tap_installed=false
tap_path=
tap_path_backup=
tap_path_backed_up=false
tap_snapshot_backup="$tmp_dir/homebrew-tap-snapshot-backup"
tap_snapshot_backed_up=false
tap_snapshot_extracted=false
tap_snapshot_path="$brew_prefix/$tap_snapshot"
: > "$previous_opt_links" || php_darwin_die 'could not create the Homebrew opt-link backup'
: > "$postinstall_restored_file" || php_darwin_die 'could not create the restored-state list'
: > "$new_state_paths_file" || php_darwin_die 'could not create the new-state list'
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
    php_darwin_set_phase homebrew.tap
    cat "$tap_log" >&2
    php_darwin_die "could not validate $tap"
  fi
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
  local trust_status

  [ -f "$formula_trust_marker" ] || [ -f "$formula_trust_pending" ] || return 0
  if php_darwin_formula_trusted "$tap/$formula"; then
    brew untrust --formula "$tap/$formula" || return 1
  else
    trust_status=$?
    [ "$trust_status" -eq 1 ] || return 1
  fi
  rm -f "$formula_trust_marker" "$formula_trust_pending"
}

php_darwin_install_cleanup() {
  cleanup_status=$?
  rollback_status=ok
  rollback_log="$tmp_dir/rollback.log"
  trap - EXIT
  : > "$rollback_log"
  for background_pid in "$tap_pid" "$homebrew_prepare_pid" "$missing_pid" "$archive_hash_pid"; do
    [ -n "$background_pid" ] || continue
    wait "$background_pid" >/dev/null 2>&1 || true
  done
  if [ "$cleanup_status" -ne 0 ]; then
    php_darwin_restore_formula_trust >> "$rollback_log" 2>&1 || rollback_status=failed
    if [ "$tap_installed" = true ]; then
      if [ -d "$tap_path" ] && [ ! -L "$tap_path" ]; then
        find "$tap_path" -mindepth 1 -delete >> "$rollback_log" 2>&1 && \
          rmdir "$tap_path" >> "$rollback_log" 2>&1 || rollback_status=failed
      else
        rollback_status=failed
      fi
    fi
    if [ "$tap_path_backed_up" = true ]; then
      if php_darwin_restore_tap_path "$tap_path" "$tap_path_backup" >> "$rollback_log" 2>&1; then
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
    if [ "${#linked_php_formulae[@]}" -gt 0 ]; then
      brew link --overwrite --force "${linked_php_formulae[@]}" >> "$rollback_log" 2>&1 || \
        rollback_status=failed
    fi
    if [ "${#linked_dependency_formulae[@]}" -gt 0 ]; then
      brew link --overwrite "${linked_dependency_formulae[@]}" >> "$rollback_log" 2>&1 || \
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

# Homebrew preparation and reading the cache are independent. Keep Homebrew
# operations serial within one worker while overlapping them with the archive
# download, checksum, and metadata validation.
for linked_php_path in "$brew_prefix/var/homebrew/linked"/php*; do
  [ -L "$linked_php_path" ] || continue
  linked_php_formula=${linked_php_path##*/}
  [[ "$linked_php_formula" =~ ^php(@[0-9]+\.[0-9]+)?(-debug)?(-zts)?$ ]] || continue
  linked_php_formulae+=("$linked_php_formula")
done
: > "$homebrew_prepare_phase_file" || php_darwin_die 'could not create the Homebrew preparation phase file'
(
  printf 'homebrew.trust-state\n' > "$homebrew_prepare_phase_file" || exit 1
  trust_json=$(brew trust --json=v1) || exit 1
  if php_darwin_tap_trusted "$tap" "$trust_json"; then
    printf 'true\n' > "$tap_trust_file" || exit 1
  else
    trust_status=$?
    [ "$trust_status" -eq 1 ] || exit 1
    printf 'false\n' > "$tap_trust_file" || exit 1
  fi
  if php_darwin_formula_trusted "$tap/$formula" "$trust_json"; then
    printf 'true\n' > "$formula_trust_file" || exit 1
  else
    trust_status=$?
    [ "$trust_status" -eq 1 ] || exit 1
    printf 'false\n' > "$formula_trust_file" || exit 1
  fi
  printf 'homebrew.tap-path\n' > "$homebrew_prepare_phase_file" || exit 1
  brew --repository "$tap" > "$tap_path_file" || exit 1
  if [ "${#linked_php_formulae[@]}" -gt 0 ]; then
    printf 'homebrew.unlink\n' > "$homebrew_prepare_phase_file" || exit 1
    brew unlink "${linked_php_formulae[@]}" || exit 1
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
  manifest_values=
  if php_darwin_read_config release-manifest.json > "$release_manifest" 2>/dev/null; then
    manifest_values=$(php_darwin_validate_release_manifest \
      "$release_manifest" "$version" "$channel" "$asset") || manifest_values=
  fi
  if [ -z "$manifest_values" ]; then
    manifest_url=${PHP_DARWIN_MANIFEST_URL:-https://github.com/$release_repository/releases/download/php-$version/php-$version-manifest.json?cache=$(date +%s)}
    curl --retry 3 --retry-all-errors -fsSL "$manifest_url" -o "$release_manifest" || \
      php_darwin_die "could not download $manifest_url"
    manifest_values=$(php_darwin_validate_release_manifest \
      "$release_manifest" "$version" "$channel" "$asset") || \
      php_darwin_die 'release manifest did not match the requested PHP version'
  fi
  IFS=$'\t' read -r expected_hash manifest_homebrew_commit manifest_php_src_commit \
    manifest_php_semver manifest_source_hash <<< "$manifest_values" || \
    php_darwin_die 'could not parse the release source commits'
  [ "$manifest_php_src_commit" != - ] || manifest_php_src_commit=
  release_url=${PHP_DARWIN_RELEASE_URL:-https://github.com/$release_repository/releases/download/php-$version/$asset?cache=$expected_hash}
  curl --retry 3 --retry-all-errors -fsSL "$release_url" -o "$archive" || \
    php_darwin_die "could not download $release_url"
  php_darwin_start_archive_hash "$archive"
  php_darwin_wait_for_archive_hash
  [ "$actual_hash" = "$expected_hash" ] || php_darwin_die "checksum mismatch for $asset"
  bash "$script_dir/read-metadata.sh" "$archive" "$internal_metadata_path" "$metadata_copy" || \
    php_darwin_die 'could not read metadata from the verified release archive'
fi

php_darwin_set_phase cache.metadata
expected_metadata_commit=${HOMEBREW_PHP_COMMIT:-$manifest_homebrew_commit}
metadata_values=$(php_darwin_validate_cache_metadata "$metadata_copy" "$version" "$build" "$ts" "$arch" \
  "$brew_prefix" "$macos_major" "$expected_metadata_commit" "$manifest_php_src_commit" \
  "$current_version" "$tap_snapshot" "$minimum_macos" "$platform_key") || \
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
linkable_formulae_file="$tmp_dir/linkable-formulae.txt"
packages_file="$tmp_dir/packages.tsv"
package_kegs_file="$tmp_dir/package-kegs.txt"
links_file="$tmp_dir/links.tsv"
managed_paths_file="$tmp_dir/managed-paths.txt"
exclude_file="$tmp_dir/existing-paths.txt"
metadata_records_file="$tmp_dir/metadata-records.tsv"
state_paths_inventory="$tmp_dir/state-paths-inventory.txt"
: > "$packages_file" || php_darwin_die 'could not create the Homebrew package receipt list'
: > "$package_kegs_file" || php_darwin_die 'could not create the Homebrew keg path list'
: > "$managed_paths_file" || php_darwin_die 'could not create the managed archive path list'
: > "$links_file" || php_darwin_die 'could not create the Homebrew link list'
: > "$state_paths_inventory" || php_darwin_die 'could not create the Homebrew state path list'
jq -r '[
    (.packages[] | ["package", .name, .opt_target, (.keg_only | tostring)]),
    (.packages[] | ["keg", (.opt_target | ltrimstr("../"))]),
    (.links[] | ["managed", .path]),
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

php_darwin_set_phase homebrew.tap
php_darwin_wait_for_homebrew_prepare
formula_was_trusted=$(cat "$formula_trust_file") || \
  php_darwin_die "could not read the $tap/$formula trust state"
case "$formula_was_trusted" in true|false) ;; *)
  php_darwin_die "invalid $tap/$formula trust state"
  ;;
esac
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
bash "$script_dir/existing-paths.sh" "$brew_prefix" "$exclude_file" \
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
bash "$script_dir/extract.sh" "$archive" "$brew_prefix" "$exclude_file" || \
  php_darwin_die "could not extract $asset into Homebrew"

php_darwin_set_phase homebrew.tap
[ -d "$tap_snapshot_path/.git" ] && [ ! -L "$tap_snapshot_path" ] || \
  php_darwin_die 'cache did not contain a valid Homebrew tap snapshot'
if [ -e "$tap_path" ]; then
  [ -d "$tap_path/.git" ] && [ ! -L "$tap_path" ] || \
    php_darwin_die "installed Homebrew tap is not a Git repository: $tap_path"
  bash "$script_dir/validate-tap.sh" "$tap_snapshot_path" "$version" '' \
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
    bash "$script_dir/validate-tap.sh" "$tap_path" "$version" '' "$tap_repository" \
      "$metadata_homebrew_commit" "$tap_branch" >/dev/null || tap_status=$?
  elif [ -n "$cached_source_hash" ]; then
    bash "$script_dir/validate-tap.sh" "$tap_path" "$version" "$cached_source_hash" \
      "$tap_repository" >/dev/null || tap_status=$?
  else
    bash "$script_dir/validate-tap.sh" "$tap_path" "$version" '' "$tap_repository" \
      "$metadata_homebrew_commit" >/dev/null || tap_status=$?
  fi
  exit "$tap_status"
) > "$tap_log" 2>&1 &
tap_pid=$!

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
if [ "$tap_was_trusted" = false ]; then
  php_darwin_wait_for_tap
  if [ "$formula_was_trusted" = false ]; then
    php_darwin_set_phase homebrew.trust
    : > "$formula_trust_pending" || php_darwin_die "could not record trust for $tap/$formula"
    printf 'Trusting installed Homebrew formula %s\n' "$tap/$formula"
    brew trust --formula "$tap/$formula" || php_darwin_die "could not trust $tap/$formula"
    mv "$formula_trust_pending" "$formula_trust_marker" || \
      php_darwin_die "could not commit trust for $tap/$formula"
  fi
fi
php_darwin_set_phase homebrew.dependencies
brew missing "$formula" > "$missing_log" 2>&1 &
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
linkable_formulae=()
while IFS= read -r linkable_formula; do
  [ -n "$linkable_formula" ] && linkable_formulae+=("$linkable_formula")
done < "$linkable_formulae_file"
if [ "${#linkable_formulae[@]}" -gt 0 ]; then
  php_darwin_set_phase homebrew.dependencies
  php_darwin_wait_for_dependencies
  php_darwin_set_phase homebrew.link
  for linkable_formula in "${linkable_formulae[@]}"; do
    [ -L "$brew_prefix/var/homebrew/linked/$linkable_formula" ] && \
      linked_dependency_formulae+=("$linkable_formula")
  done
  brew unlink "${linkable_formulae[@]}" >/dev/null || \
    php_darwin_die 'could not unlink the changed Homebrew dependencies'
  brew link --overwrite "${linkable_formulae[@]}" >/dev/null || \
    php_darwin_die 'could not link the extracted Homebrew dependencies'
fi
bash "$script_dir/verify-links.sh" "$brew_prefix" "$links_file" || \
  php_darwin_die 'cached Homebrew links did not match the archive metadata'

php_darwin_set_phase homebrew.dependencies
php_darwin_wait_for_dependencies

php_darwin_set_phase homebrew.tap
php_darwin_wait_for_tap

php_darwin_set_phase runtime.verify
php_bin="$brew_prefix/opt/$formula/bin/php"
[ -x "$php_bin" ] || php_darwin_die "PHP binary missing after cache extraction: $php_bin"
installed_semver=$($php_bin -r 'echo PHP_VERSION;') || php_darwin_die 'cached PHP could not report its version'
[ "${installed_semver%.*}" = "$version" ] || php_darwin_die "cache installed PHP $installed_semver for requested $version"

if [ "$tap_path_backed_up" = true ]; then
  php_darwin_remove_tap_backup "$brew_prefix" "$tap_path_backup" || \
    php_darwin_die 'could not remove the replaced Homebrew tap backup'
  tap_path_backed_up=false
fi

if [ "$tap_snapshot_backed_up" = true ]; then
  [ ! -e "$tap_snapshot_path" ] && [ ! -L "$tap_snapshot_path" ] || \
    php_darwin_die 'could not restore the previous Homebrew tap snapshot over an existing path'
  mv "$tap_snapshot_backup" "$tap_snapshot_path" || \
    php_darwin_die 'could not restore the previous Homebrew tap snapshot'
  tap_snapshot_backed_up=false
fi
php_darwin_set_phase complete
printf 'Installed PHP %s (%s, %s, %s) from %s\n' \
  "$installed_semver" "$build" "$ts" "$arch" "$asset"
