#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"
version=${PHP_VERSION:?}
arch=${ARCH:?}
work_dir=${RUNNER_TEMP:?}/migration
export ARCHIVE_DIR=$work_dir/archives
repo=$(php_darwin_package_config release_repository) || exit 1
php_darwin_validate_release_manifest "$work_dir/candidate.json" "$version" || exit 1
variants=$(php_darwin_configured_variants) || exit 1
php_darwin_configure_homebrew_environment
case "${1:?}" in
  download)
    mkdir -p "$ARCHIVE_DIR" || exit 1
    jq -r --arg arch "$arch" '.assets[] | select(.architecture==$arch) | [.name,.download,.sha256] | @tsv' \
      "$work_dir/candidate.json" > "$work_dir/downloads" || exit 1
    while IFS=$'\t' read -r asset download hash; do
      curl --config "$script_dir/../conf/download.conf" -fSL \
        "https://github.com/$repo/releases/download/php-$version/$download" -o "$ARCHIVE_DIR/$asset" || exit 1
      [ "$(php_darwin_sha256 "$ARCHIVE_DIR/$asset")" = "$hash" ] || php_darwin_die 'candidate download checksum mismatch'
      cp "$work_dir/records/$asset.sha256" "$work_dir/records/${asset%.tar.zst}.json" "$ARCHIVE_DIR/" || exit 1
    done < "$work_dir/downloads"
    ;;
  variants)
    date +%s > "$work_dir/test-started" || exit 1
    last_variant=$(printf '%s\n' "$variants" | tail -1)
    while read -r build ts; do
      export BUILD=$build TS=$ts
      for stage in prepare install runtime homebrew; do
        printf '::group::PHP %s %s/%s %s\n' "$version" "$build" "$ts" "$stage"
        bash "$script_dir/test-install.sh" "$stage" || exit 1
        printf '::endgroup::\n'
      done
      if [ "$build $ts" != "$last_variant" ]; then
        bash "$script_dir/test-install.sh" reset || exit 1
      fi
    done <<< "$variants"
    brew info --installed --json=v2 > "$work_dir/installed.json" || exit 1
    jq -e --argjson start "$(cat "$work_dir/test-started")" \
      'all(.formulae[].installed[]; (.time // 0) < $start or .poured_from_bottle==true)' \
      "$work_dir/installed.json" || php_darwin_die 'a test installed a formula from source'
    ;;
  update)
    read -r build ts <<< "$(printf '%s\n' "$variants" | tail -1)" || exit 1
    formula=$(php_darwin_formula "$version" "$build" "$ts") || exit 1
    unset HOMEBREW_NO_INSTALL_FROM_API
    brew update || exit 1
    brew upgrade --dry-run || exit 1
    brew missing "$formula" || exit 1
    php -v || exit 1
    ;;
  *) exit 1 ;;
esac
