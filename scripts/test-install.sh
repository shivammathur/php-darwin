#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

stage=${1:-all}
version=${PHP_VERSION:?}
build=${BUILD:?}
ts=${TS:?}
arch=$(php_darwin_normalize_arch "${ARCH:?}") || exit 1
asset=$(php_darwin_asset "$version" "$build" "$ts" "$arch") || exit 1
formula=$(php_darwin_formula "$version" "$build" "$ts") || exit 1
requested_formula=$(php_darwin_requested_formula "$version" "$build" "$ts") || exit 1
archive=${ARCHIVE_DIR:-${RUNNER_TEMP:?}/php-darwin}/$asset
cache_metadata="${archive%.tar.zst}.json"
source_commit=${HOMEBREW_PHP_COMMIT:-}
if [ -z "$source_commit" ]; then
  source_commit=$(jq -er '.homebrew_php_commit' "${archive%.tar.zst}.json") || \
    php_darwin_die 'could not derive the pinned homebrew-php source commit from cache metadata'
fi
brew_prefix=$(brew --prefix)
tap=$(php_darwin_package_config tap)
sentinel="$brew_prefix/etc/php-darwin-preserve.conf"
installed_before="${RUNNER_TEMP:?}/php-darwin-installed-before.txt"
php_bin="$brew_prefix/opt/$formula/bin/php"
php_config="$brew_prefix/opt/$formula/bin/php-config"
php_fpm="$brew_prefix/opt/$formula/sbin/php-fpm"
pear_path=$(php_darwin_pear_path "$version" "$formula") || exit 1
config_id=$(php_darwin_config_id "$version" "$build" "$ts") || exit 1
pear_fixture="$brew_prefix/$pear_path/php-darwin-user-package.php"
tap_trust_before="${RUNNER_TEMP:?}/php-darwin-tap-trust-before.txt"

php_darwin_configure_homebrew_environment

php_darwin_record_formulae() {
  brew list --formula > "$1" || php_darwin_die 'could not list installed Homebrew formulae'
}

