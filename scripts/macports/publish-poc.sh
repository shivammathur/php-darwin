#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/macports/lib.sh
. "$script_dir/lib.sh"

assets_dir=${1:?}
version=${PHP_VERSION:-8.5}
repository=${GITHUB_REPOSITORY:-shivammathur/php-darwin}
token=${GITHUB_TOKEN:?}
tag=$(php_darwin_macports_release_tag "$version") || exit 1
api="https://api.github.com/repos/$repository"
upload_api="https://uploads.github.com/repos/$repository"
work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-macports-publish.XXXXXX") || \
  php_darwin_macports_die 'could not create the publish directory'
trap 'rm -rf "$work_dir"' EXIT
release_json="$work_dir/release.json"
response_json="$work_dir/response.json"

github_request() {
  curl --fail --silent --show-error \
    -H 'Accept: application/vnd.github+json' \
    -H "Authorization: Bearer $token" \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "$@"
}

status=$(github_request --output "$release_json" --write-out '%{http_code}' "$api/releases/tags/$tag" 2>/dev/null) || true
if [ "$status" = 404 ]; then
  jq -n --arg tag "$tag" \
    '{tag_name:$tag,name:$tag,prerelease:true,generate_release_notes:false}' > "$work_dir/create.json" || exit 1
  github_request --request POST --data-binary "@$work_dir/create.json" "$api/releases" > "$release_json" || \
    php_darwin_macports_die "could not create release $tag"
elif [ "$status" != 200 ]; then
  php_darwin_macports_die "could not inspect release $tag (HTTP $status)"
fi
release_id=$(jq -er '.id' "$release_json") || php_darwin_macports_die 'could not resolve the release id'

for asset in "$assets_dir"/*; do
  [ -f "$asset" ] || continue
  name=${asset##*/}
  case "$name" in *.tar.zst|*.sha256|*.json|install.sh) ;; *) continue ;; esac
  existing_id=$(jq -r --arg name "$name" '.assets[]? | select(.name == $name) | .id' "$release_json") || exit 1
  if [ -n "$existing_id" ]; then
    github_request --request DELETE "$api/releases/assets/$existing_id" >/dev/null || \
      php_darwin_macports_die "could not replace existing asset $name"
  fi
  encoded_name=$(jq -rn --arg name "$name" '$name | @uri') || exit 1
  github_request --request POST --header 'Content-Type: application/octet-stream' \
    --data-binary "@$asset" "$upload_api/releases/$release_id/assets?name=$encoded_name" > "$response_json" || \
    php_darwin_macports_die "could not upload $name"
  [ "$(jq -r '.state' "$response_json")" = uploaded ] || php_darwin_macports_die "GitHub did not finish uploading $name"
done
printf 'Published Intel/MacPorts POC assets to %s\n' "$tag"
