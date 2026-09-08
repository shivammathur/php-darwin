#!/usr/bin/env bash

assets_dir=${1:?}
repository=${GITHUB_REPOSITORY:-shivammathur/php-darwin}
token=${GITHUB_TOKEN:?}
tag=php-8.5-intel-poc
api="https://api.github.com/repos/$repository"
upload_api="https://uploads.github.com/repos/$repository"
work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-intel-publish.XXXXXX") || exit 1
trap 'rm -rf "$work_dir"' EXIT
release_json="$work_dir/release.json"
response_json="$work_dir/response.json"
required_assets='install.sh
php-8.5-manifest.json
php_8.5-nts-release+darwin_x86_64.json
php_8.5-nts-release+darwin_x86_64.tar.zst
php_8.5-nts-release+darwin_x86_64.tar.zst.sha256'

for name in $required_assets; do
  [ -f "$assets_dir/$name" ] || {
    printf 'Required Intel POC asset is missing: %s\n' "$name" >&2
    exit 1
  }
done
actual_count=$(find "$assets_dir" -maxdepth 1 -type f | awk 'END { print NR+0 }') || exit 1
[ "$actual_count" -eq 5 ] || {
  printf 'Expected 5 Intel POC assets, found %s\n' "$actual_count" >&2
  exit 1
}

request() {
  curl --fail --silent --show-error -H 'Accept: application/vnd.github+json' \
    -H "Authorization: Bearer $token" -H 'X-GitHub-Api-Version: 2022-11-28' "$@"
}
status=$(request --output "$release_json" --write-out '%{http_code}' "$api/releases/tags/$tag" 2>/dev/null) || true
if [ "$status" = 404 ]; then
  jq -n --arg tag "$tag" '{tag_name:$tag,name:$tag,prerelease:true,generate_release_notes:false}' \
    > "$work_dir/create.json" || exit 1
  request --request POST --data-binary "@$work_dir/create.json" "$api/releases" > "$release_json" || exit 1
elif [ "$status" != 200 ]; then
  printf 'Could not inspect %s (HTTP %s)\n' "$tag" "$status" >&2
  exit 1
fi
release_id=$(jq -er '.id' "$release_json") || exit 1
for asset in "$assets_dir"/*; do
  [ -f "$asset" ] || continue
  name=${asset##*/}
  case "$name" in *.tar.zst|*.sha256|*.json|install.sh) ;; *) continue ;; esac
  existing_id=$(jq -r --arg name "$name" '.assets[]? | select(.name == $name) | .id' "$release_json") || exit 1
  if [ -n "$existing_id" ]; then
    request --request DELETE "$api/releases/assets/$existing_id" >/dev/null || exit 1
  fi
  encoded_name=$(jq -rn --arg name "$name" '$name | @uri') || exit 1
  request --request POST --header 'Content-Type: application/octet-stream' --data-binary "@$asset" \
    "$upload_api/releases/$release_id/assets?name=$encoded_name" > "$response_json" || exit 1
  [ "$(jq -r '.state' "$response_json")" = uploaded ] || exit 1
done
printf 'Published %s\n' "$tag"
