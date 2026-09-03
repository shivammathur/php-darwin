#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

requested_version=${1:?}
configured_version=
extensions=
extension=
seen_versions=

php_darwin_validate_version "$requested_version"
while read -r configured_version extensions; do
  [ -n "$configured_version" ] || continue
  case "$configured_version" in \#*) continue ;; esac
  php_darwin_validate_version "$configured_version" || exit 1
  case " $seen_versions " in
    *" $configured_version "*) php_darwin_die "duplicate cached-extension version: $configured_version" ;;
  esac
  seen_versions="$seen_versions $configured_version"
  [ -n "$extensions" ] || php_darwin_die "cached-extension list is empty for PHP $configured_version"
  for extension in $extensions; do
    case "$extension" in
      xdebug|pcov) ;;
      *) php_darwin_die "unsupported cached extension: $extension" ;;
    esac
    [ "$configured_version" != "$requested_version" ] || printf '%s\n' "$extension"
  done
done < <(php_darwin_read_config cached-extensions)

case " $seen_versions " in
  *" $requested_version "*) ;;
  *) php_darwin_die "cached extensions are not configured for PHP $requested_version" ;;
esac
