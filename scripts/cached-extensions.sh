#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

requested_version=${1:?}
output=${2:-names}
configured_version=
extensions=
extension=
extension_name=
extension_type=
seen_extensions=
seen_versions=

php_darwin_validate_version "$requested_version"
case "$output" in names|records) ;; *) php_darwin_die 'usage: cached-extensions.sh VERSION [names|records]' ;; esac
while read -r configured_version extensions; do
  [ -n "$configured_version" ] || continue
  case "$configured_version" in \#*) continue ;; esac
  php_darwin_validate_version "$configured_version" || exit 1
  case " $seen_versions " in
    *" $configured_version "*) php_darwin_die "duplicate cached-extension version: $configured_version" ;;
  esac
  seen_versions="$seen_versions $configured_version"
  [ -n "$extensions" ] || php_darwin_die "cached-extension list is empty for PHP $configured_version"
  seen_extensions=
  for extension in $extensions; do
    extension_name=${extension%%:*}
    extension_type=${extension#*:}
    [[ "$extension_name" =~ ^[A-Za-z0-9_]+$ ]] || \
      php_darwin_die "invalid cached extension: $extension_name"
    case "$extension_type" in
      extension|zend_extension) ;;
      *) php_darwin_die "invalid cached extension type for $extension_name: $extension_type" ;;
    esac
    [ "$extension_name" != "$extension" ] || \
      php_darwin_die "cached extension type is missing for $extension_name"
    case " $seen_extensions " in
      *" $extension_name "*) php_darwin_die "duplicate cached extension for PHP $configured_version: $extension_name" ;;
    esac
    seen_extensions="$seen_extensions $extension_name"
    if [ "$configured_version" = "$requested_version" ]; then
      if [ "$output" = records ]; then
        printf '%s\t%s\n' "$extension_name" "$extension_type"
      else
        printf '%s\n' "$extension_name"
      fi
    fi
  done
done < <(php_darwin_read_config cached-extensions)

case " $seen_versions " in
  *" $requested_version "*) ;;
  *) php_darwin_die "cached extensions are not configured for PHP $requested_version" ;;
esac
