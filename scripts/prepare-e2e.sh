#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

[ "${GITHUB_ACTIONS:-}" = true ] || \
  php_darwin_die 'prepare-e2e.sh may only modify a GitHub Actions runner'

brew_prefix=$(brew --prefix) || php_darwin_die 'could not resolve the Homebrew prefix'
baseline=${PHP_DARWIN_E2E_BASELINE:-${RUNNER_TEMP:?}/php-darwin-e2e-formulae.txt}
installed_formulae=${RUNNER_TEMP:?}/php-darwin-e2e-installed.txt
installed_php=
installed_php_formulae=()

php_darwin_configure_homebrew_environment
brew list --formula > "$installed_formulae" || \
  php_darwin_die 'could not list preinstalled Homebrew formulae'
while IFS= read -r installed_php; do
  php_darwin_is_php_formula "$installed_php" && installed_php_formulae+=("$installed_php")
done < "$installed_formulae"
if [ "${#installed_php_formulae[@]}" -gt 0 ]; then
  brew uninstall --force --ignore-dependencies "${installed_php_formulae[@]}" || \
    php_darwin_die 'could not remove preinstalled PHP from the E2E fixture'
fi

# A hosted image can retain shared PECL modules after uninstalling PHP. Remove
# only modules bundled by php-darwin so the E2E run cannot mistake them for the
# modules extracted from the requested cache.
for extension_path in "$brew_prefix"/lib/php/pecl/*/{pcov,xdebug}.so; do
  [ -e "$extension_path" ] || [ -L "$extension_path" ] || continue
  case "$extension_path" in "$brew_prefix"/lib/php/pecl/*/pcov.so|"$brew_prefix"/lib/php/pecl/*/xdebug.so) ;; *)
    php_darwin_die "unsafe cached extension path: $extension_path"
    ;;
  esac
  if [ -w "${extension_path%/*}" ]; then
    rm -f "$extension_path" || php_darwin_die "could not remove $extension_path"
  else
    sudo -n rm -f "$extension_path" || php_darwin_die "could not remove $extension_path"
  fi
done

metadata_dir="$brew_prefix/var/php-darwin"
if [ -d "$metadata_dir" ] && [ ! -L "$metadata_dir" ]; then
  for metadata in "$metadata_dir"/php_*.json; do
    [ -f "$metadata" ] && [ ! -L "$metadata" ] || continue
    rm -f "$metadata" || php_darwin_die "could not remove stale cache metadata: $metadata"
  done
fi

brew list --formula | LC_ALL=C sort -u > "$baseline" || \
  php_darwin_die 'could not record the E2E Homebrew baseline'
printf 'Prepared a PHP-free Homebrew fixture with %s preinstalled formulae\n' \
  "$(wc -l < "$baseline" | tr -d ' ')"
