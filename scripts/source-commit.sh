#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

repository=$(php_darwin_package_config tap_repository)
branch=$(php_darwin_package_config tap_branch)
remote_data=$(git ls-remote "$repository" "refs/heads/$branch") || \
  php_darwin_die "could not resolve $repository $branch"
IFS=$'\t' read -r commit reference <<< "$remote_data"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || php_darwin_die 'homebrew-php returned an invalid source commit'
[ "$reference" = "refs/heads/$branch" ] || php_darwin_die 'homebrew-php returned an unexpected source reference'

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  printf 'commit=%s\n' "$commit" >> "$GITHUB_OUTPUT" || php_darwin_die 'could not write the source commit output'
else
  printf '%s\n' "$commit"
fi
