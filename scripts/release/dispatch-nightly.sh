#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib/lib.sh
. "$script_dir/../lib/lib.sh"

versions=$(php_darwin_nightly_versions) || exit 1
repository=${GITHUB_REPOSITORY:-$(php_darwin_package_config release_repository)}
ref=${GITHUB_REF_NAME:-main}

active=$(gh api --paginate "repos/$repository/actions/workflows/cache-nightly.yml/runs?branch=$ref&per_page=100" \
  --jq '.workflow_runs[] | select(.status != "completed") | .display_title') || exit 1

while IFS= read -r version; do
  if [ -n "$active" ] && printf '%s\n' "$active" | grep -Fxq "Cache nightly PHP $version"; then
    printf 'PHP %s already has an active nightly cache workflow\n' "$version"
    continue
  fi
  gh workflow run cache-nightly.yml --repo "$repository" --ref "$ref" \
    -f "php-version=$version" || php_darwin_die "could not dispatch the PHP $version nightly cache"
done <<< "$versions"
