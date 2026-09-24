#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib/lib.sh
. "$script_dir/../lib/lib.sh"
[ "${GITHUB_ACTIONS:-}" = true ] || php_darwin_die 'extension builds require an Actions runner'
php_darwin_configure_homebrew_environment
formula=$(php_darwin_formula "${PHP_VERSION:?}" "${BUILD:?}" "${TS:?}")
tap=$(php_darwin_package_config tap)
tap_path=$(php_darwin_tap_repository_path "$tap")
# A build runner may retain a detached tap from an earlier job. The published
# PHP archive supplies its matching tap; every installed PHP keg stays in place.
if [ -d "$tap_path" ]; then HOMEBREW_DEVELOPER=1 brew untap "$tap"; fi
PHP_DARWIN_PREFER_MIRROR=true bash "$script_dir/../install.sh" "$PHP_VERSION" "$BUILD" "$TS"
"$(brew --prefix)/opt/$formula/bin/php" -n -v
brew tap shivammathur/extensions
brew trust shivammathur/extensions
extension_tap=$(brew --repository shivammathur/extensions)
git -C "$extension_tap" fetch --depth=1 origin "${HOMEBREW_EXTENSIONS_COMMIT:?}"
git -C "$extension_tap" checkout --detach "$HOMEBREW_EXTENSIONS_COMMIT"
