#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

stage=${1:-all}
version=${PHP_VERSION:?}
build=${BUILD:?}
ts=${TS:?}
arch=$(php_darwin_normalize_arch "${ARCH:?}")
asset=$(php_darwin_asset "$version" "$build" "$ts" "$arch")
formula=$(php_darwin_formula "$version" "$build" "$ts")
requested_formula=$(php_darwin_requested_formula "$version" "$build" "$ts")
archive=${ARCHIVE_DIR:-${RUNNER_TEMP:?}/php-darwin}/$asset
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
pear_fixture="$brew_prefix/$(php_darwin_pear_path "$version" "$formula")/php-darwin-user-package.php"
tap_trust_before="${RUNNER_TEMP:?}/php-darwin-tap-trust-before.txt"
validation_trust_added="${RUNNER_TEMP:?}/php-darwin-validation-trust-added"

export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_AUTOREMOVE=1
export HOMEBREW_NO_ENV_HINTS=1
export HOMEBREW_NO_INSTALL_CLEANUP=1
export HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1

prepare_homebrew() {
  local installed_php
  local installed_php_formulae=()

  [[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || php_darwin_die 'invalid pinned homebrew-php source commit'
  if brew trust --json=v1 | jq -e --arg tap "$tap" '.taps | index($tap) != null' >/dev/null; then
    printf 'true\n' > "$tap_trust_before"
  else
    printf 'false\n' > "$tap_trust_before"
  fi
  brew untap --force "$tap" >/dev/null 2>&1 || true
  while IFS= read -r installed_php; do
    [[ "$installed_php" =~ ^php(@[0-9]+\.[0-9]+)?(-debug)?(-zts)?$ ]] && \
      installed_php_formulae+=("$installed_php")
  done < <(brew list --formula)
  if [ "${#installed_php_formulae[@]}" -gt 0 ]; then
    brew uninstall --force --ignore-dependencies "${installed_php_formulae[@]}" || \
      php_darwin_die 'could not remove preinstalled Homebrew PHP formulae'
  fi
  if brew list --formula | grep -Eq '^php(@[0-9]+\.[0-9]+)?(-debug)?(-zts)?$'; then
    php_darwin_die 'a Homebrew PHP formula remained before cache installation'
  fi
  brew fetch --retry hello || php_darwin_die 'could not fetch the Homebrew validation formula after retries'
  brew install hello || php_darwin_die 'could not prepare an existing Homebrew formula'
  mkdir -p "${pear_fixture%/*}" || php_darwin_die 'could not create the existing PEAR fixture'
  printf 'preserve-user-pear-package\n' > "$pear_fixture" || \
    php_darwin_die 'could not write the existing PEAR fixture'
  printf 'preserve-existing-homebrew-state\n' > "$sentinel" || php_darwin_die 'could not create the preservation fixture'
  chmod 0444 "$sentinel" || php_darwin_die 'could not protect the preservation fixture'
  brew list --formula | LC_ALL=C sort -u > "$installed_before" || \
    php_darwin_die 'could not record the initial Homebrew formulae'
}

install_cache() {
  bash "$script_dir/install-package.sh" "$version" "$build" "$ts" "$archive" || \
    php_darwin_die 'cache installation failed'
  printf 'Cache installation completed for %s\n' "$asset"
}

validate_runtime() {
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
}

cleanup_homebrew_validation() {
  if [ -f "$validation_trust_added" ]; then
    brew untrust --tap "$tap" >/dev/null 2>&1 || true
    rm -f "$validation_trust_added"
  fi
  brew services stop "$formula" >/dev/null 2>&1 || true
  if brew list --versions hello >/dev/null 2>&1; then
    brew uninstall --force hello >/dev/null 2>&1 || true
  fi
  if [ -e "$sentinel" ] || [ -L "$sentinel" ]; then
    chmod u+w "$sentinel" >/dev/null 2>&1 || true
    rm -f "$sentinel" >/dev/null 2>&1 || true
  fi
}

reset_homebrew() {
  local postinstall_path

  cleanup_homebrew_validation
  brew services stop "$formula" >/dev/null 2>&1 || true
  if brew list --versions "$formula" >/dev/null 2>&1; then
    if ! brew trust --json=v1 | jq -e --arg tap "$tap" '.taps | index($tap) != null' >/dev/null; then
      brew trust --tap "$tap" >/dev/null || php_darwin_die "could not trust $tap for validation reset"
      : > "$validation_trust_added"
    fi
    brew uninstall --force --ignore-dependencies "$formula" || \
      php_darwin_die "could not reset $formula after validation"
    cleanup_homebrew_validation
  fi
  rm -rf "${brew_prefix:?}/$(php_darwin_pear_path "$version" "$formula")" || \
    php_darwin_die 'could not reset formula-managed PEAR state'
  while IFS= read -r postinstall_path; do
    [ -n "$postinstall_path" ] || continue
    rm -rf "${brew_prefix:?}/${postinstall_path:?}" || \
      php_darwin_die "could not reset $postinstall_path"
  done < <(php_darwin_postinstall_paths "$version" "$formula" "$build" "$ts")
  rm -rf "${brew_prefix:?}/etc/php/$(php_darwin_config_id "$version" "$build" "$ts")" || \
    php_darwin_die 'could not reset formula-managed PHP configuration'
  if brew list --formula | grep -Eq '^php(@[0-9]+\.[0-9]+)?(-debug)?(-zts)?$'; then
    php_darwin_die 'a Homebrew PHP formula remained after the validation reset'
  fi
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

  trap cleanup_homebrew_validation EXIT

  tap_path=$(brew --repository "$tap") || php_darwin_die "could not resolve the installed $tap repository"
  [ -d "$tap_path/.git" ] || php_darwin_die "the cache did not install the $tap repository"
  brew tap | grep -Fxq "$tap" || php_darwin_die "Homebrew does not list the cached $tap snapshot"
  tap_repository=$(php_darwin_package_config tap_repository)
  [ "$(git -C "$tap_path" remote get-url origin)" = "$tap_repository" ] || \
    php_darwin_die "the cached $tap snapshot has the wrong origin"
  tap_branch=$(php_darwin_package_config tap_branch)
  [ "$(git -C "$tap_path" symbolic-ref --short HEAD)" = "$tap_branch" ] || \
    php_darwin_die "the cached $tap snapshot is not on $tap_branch"
  [ "$(git -C "$tap_path" config "branch.$tap_branch.remote")" = origin ] && \
    [ "$(git -C "$tap_path" config "branch.$tap_branch.merge")" = "refs/heads/$tap_branch" ] || \
    php_darwin_die "the cached $tap snapshot is not configured for updates"
  if brew trust --json=v1 | jq -e --arg tap "$tap" '.taps | index($tap) != null' >/dev/null; then
    tap_trust_after=true
  else
    tap_trust_after=false
  fi
  [ "$tap_trust_after" = true ] || php_darwin_die 'cache installation did not trust the installed Homebrew tap'
  if [ "$(cat "$tap_trust_before")" = false ]; then
    : > "$validation_trust_added"
  fi
  brew formula "$tap/$requested_formula" >/dev/null || \
    php_darwin_die "Homebrew cannot resolve $tap/$requested_formula from the cached tap"

  brew list --versions "$formula" || php_darwin_die 'Homebrew does not list the cached PHP formula'
  brew info --installed --json=v2 | jq -e --arg formula "$formula" \
    'any(.formulae[]; .name == $formula and (.installed | length > 0))' >/dev/null || \
    php_darwin_die 'Homebrew cannot read the cached PHP receipt'
  missing=$(brew missing "$formula" 2>&1)
  missing_status=$?
  [ "$missing_status" -eq 0 ] || [ -n "$missing" ] || php_darwin_die 'Homebrew dependency validation failed without diagnostics'
  [ -z "$missing" ] || php_darwin_die "Homebrew reports missing dependencies: $missing"
  brew linkage --test "$formula" || php_darwin_die 'Homebrew linkage validation failed'
  brew list --formula | LC_ALL=C sort -u > "$installed_after" || \
    php_darwin_die 'could not record the final Homebrew formulae'
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

  brew unlink "$formula" || php_darwin_die 'Homebrew could not unlink the cached PHP formula'
  brew link --overwrite --force "$formula" || php_darwin_die 'Homebrew could not relink the cached PHP formula'
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

  cleanup_homebrew_validation
  trap - EXIT

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
