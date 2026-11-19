#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib/lib.sh
. "$script_dir/../lib/lib.sh"

only_version=${ONLY_VERSION:-}
release_repository=$(php_darwin_package_config release_repository)
workflow_repository=${GITHUB_REPOSITORY:-shivammathur/php-darwin}
workflow_ref=${GITHUB_REF_NAME:-main}
work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-update.XXXXXX") || \
  php_darwin_die 'could not create the release update directory'
trap 'rm -rf "$work_dir"' EXIT

active_runs=$(gh api --method GET \
  "repos/$workflow_repository/actions/workflows/cache-stable.yml/runs" \
  -f branch="$workflow_ref" -F per_page=100 \
  --jq '.workflow_runs[] | [.status,.display_title] | @tsv') || \
  php_darwin_die 'could not inspect active stable cache workflows'

if [ -n "$only_version" ]; then
  php_darwin_validate_channel "$only_version" stable
  version_values=("$only_version")
else
  version_values=()
  configured_versions=$(php_darwin_configured_versions) || \
    php_darwin_die 'could not read the configured PHP versions'
  while read -r channel version; do
    [ "$channel" = stable ] && version_values+=("$version")
  done <<< "$configured_versions"
  [ "${#version_values[@]}" -gt 0 ] || php_darwin_die 'no stable PHP versions are configured'
fi

for version in "${version_values[@]}"; do
  current=$(bash "$script_dir/../lib/source-hash.sh" "$version") || \
    php_darwin_die "could not compute the PHP $version source hash"
  manifest="$work_dir/php-$version-manifest.json"
  published=
  manifest_current_platforms=false
  manifest_source_commit=
  manifest_extension_commit=
  php_current=false
  if ! http_status=$(php_darwin_fetch_release_manifest "$release_repository" "$version" "$manifest"); then
    php_darwin_die "could not request the PHP $version release manifest"
  fi
  case "$http_status" in
    200)
      if php_darwin_validate_release_manifest "$manifest" "$version" stable 2>/dev/null; then
        published=$(jq -er '.source_hash' "$manifest") || \
          php_darwin_die "could not read the PHP $version published source hash"
        php_current=$(bash "$script_dir/../build/build-inputs-current.sh" "$manifest" "$version" php "$current" "$published") || \
          php_darwin_die "could not compare PHP $version build inputs"
        if php_darwin_release_manifest_has_current_platforms "$manifest"; then
          manifest_current_platforms=true
        else
          manifest_source_commit=$(jq -er '.homebrew_php_commit | select(type == "string" and test("^[0-9a-f]{40}$"))' \
            "$manifest") || php_darwin_die "could not read the PHP $version published homebrew-php commit"
          manifest_extension_commit=$(jq -er '.homebrew_extensions_commit | select(type == "string" and test("^[0-9a-f]{40}$"))' \
            "$manifest") || php_darwin_die "could not read the PHP $version published homebrew-extensions commit"
        fi
      fi
      ;;
    404) ;;
    *) php_darwin_die "could not fetch the PHP $version release manifest (HTTP $http_status)" ;;
  esac
  # Dependency and coverage-extension updates do not rebuild stable PHP.
  # A manual cache-stable.yml dispatch with force=true can refresh them.
  if [ "$php_current" = true ] && [ "$manifest_current_platforms" = true ]; then
    printf 'Retaining published PHP %s: the homebrew-php recipes have not changed\n' "$version"
    continue
  fi

  architectures='arm64 x86_64'
  pinned_arguments=()
  if [ "$php_current" = true ] && [ "$manifest_current_platforms" = false ] && [ -n "$manifest_source_commit" ] && \
    [ -n "$manifest_extension_commit" ]; then
    architectures=$(php_darwin_release_manifest_outdated_architectures "$manifest") || exit 1
    pinned_arguments=(-f "homebrew-php-commit=$manifest_source_commit" \
      -f "homebrew-extensions-commit=$manifest_extension_commit")
    printf 'Updating PHP %s platform caches: %s\n' "$version" "$architectures"
  fi
  if [ -n "$published" ]; then
    printf 'Dispatching PHP %s: published PHP source %s, current PHP source %s\n' \
      "$version" "$published" "$current"
  else
    printf 'Dispatching PHP %s: no valid release manifest, current source %s\n' "$version" "$current"
  fi
  if awk -F '\t' -v title="Cache stable PHP $version" \
    '$1 != "completed" && $2 == title { found=1 } END { exit !found }' <<< "$active_runs"; then
    printf 'PHP %s already has an active cache workflow; skipping duplicate dispatch\n' "$version"
    continue
  fi
  gh workflow run cache-stable.yml --repo "$workflow_repository" \
    --ref "$workflow_ref" -f php-version="$version" -f builds='debug release' \
    -f ts='nts zts' -f architectures="$architectures" "${pinned_arguments[@]}" -f publish=true || exit 1
done
