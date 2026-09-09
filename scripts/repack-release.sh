#!/usr/bin/env bash

# One-time migration driver. This never installs or builds any formula.
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"
version=${PHP_VERSION:?}
php_darwin_validate_version "$version"
repo=$(php_darwin_package_config release_repository) || exit 1
[ "$repo" = shivammathur/php-darwin ] || exit 1
tag=php-$version
work_dir=${RUNNER_TEMP:?}/migration
mkdir -p "$work_dir/records" || exit 1
source_manifest=$work_dir/source.json
candidate=$work_dir/candidate.json
manifest_name=$tag-manifest.json

api() {
  curl -fsSL --connect-timeout 15 --max-time 300 \
    -H "Authorization: Bearer ${REPACK_TOKEN:?}" -H 'Accept: application/vnd.github+json' "$@"
}
release_info() {
  api "https://api.github.com/repos/$repo/releases/tags/$tag" > "$work_dir/release.json" || return 1
  release_id=$(jq -er '.id' "$work_dir/release.json")
}
rename_asset() {
  api -X PATCH -H 'Content-Type: application/json' -d "{\"name\":\"$2\"}" \
    "https://api.github.com/repos/$repo/releases/assets/$1" > "$work_dir/rename-$1.json"
}
upload_asset() {
  local file=$1 name=$2 hash encoded_name existing_id existing_digest
  hash=$(php_darwin_sha256 "$file") || return 1
  existing_id=$(jq -r --arg name "$name" '.assets[] | select(.name==$name) | .id' "$work_dir/release.json") || return 1
  if [ -n "$existing_id" ]; then
    jq -e --arg name "$name" --argjson bytes "$(wc -c < "$file" | tr -d ' ')" \
      'any(.assets[]; .name==$name and .state=="uploaded" and .size==$bytes)' \
      "$work_dir/release.json" >/dev/null || return 1
    existing_digest=$(jq -r --arg name "$name" '.assets[] | select(.name==$name) | .digest // ""' "$work_dir/release.json") || return 1
    if [ -z "$existing_digest" ]; then
      curl -fsSL --retry 2 "https://github.com/$repo/releases/download/$tag/$name?asset=$existing_id" \
        -o "$work_dir/verify-existing" || return 1
      [ "$(php_darwin_sha256 "$work_dir/verify-existing")" = "$hash" ] || return 1
    else
      [ "$existing_digest" = "sha256:$hash" ] || return 1
    fi
    printf '%s\n' "$existing_id"
    return 0
  fi
  encoded_name=${name//+/%2B}
  api -X POST -H 'Content-Type: application/octet-stream' --data-binary "@$file" \
    "https://uploads.github.com/repos/$repo/releases/$release_id/assets?name=$encoded_name" > "$work_dir/upload-$name.json" || return 1
  jq -e --arg digest "sha256:$hash" --arg name "$name" \
    '.state=="uploaded" and .digest==$digest and .name==$name' "$work_dir/upload-$name.json" >/dev/null || return 1
  jq -er '.id' "$work_dir/upload-$name.json"
}

committed=false
old_install_moved=false
new_install_active=false
old_manifest_moved=false
new_manifest_active=false
cleanup() {
  local result=$?
  trap - EXIT
  trap '' HUP INT TERM
  if [ "$committed" != true ]; then
    if [ "$new_manifest_active" = true ]; then
      rename_asset "$new_manifest_id" "$manifest_pending" || printf 'Recover the manifest from %s\n' "$work_dir" >&2
    fi
    if [ "$old_manifest_moved" = true ]; then
      rename_asset "$old_manifest_id" "$manifest_name" || printf 'Restore asset %s as %s\n' "$old_manifest_id" "$manifest_name" >&2
    fi
    if [ "$new_install_active" = true ]; then
      rename_asset "$new_install_id" "$install_pending" || printf 'Recover the installer from %s\n' "$work_dir" >&2
    fi
    if [ "$old_install_moved" = true ]; then
      rename_asset "$old_install_id" install.sh || printf 'Restore asset %s as install.sh\n' "$old_install_id" >&2
    fi
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

case "${1:?}" in
  plan)
    response=$(php_darwin_fetch_release_manifest "$repo" "$version" "$source_manifest") || exit 1
    [ "$response" = 200 ] || php_darwin_die "could not fetch $tag manifest: HTTP $response"
    php_darwin_validate_release_manifest "$source_manifest" "$version" || exit 1
    php_darwin_release_manifest_has_current_platforms "$source_manifest" || exit 1
    assets=$(jq -c '{include:.assets}' "$source_manifest") || exit 1
    tests=$(jq -c '{include:[to_entries[] | {arch:.key,runner:.value.build_runner}]}' \
      "$script_dir/../conf/platforms.json") || exit 1
    printf 'assets=%s\ntests=%s\n' "$assets" "$tests" >> "${GITHUB_OUTPUT:?}" || exit 1
    ;;
  repack)
    php_darwin_validate_release_manifest "$source_manifest" "$version" '' "${ASSET:?}" > "$work_dir/selection" || exit 1
    IFS=$'\t' read -r hash _ _ _ _ download _ < "$work_dir/selection" || exit 1
    curl --config "$script_dir/../conf/download.conf" -fSL \
      "https://github.com/$repo/releases/download/$tag/$download" -o "$work_dir/source.tar.zst" || exit 1
    bash "$script_dir/repack.sh" "$work_dir/source.tar.zst" "$hash" "$work_dir/repacked" || exit 1
    ;;
  stage)
    php_darwin_validate_release_manifest "$source_manifest" "$version" '' "${ASSET:?}" >/dev/null || exit 1
    archive=$work_dir/repacked/$ASSET
    hash=$(php_darwin_checksum_from_file "$archive.sha256" "$ASSET") || exit 1
    [ "$(php_darwin_sha256 "$archive")" = "$hash" ] || exit 1
    download=$(php_darwin_download_asset "$ASSET" "$hash") || exit 1
    release_info || exit 1
    upload_asset "$archive" "$download" >/dev/null || php_darwin_die 'could not stage immutable archive'
    printf '%s  %s\n' "$hash" "$download" > "$work_dir/$download.sha256" || exit 1
    upload_asset "$work_dir/$download.sha256" "$download.sha256" >/dev/null || exit 1
    jq --arg asset "$ASSET" --arg hash "$hash" --arg download "$download" \
      --argjson bytes "$(wc -c < "$archive" | tr -d ' ')" '
      .assets[] | select(.name==$asset) | .sha256=$hash | .download=$download | .bytes=$bytes
    ' "$source_manifest" > "$work_dir/records/entry-$ASSET.json" || exit 1
    cp "$archive.sha256" "${archive%.tar.zst}.json" "$work_dir/records/" || exit 1
    ;;
  assemble)
    php_darwin_validate_release_manifest "$source_manifest" "$version" || exit 1
    jq -s '.' "$work_dir"/records/entry-*.json > "$work_dir/entries.json" || exit 1
    jq --slurpfile entries "$work_dir/entries.json" '.assets=($entries[0] | sort_by(.name))' \
      "$source_manifest" > "$candidate" || exit 1
    php_darwin_validate_release_manifest "$candidate" "$version" || exit 1
    jq -r '.assets[] | [.name,.build,.thread_safety,.architecture,.minimum_macos] | @tsv' \
      "$candidate" > "$work_dir/assets.tsv" || exit 1
    while IFS=$'\t' read -r asset build ts arch minimum; do
      metadata=$work_dir/records/${asset%.tar.zst}.json
      prefix=$(php_darwin_expected_prefix "$arch") || exit 1
      php_darwin_validate_cache_metadata "$metadata" "$version" "$build" "$ts" "$arch" "$prefix" "$minimum" >/dev/null || exit 1
      jq -e --slurpfile source "$source_manifest" '
        . as $metadata | all(["php_semver","php_src_commit","source_hash","homebrew_php_commit",
          "homebrew_extensions_commit","extensions_source_hash"][];
          . as $key | ($metadata[$key] // "") == ($source[0][$key] // ""))
      ' "$metadata" >/dev/null || php_darwin_die 'repacked source identity changed'
    done < "$work_dir/assets.tsv"
    ;;
  publish)
    php_darwin_validate_release_manifest "$candidate" "$version" || exit 1
    php_darwin_validate_release_manifest "$source_manifest" "$version" || exit 1
    release_info || exit 1
    old_manifest_id=$(jq -er --arg name "$manifest_name" '.assets[] | select(.name==$name and .state=="uploaded") | .id' "$work_dir/release.json") || exit 1
    old_install_id=$(jq -er '.assets[] | select(.name=="install.sh" and .state=="uploaded") | .id' "$work_dir/release.json") || exit 1
    curl -fsSL --retry 2 "https://github.com/$repo/releases/download/$tag/$manifest_name?asset=$old_manifest_id" -o "$work_dir/previous-manifest.json" || exit 1
    if cmp -s "$candidate" "$work_dir/previous-manifest.json"; then
      printf '%s already publishes this tested candidate\n' "$tag"
      exit 0
    fi
    cmp -s "$source_manifest" "$work_dir/previous-manifest.json" || php_darwin_die 'release changed during migration; refusing to overwrite it'
    curl -fsSL --retry 2 "https://github.com/$repo/releases/download/$tag/install.sh?asset=$old_install_id" -o "$work_dir/previous-install.sh" || exit 1
    jq -e --slurpfile candidate "$candidate" '
      .assets as $published | all($candidate[0].assets[];
        . as $item | any($published[]; .name==$item.download and .state=="uploaded" and
          .size==$item.bytes and .digest==("sha256:"+$item.sha256)))
    ' "$work_dir/release.json" >/dev/null || php_darwin_die 'a tested archive is missing or changed'
    PHP_DARWIN_RELEASE_MANIFEST="$candidate" bash "$script_dir/generate-install.sh" "$work_dir/install.sh" || exit 1
    bash -n "$work_dir/install.sh" || exit 1
    nonce=${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}
    install_pending=install.sh.pending-repack-$nonce
    manifest_pending=$manifest_name.pending-repack-$nonce
    new_install_id=$(upload_asset "$work_dir/install.sh" "$install_pending") || exit 1
    new_manifest_id=$(upload_asset "$candidate" "$manifest_pending") || exit 1
    release_info || exit 1
    jq -e --argjson manifest "$old_manifest_id" --argjson install "$old_install_id" --arg name "$manifest_name" \
      'any(.assets[]; .id==$manifest and .name==$name) and any(.assets[]; .id==$install and .name=="install.sh")' \
      "$work_dir/release.json" >/dev/null || php_darwin_die 'release changed during staging'
    old_install_moved=true
    rename_asset "$old_install_id" "install.sh.previous-repack-$nonce" || exit 1
    new_install_active=true
    rename_asset "$new_install_id" install.sh || exit 1
    old_manifest_moved=true
    rename_asset "$old_manifest_id" "$manifest_name.previous-repack-$nonce" || exit 1
    new_manifest_active=true
    rename_asset "$new_manifest_id" "$manifest_name" || exit 1
    committed=true
    curl -fsSL --retry 2 "https://github.com/$repo/releases/download/$tag/$manifest_name?asset=$new_manifest_id" -o "$work_dir/verified-manifest.json" || exit 1
    curl -fsSL --retry 2 "https://github.com/$repo/releases/download/$tag/install.sh?asset=$new_install_id" -o "$work_dir/verified-install.sh" || exit 1
    cmp -s "$candidate" "$work_dir/verified-manifest.json" || exit 1
    cmp -s "$work_dir/install.sh" "$work_dir/verified-install.sh" || exit 1
    api -X DELETE "https://api.github.com/repos/$repo/releases/assets/$old_manifest_id" || printf 'Old manifest backup retained: %s\n' "$old_manifest_id" >&2
    api -X DELETE "https://api.github.com/repos/$repo/releases/assets/$old_install_id" || printf 'Old installer backup retained: %s\n' "$old_install_id" >&2
    printf 'Published all tested configurations for PHP %s without rebuilding; old archives retained\n' "$version"
    ;;
  *) exit 1 ;;
esac
