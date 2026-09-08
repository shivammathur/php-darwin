#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

version=${PHP_VERSION:-${1:-}}
php_darwin_validate_version "$version"
arch=$(php_darwin_normalize_arch "$(uname -m)") || exit 1
asset=$(php_darwin_asset "$version" release nts "$arch") || exit 1
brew_prefix=$(brew --prefix) || php_darwin_die 'could not resolve the Homebrew prefix'
formula=$(php_darwin_formula "$version" release nts) || exit 1
metadata="$brew_prefix/$(php_darwin_metadata_path "$asset")"

# shellcheck disable=SC2016
php -r '
  $expected = getenv("PHP_VERSION");
  $actual = PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION;
  if ($actual !== $expected) {
    fwrite(STDERR, "Expected PHP $expected, found $actual\n");
    exit(1);
  }
' || php_darwin_die "PHP $version is not active"

if [ "${PHP_DARWIN_REQUIRE_XDEBUG:-false}" = true ]; then
  # shellcheck disable=SC2016
  php -r '
    if (!extension_loaded("xdebug")) {
      fwrite(STDERR, "Xdebug is not loaded\n");
      exit(1);
    }
  ' || php_darwin_die 'cache-extensions integration failed'
fi
if [ "${PHP_DARWIN_REQUIRE_PCOV:-false}" = true ]; then
  # shellcheck disable=SC2016
  php -r '
    if (!extension_loaded("pcov")) {
      fwrite(STDERR, "PCOV is not loaded\n");
      exit(1);
    }
  ' || php_darwin_die 'PCOV cache integration failed'
fi
if [ "${PHP_DARWIN_REQUIRE_XDEBUG:-false}" != true ] && \
  [ "${PHP_DARWIN_REQUIRE_PCOV:-false}" != true ]; then
  while IFS= read -r extension; do
    php -r "if (extension_loaded('$extension')) { exit(1); }" || \
      php_darwin_die "$extension is enabled by default after a direct cache install"
  done < <(bash "$script_dir/cached-extensions.sh" "$version")
fi

tap=$(php_darwin_package_config tap) || php_darwin_die 'could not read the Homebrew tap configuration'
trust_json=$(brew trust --json=v1) || php_darwin_die 'could not read Homebrew trust state'
if ! php_darwin_tap_trusted "$tap" "$trust_json" && \
  ! php_darwin_formula_trusted "$tap/$formula" "$trust_json"; then
  php_darwin_die "Homebrew does not trust the installed PHP $version formula"
fi

if [ "${PHP_DARWIN_REQUIRE_CACHE:-false}" = true ]; then
  baseline=${PHP_DARWIN_E2E_BASELINE:-${RUNNER_TEMP:?}/php-darwin-e2e-formulae.txt}
  installed_after=${RUNNER_TEMP:?}/php-darwin-e2e-formulae-after.txt
  cache_packages=${RUNNER_TEMP:?}/php-darwin-e2e-cache-packages.txt
  new_formulae=${RUNNER_TEMP:?}/php-darwin-e2e-new-formulae.txt
  extra_formulae=${RUNNER_TEMP:?}/php-darwin-e2e-extra-formulae.txt
  extra_info=${RUNNER_TEMP:?}/php-darwin-e2e-extra-formulae.json
  pecl_packages=${RUNNER_TEMP:?}/php-darwin-e2e-pecl-packages.txt

  [ -s "$baseline" ] || php_darwin_die 'the E2E Homebrew baseline is missing'
  [ -f "$metadata" ] && [ ! -L "$metadata" ] || \
    php_darwin_die 'setup-php did not install php-darwin cache metadata'
  actual_semver=$(php -r 'echo PHP_VERSION;') || php_darwin_die 'PHP could not report its version'
  metadata_values=$(jq -er --arg version "$version" --arg arch "$arch" --arg asset "$asset" \
    --arg formula "$formula" '
      select(.schema == 1 and .php_version == $version and .architecture == $arch and
        .archive == $asset and .build == "release" and .thread_safety == "nts" and
        .formula == $formula and (.php_semver | type == "string")) |
      [.php_semver, (.packages[] | select(.name == $formula) | .opt_target)] | @tsv
    ' "$metadata") || php_darwin_die 'installed php-darwin metadata does not match the E2E request'
  IFS=$'\t' read -r metadata_semver metadata_opt_target <<< "$metadata_values" || \
    php_darwin_die 'could not read installed php-darwin metadata'
  [ "$actual_semver" = "$metadata_semver" ] || \
    php_darwin_die "setup-php used PHP $actual_semver instead of cached PHP $metadata_semver"
  [ "$(readlink "$brew_prefix/opt/$formula")" = "$metadata_opt_target" ] || \
    php_darwin_die 'the active PHP keg does not match the installed cache metadata'

  brew list --formula | LC_ALL=C sort -u > "$installed_after" || \
    php_darwin_die 'could not list Homebrew formulae after setup-php'
  LC_ALL=C comm -13 "$baseline" "$installed_after" > "$new_formulae" || \
    php_darwin_die 'could not identify formulae added during the E2E install'
  jq -er '.packages[].name' "$metadata" | LC_ALL=C sort -u > "$cache_packages" || \
    php_darwin_die 'could not read the cached Homebrew package list'
  LC_ALL=C comm -23 "$new_formulae" "$cache_packages" > "$extra_formulae" || \
    php_darwin_die 'could not identify formulae installed outside the PHP cache'
  if [ -s "$extra_formulae" ]; then
    extra_formula_names=()
    while IFS= read -r extra_formula; do
      [ -n "$extra_formula" ] && extra_formula_names+=("$extra_formula")
    done < "$extra_formulae"
    brew info --installed --json=v2 "${extra_formula_names[@]}" > "$extra_info" || \
      php_darwin_die 'could not inspect formulae installed outside the PHP cache'
    jq -e 'all(.formulae[]; (.installed | length) > 0 and all(.installed[]; .poured_from_bottle == true))' \
      "$extra_info" >/dev/null || \
      php_darwin_die 'setup-php built a formula from source outside the PHP cache'
  fi

  pecl list > "$pecl_packages" || php_darwin_die 'PECL could not list installed packages'
  while IFS= read -r cached_extension; do
    [ -n "$cached_extension" ] || continue
    if awk -v extension="$cached_extension" 'tolower($1) == tolower(extension) { found=1 } END { exit !found }' \
      "$pecl_packages"; then
      php_darwin_die "setup-php rebuilt cached $cached_extension with PECL"
    fi
  done < <(jq -r '(.extensions // [])[].name' "$metadata")
fi

printf 'Verified php-darwin cache installation for PHP %s' "$version"
[ "${PHP_DARWIN_REQUIRE_XDEBUG:-false}" != true ] || printf ' with cache-extensions'
printf '\n'