php_darwin_enable_test_cleanup() {
  trap php_darwin_test_install_cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

php_darwin_test_tap_trust_state() {
  local trust_status

  if php_darwin_tap_trusted "$tap"; then
    printf 'true\n'
  else
    trust_status=$?
    [ "$trust_status" -eq 1 ] || return 1
    printf 'false\n'
  fi
}

prepare_homebrew() {
  local installed_php
  local installed_php_formulae=()
  local installed_formulae_list=${RUNNER_TEMP:?}/php-darwin-prepare-formulae.txt
  local tap_trust_state

  [[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || php_darwin_die 'invalid pinned homebrew-php source commit'
  tap_trust_state=$(php_darwin_test_tap_trust_state) || \
    php_darwin_die "could not read the initial $tap trust state"
  printf '%s\n' "$tap_trust_state" > "$tap_trust_before" || \
    php_darwin_die "could not record the initial $tap trust state"
  php_darwin_record_formulae "$installed_formulae_list"
  brew untap --force "$tap" >/dev/null 2>&1 || true
  while IFS= read -r installed_php; do
    php_darwin_is_php_formula "$installed_php" && installed_php_formulae+=("$installed_php")
  done < "$installed_formulae_list"
  if [ "${#installed_php_formulae[@]}" -gt 0 ]; then
    brew uninstall --force --ignore-dependencies "${installed_php_formulae[@]}" || \
      php_darwin_die 'could not remove preinstalled Homebrew PHP formulae'
  fi
  php_darwin_record_formulae "$installed_formulae_list"
  while IFS= read -r installed_php; do
    php_darwin_is_php_formula "$installed_php" && \
      php_darwin_die 'a Homebrew PHP formula remained before cache installation'
  done < "$installed_formulae_list"
  brew fetch --retry hello || php_darwin_die 'could not fetch the Homebrew validation formula after retries'
  brew install hello || php_darwin_die 'could not prepare an existing Homebrew formula'
  mkdir -p "${pear_fixture%/*}" || php_darwin_die 'could not create the existing PEAR fixture'
  printf 'preserve-user-pear-package\n' > "$pear_fixture" || \
    php_darwin_die 'could not write the existing PEAR fixture'
  printf 'preserve-existing-homebrew-state\n' > "$sentinel" || php_darwin_die 'could not create the preservation fixture'
  chmod 0444 "$sentinel" || php_darwin_die 'could not protect the preservation fixture'
  php_darwin_record_formulae "$installed_before"
  LC_ALL=C sort -u "$installed_before" -o "$installed_before" || \
    php_darwin_die 'could not sort the initial Homebrew formulae'
}

install_cache() {
  bash "$script_dir/install-package.sh" "$version" "$build" "$ts" "$archive" || \
    php_darwin_die 'cache installation failed'
  printf 'Cache installation completed for %s\n' "$asset"
}

validate_runtime() {
  local extension
  local extension_path
  local extension_type
  local expected_pear_dir
  local pear_dir
  local php_info

  [ -d "$brew_prefix/lib/php/pecl" ] || \
    php_darwin_die 'the shared Homebrew PECL directory is missing'
  [ -L "$brew_prefix/opt/$formula/pecl" ] && [ -d "$brew_prefix/opt/$formula/pecl" ] || \
    php_darwin_die 'the cached PHP PECL link has no directory target'
  pear_dir=$("$brew_prefix/opt/$formula/bin/pear" config-get php_dir) || \
    php_darwin_die 'PEAR could not read its Homebrew configuration'
  expected_pear_dir="$brew_prefix/$(php_darwin_pear_path "$version" "$formula")"
  [ "$pear_dir" = "$expected_pear_dir" ] && [ -d "$pear_dir" ] || \
    php_darwin_die 'the shared Homebrew PEAR directory is missing or misconfigured'
  [ "$(cat "$pear_fixture")" = preserve-user-pear-package ] || \
    php_darwin_die 'cache installation did not preserve the existing PEAR packages'
  "$brew_prefix/opt/$formula/bin/pecl" version >/dev/null || php_darwin_die 'PECL failed after cache installation'
  command -v php >/dev/null 2>&1 || php_darwin_die 'php is not linked into the Homebrew prefix'
  command -v php-config >/dev/null 2>&1 || php_darwin_die 'php-config is not linked into the Homebrew prefix'
  php -d date.timezone=UTC -r "if (strpos(PHP_VERSION, '$version') !== 0) { exit(1); }" || \
    php_darwin_die 'linked PHP does not match the requested version'
  "$php_bin" -d date.timezone=UTC -v || php_darwin_die 'php -v failed'
  "$php_bin" -d date.timezone=UTC -m || php_darwin_die 'php -m failed'
  "$php_config" --version || php_darwin_die 'php-config failed'
  "$php_fpm" -d date.timezone=UTC -v || php_darwin_die 'php-fpm failed'
  php_info=$("$php_bin" -d date.timezone=UTC -i) || php_darwin_die 'php -i failed'
  grep -F 'Thread Safety' <<< "$php_info" || php_darwin_die 'thread-safety metadata is missing'
  grep -F 'Debug Build' <<< "$php_info" || php_darwin_die 'debug-build metadata is missing'

  if [ "$ts" = zts ]; then
    grep -Eq '^Thread Safety => (enabled|yes)$' <<< "$php_info" || php_darwin_die 'PHP is not ZTS'
  else
    grep -Eq '^Thread Safety => (disabled|no)$' <<< "$php_info" || php_darwin_die 'PHP is not NTS'
  fi
  if [ "$build" = debug ]; then
    grep -Eq '^Debug Build => (yes|enabled)$' <<< "$php_info" || php_darwin_die 'PHP is not a debug build'
  else
    grep -Eq '^Debug Build => (no|disabled)$' <<< "$php_info" || php_darwin_die 'PHP is not a release build'
  fi
  while IFS=$'\t' read -r extension extension_type extension_path; do
    [ -f "$brew_prefix/$extension_path" ] && [ ! -L "$brew_prefix/$extension_path" ] || \
      php_darwin_die "the archive did not install cached $extension"
    "$php_bin" -n -d "$extension_type=$brew_prefix/$extension_path" -r \
      "if (!extension_loaded('$extension')) { exit(1); }" || \
      php_darwin_die "cached $extension failed its explicit load test"
    "$php_bin" -r "if (extension_loaded('$extension')) { exit(1); }" || \
      php_darwin_die "$extension is enabled by default in the cache"
  done < <(jq -r '(.extensions // [])[] | [.name,.type,.path] | @tsv' "$cache_metadata")
}

cleanup_homebrew_validation() {
  brew services stop "$formula" >/dev/null 2>&1 || true
  if brew list --versions hello >/dev/null 2>&1; then
    brew uninstall --force hello >/dev/null 2>&1 || true
  fi
  if [ -e "$sentinel" ] || [ -L "$sentinel" ]; then
    chmod u+w "$sentinel" >/dev/null 2>&1 || true
    rm -f "$sentinel" >/dev/null 2>&1 || true
  fi
  return 0
}

php_darwin_test_install_cleanup() {
  local cleanup_status=$?

  trap - EXIT
  trap '' HUP INT TERM
  if ! cleanup_homebrew_validation; then
    printf 'php-darwin: could not restore the Homebrew validation trust state\n' >&2
    [ "$cleanup_status" -ne 0 ] || cleanup_status=1
  fi
  exit "$cleanup_status"
}

reset_homebrew() {
  local extension
  local extension_path
  local extension_type
  local installed_php
  local installed_php_formulae=()
  local postinstall_path
  local reset_formula
  local reset_formulae
  local tap_trust_before_value
  local trust_status

  cleanup_homebrew_validation || php_darwin_die 'could not clean the previous Homebrew validation state'
  php_darwin_enable_test_cleanup
  brew services stop "$formula" >/dev/null 2>&1 || true
  reset_formulae=${RUNNER_TEMP:?}/php-darwin-reset-formulae.txt
  php_darwin_record_formulae "$reset_formulae"
  while IFS= read -r installed_php; do
    php_darwin_is_php_formula "$installed_php" && installed_php_formulae+=("$installed_php")
  done < "$reset_formulae"
  if [ "${#installed_php_formulae[@]}" -gt 0 ]; then
    brew uninstall --force --ignore-dependencies "${installed_php_formulae[@]}" || \
      php_darwin_die 'could not reset Homebrew PHP after validation'
  fi
  while IFS=$'\t' read -r extension extension_type extension_path; do
    [[ "$extension" =~ ^[A-Za-z0-9_]+$ ]] && \
      [[ "$extension_type" =~ ^(extension|zend_extension)$ ]] && \
      [[ "$extension_path" =~ ^(Cellar|lib)/ ]] && \
      [ "${extension_path##*/}" = "$extension.so" ] || \
      php_darwin_die 'cached extension reset path is invalid'
    [ -e "$brew_prefix/$extension_path" ] || [ -L "$brew_prefix/$extension_path" ] || continue
    if [ -w "$brew_prefix/${extension_path%/*}" ]; then
      rm -f "$brew_prefix/$extension_path" || php_darwin_die "could not reset cached $extension"
    else
      command -v sudo >/dev/null 2>&1 || \
        php_darwin_die 'sudo is required to reset a protected cached extension'
      sudo -n rm -f "$brew_prefix/$extension_path" || \
        php_darwin_die "could not reset cached $extension in a protected directory"
    fi
  done < <(jq -r '(.extensions // [])[] | [.name,.type,.path] | @tsv' "$cache_metadata")
  rm -rf "${brew_prefix:?}/${pear_path:?}" || \
    php_darwin_die 'could not reset formula-managed PEAR state'
  while IFS= read -r postinstall_path; do
    [ -n "$postinstall_path" ] || continue
    rm -rf "${brew_prefix:?}/${postinstall_path:?}" || \
      php_darwin_die "could not reset $postinstall_path"
  done < <(php_darwin_postinstall_paths "$version" "$formula" "$build" "$ts")
  rm -rf "${brew_prefix:?}/etc/php/${config_id:?}" || \
    php_darwin_die 'could not reset formula-managed PHP configuration'
  php_darwin_record_formulae "$reset_formulae"
  while IFS= read -r reset_formula; do
    php_darwin_is_php_formula "$reset_formula" && \
      php_darwin_die 'a Homebrew PHP formula remained after the validation reset'
  done < "$reset_formulae"
  tap_trust_before_value=$(cat "$tap_trust_before") || \
    php_darwin_die "could not read the initial $tap trust state during reset"
  if [ "$tap_trust_before_value" = false ]; then
    if php_darwin_formula_trusted "$tap/$formula"; then
      php_darwin_die "Homebrew uninstall retained trust for $tap/$formula"
    else
      trust_status=$?
      [ "$trust_status" -eq 1 ] || \
        php_darwin_die "could not verify removal of $tap/$formula trust"
    fi
  fi
  cleanup_homebrew_validation || php_darwin_die 'could not clean the Homebrew validation state after reset'
  trap - EXIT HUP INT TERM
  printf 'Reset Homebrew after validating %s\n' "$asset"
}

validate_homebrew() {
  local doctor_log=${RUNNER_TEMP:-/tmp}/brew-doctor.log
  local formula_info=${RUNNER_TEMP:-/tmp}/php-darwin-formula-info.json
  local installed_after=${RUNNER_TEMP:-/tmp}/php-darwin-installed-after.txt
  local new_formulae=${RUNNER_TEMP:-/tmp}/php-darwin-new-formulae.txt
  local installed_formula
  local installed_formulae=()
  local missing
  local missing_status
  local tap_branch
  local tap_path
  local tap_repository
  local tap_trust_before_value
  local tap_trust_after
  local tap_list=${RUNNER_TEMP:-/tmp}/php-darwin-taps.txt
  local tap_formula
  local tap_formulae_file=${RUNNER_TEMP:-/tmp}/php-darwin-tap-formulae.txt
  local trust_json
  local trust_status

  php_darwin_enable_test_cleanup

  tap_path=$(brew --repository "$tap") || php_darwin_die "could not resolve the installed $tap repository"
  php_darwin_is_git_worktree "$tap_path" || php_darwin_die "the cache did not install the $tap repository"
  brew tap > "$tap_list" || php_darwin_die 'could not list installed Homebrew taps'
  grep -Fxq "$tap" "$tap_list" || php_darwin_die "Homebrew does not list the cached $tap snapshot"
  tap_repository=$(php_darwin_package_config tap_repository)
  [ "$(git -C "$tap_path" remote get-url origin)" = "$tap_repository" ] || \
    php_darwin_die "the cached $tap snapshot has the wrong origin"
  tap_branch=$(php_darwin_package_config tap_branch)
  [ "$(git -C "$tap_path" symbolic-ref --short HEAD)" = "$tap_branch" ] || \
    php_darwin_die "the cached $tap snapshot is not on $tap_branch"
  [ "$(git -C "$tap_path" config "branch.$tap_branch.remote")" = origin ] && \
    [ "$(git -C "$tap_path" config "branch.$tap_branch.merge")" = "refs/heads/$tap_branch" ] || \
    php_darwin_die "the cached $tap snapshot is not configured for updates"
  tap_trust_before_value=$(cat "$tap_trust_before") || \
    php_darwin_die "could not read the initial $tap trust state"
  case "$tap_trust_before_value" in true|false) ;; *)
    php_darwin_die "invalid initial $tap trust state"
    ;;
  esac
  tap_trust_after=$(php_darwin_test_tap_trust_state) || \
    php_darwin_die "could not read the installed $tap trust state"
  [ "$tap_trust_after" = "$tap_trust_before_value" ] || \
    php_darwin_die 'cache installation changed the Homebrew tap trust state'
  if [ "$tap_trust_after" = false ]; then
    trust_json=$(brew trust --json=v1) || php_darwin_die 'could not read installed Homebrew formula trust'
    jq -er 'if ((.tap_formulae // []) | length) > 0 then .tap_formulae[] else .formula end' \
      "$cache_metadata" > "$tap_formulae_file" || \
      php_darwin_die 'could not read cached custom-tap formulae'
    while IFS= read -r tap_formula; do
      if php_darwin_formula_trusted "$tap/$tap_formula" "$trust_json"; then
        continue
      fi
      trust_status=$?
      [ "$trust_status" -ne 1 ] || \
        php_darwin_die "cache installation did not trust $tap/$tap_formula"
      php_darwin_die "could not verify trust for $tap/$tap_formula"
    done < "$tap_formulae_file"
  fi
  brew formula "$tap/$requested_formula" >/dev/null || \
    php_darwin_die "Homebrew cannot resolve $tap/$requested_formula from the cached tap"

  brew list --versions "$formula" || php_darwin_die 'Homebrew does not list the cached PHP formula'
  missing=$(brew missing "$formula" 2>&1)
  missing_status=$?
  [ "$missing_status" -eq 0 ] || [ -n "$missing" ] || php_darwin_die 'Homebrew dependency validation failed without diagnostics'
  [ -z "$missing" ] || php_darwin_die "Homebrew reports missing dependencies: $missing"
  brew linkage --test "$formula" || php_darwin_die 'Homebrew linkage validation failed'
  php_darwin_record_formulae "$installed_after"
  LC_ALL=C sort -u "$installed_after" -o "$installed_after" || \
    php_darwin_die 'could not sort the final Homebrew formulae'
  LC_ALL=C comm -13 "$installed_before" "$installed_after" > "$new_formulae" || \
    php_darwin_die 'could not identify the newly installed Homebrew formulae'
  printf '%s\n' "$formula" >> "$new_formulae" || php_darwin_die 'could not record the PHP formula'
  LC_ALL=C sort -u "$new_formulae" -o "$new_formulae" || \
    php_darwin_die 'could not sort the newly installed Homebrew formulae'
  while IFS= read -r installed_formula; do
    [ -n "$installed_formula" ] && installed_formulae+=("$installed_formula")
  done < "$new_formulae"
  brew info --installed --json=v2 "${installed_formulae[@]}" > "$formula_info" || \
    php_darwin_die 'could not inspect the newly installed Homebrew formulae'
  jq -e --arg formula "$formula" \
    'any(.formulae[]; .name == $formula and (.installed | length > 0))' "$formula_info" >/dev/null || \
    php_darwin_die 'Homebrew cannot read the cached PHP receipt'
  jq -e --rawfile installed "$new_formulae" '
    ($installed | split("\n") | map(select(length > 0))) as $installed |
    all(.formulae[] | select(.name as $name | $installed | index($name));
      .keg_only or (.linked_keg | type == "string" and length > 0))
  ' "$formula_info" >/dev/null || \
    php_darwin_die 'a newly installed non-keg-only Homebrew formula is unlinked'
  jq -e --arg formula "$formula" '
    [.formulae[] |
      select((.name | test("^php(@[0-9]+\\.[0-9]+)?(-debug)?(-zts)?$")) and
        (.linked_keg | type == "string" and length > 0)) |
      .name] == [$formula]
  ' "$formula_info" >/dev/null || php_darwin_die 'the requested PHP formula is not the only linked PHP keg'
  brew config || php_darwin_die 'brew config failed after cache installation'
  brew cleanup --dry-run >/dev/null 2>&1 || \
    php_darwin_die 'brew cleanup dry-run failed after cache installation'
  [ "$(cat "$sentinel")" = preserve-existing-homebrew-state ] || \
    php_darwin_die 'cache extraction changed an existing Homebrew configuration file'
  [ "$(stat -f '%Lp' "$sentinel")" = 444 ] || \
    php_darwin_die 'cache extraction changed existing Homebrew configuration permissions'
  brew list --versions hello >/dev/null || php_darwin_die 'cache extraction removed an existing Homebrew formula'
  "$(brew --prefix hello)/bin/hello" | grep -F 'Hello, world!' || \
    php_darwin_die 'an existing Homebrew formula stopped working after cache extraction'

  brew unlink "$tap/$formula" || php_darwin_die 'Homebrew could not unlink the cached PHP formula'
  brew link --overwrite --force "$tap/$formula" || \
    php_darwin_die 'Homebrew could not relink the cached PHP formula'
  "$php_bin" -d date.timezone=UTC -r "if (strpos(PHP_VERSION, '$version') !== 0) { exit(1); }" || \
    php_darwin_die 'PHP failed after Homebrew relinking'

  brew services start "$formula" || php_darwin_die 'PHP service did not start'
  service_running=false
  service_attempt=0
  while [ "$service_attempt" -lt 10 ]; do
    service_attempt=$((service_attempt + 1))
    if brew services info "$formula" --json | jq -e '.[0].running == true' >/dev/null; then
      service_running=true
      break
    fi
    sleep 1
  done
  [ "$service_running" = true ] || php_darwin_die 'PHP service is not running'
  brew services stop "$formula" || php_darwin_die 'PHP service did not stop'

  brew uninstall --force hello || php_darwin_die 'Homebrew could not uninstall an unrelated formula'
  brew install hello || php_darwin_die 'Homebrew could not install an unrelated formula after cache installation'
  "$(brew --prefix hello)/bin/hello" | grep -F 'Hello, world!' || \
    php_darwin_die 'the newly installed Homebrew formula did not run'
  brew uninstall --force hello || php_darwin_die 'Homebrew could not clean up the unrelated formula'

  if ! brew doctor >"$doctor_log" 2>&1; then
    if grep -Eq '^(Error:|.*broken)' "$doctor_log"; then
      cat "$doctor_log"
      php_darwin_die 'brew doctor reported a broken Homebrew installation'
    fi
  fi

  cleanup_homebrew_validation || php_darwin_die 'could not clean the Homebrew validation state'
  trap - EXIT HUP INT TERM

  printf 'Homebrew validation passed for %s\n' "$asset"
}

case "$stage" in
  prepare) prepare_homebrew ;;
  install) install_cache ;;
  runtime) validate_runtime ;;
  homebrew) validate_homebrew ;;
  reset) reset_homebrew ;;
  all)
    prepare_homebrew
    install_cache
    validate_runtime
    validate_homebrew
    ;;
  *) php_darwin_die 'usage: test-install.sh prepare|install|runtime|homebrew|reset|all' ;;
esac
