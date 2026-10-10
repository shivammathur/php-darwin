#!/usr/bin/env bash

# Validate only the selected identity. Full release/provenance checks run before publication.
php_darwin_validate_release_manifest() {
  jq -e --arg version "$version" --arg arch "$arch" --arg build "$build" --arg ts "$ts" --arg asset "$asset" '
    select(.schema == 1 and .php_version == $version) |
    [.assets[] | select(.architecture == $arch and .build == $build and .thread_safety == $ts)] |
    select(length == 1) | .[0] | select(.name == $asset and
      (.sha256 | type == "string" and test("^[a-f0-9]{64}$")) and
      (.bytes | type == "number" and floor == . and . > 0) and
      (.minimum_macos | type == "number" and floor == . and . > 0) and
      (.download | type == "string" and test("^[A-Za-z0-9_.+-]+\\.tar\\.zst$")))
  ' "$1" >/dev/null
}
php_darwin_use_release_manifest() {
  php_darwin_validate_release_manifest "$1" || return 1
  local values
  values=$(jq -er --arg asset "$asset" '.assets[] | select(.name == $asset) | [.sha256,.download,.bytes,.minimum_macos] | @tsv' "$1") || return 1
  IFS=$'\t' read -r expected_hash manifest_download_asset manifest_archive_bytes minimum_macos <<< "$values"
  [ "$manifest_download_asset" = "${asset%.tar.zst}.$expected_hash.tar.zst" ] || return 1
  [ "$(sw_vers -productVersion | cut -d. -f1)" -ge "$minimum_macos" ] || php_darwin_die 'archive requires newer macOS'
}
php_darwin_refresh_release_manifest() {
  manifest_url=${PHP_DARWIN_MANIFEST_URL:-}
  [ -n "$manifest_url" ] || manifest_url=$(php_darwin_release_manifest_url "$release_repository" "$version") || \
    php_darwin_die 'could not construct the release manifest URL'
  manifest_status=$(php_darwin_fetch_release_manifest "$release_repository" "$version" \
    "$release_manifest" "${PHP_DARWIN_MANIFEST_URL:-}") || php_darwin_die "could not request $manifest_url"
  [ "$manifest_status" = 200 ] || \
    php_darwin_die "could not fetch the PHP $version release manifest (HTTP $manifest_status)"
  php_darwin_use_release_manifest "$release_manifest" || \
    php_darwin_die 'release manifest did not match the requested PHP version'
  manifest_from_embedded=false
}

php_darwin_download_release_archive() {
  local archive_http_status
  local mirror_url
  local urls=()
  local destination transfer_policy transfer_limit transfer_speed transfer_timeout
  transfer_policy=$(php_darwin_read_config transfers.json | jq -er '[.archive.speed_limit,.archive.speed_time,.archive.timeout] | @tsv') || return 1
  IFS=$'\t' read -r transfer_limit transfer_speed transfer_timeout <<< "$transfer_policy"
  local resume_bytes='' request_result received_bytes

  release_archive_error=
  release_url=${PHP_DARWIN_RELEASE_URL:-https://github.com/$release_repository/releases/download/php-$version/$manifest_download_asset}
  urls+=("$release_url")
  if [ -z "${PHP_DARWIN_RELEASE_URL:-}" ] || [ -n "${PHP_DARWIN_MIRROR_URL:-}" ]; then
    mirror_url=$(php_darwin_release_mirror "$release_repository" "$version") || return 1
    [ -z "$mirror_url" ] || urls+=("$mirror_url/$manifest_download_asset")
    if [ -n "$mirror_url" ] && [ "${PHP_DARWIN_PREFER_MIRROR:-false}" = true ]; then
      urls=("$mirror_url/$manifest_download_asset" "$release_url")
    fi
  fi
  release_archive_error=not-found
  for release_url in "${urls[@]}"; do
    destination=$archive
    [ -z "$resume_bytes" ] || destination="$archive.remaining"
    request_result=0
    archive_http_status=$(php_darwin_request_release "$release_url" "$destination" \
      "$transfer_limit" "$transfer_speed" "$transfer_timeout" "$resume_bytes") || request_result=$?
    if [ "$request_result" -ne 0 ]; then
      [ "$release_archive_error" = checksum ] || release_archive_error=download
      if [ "$archive_http_status" = 200 ] && [ -s "$archive" ] && [ -z "$resume_bytes" ]; then
        received_bytes=$(wc -c < "$archive" | tr -d '[:space:]')
        if [ "$received_bytes" -lt "$manifest_archive_bytes" ]; then
          # A known incomplete prefix cannot match the digest. Start the mirror
          # immediately and authenticate the complete combined archive below.
          resume_bytes=$received_bytes
        elif [ "$received_bytes" -eq "$manifest_archive_bytes" ]; then
          # A timeout can arrive after the last byte. Still require its digest;
          # a corrupt complete response must restart at the next origin.
          php_darwin_start_archive_hash "$archive"
          php_darwin_wait_for_archive_hash
          if [ "$actual_hash" = "$expected_hash" ]; then release_archive_error=; return 0; fi
          release_archive_error=checksum
        fi
      fi
      continue
    fi
    if [ -n "$resume_bytes" ]; then
      case "$archive_http_status" in
        206) cat "$destination" >> "$archive" || return 1 ;;
        # Range is optional at the origin. A full response replaces the prefix.
        200) mv "$destination" "$archive" || return 1 ;;
      esac
    fi
    if [ "$archive_http_status" != 200 ] && \
      { [ "$archive_http_status" != 206 ] || [ -z "$resume_bytes" ]; }; then
      if [ "$archive_http_status" != 404 ] && [ "$release_archive_error" != checksum ]; then
        release_archive_error=download
      fi
      continue
    fi
    php_darwin_start_archive_hash "$archive"
    php_darwin_wait_for_archive_hash
    if [ "$actual_hash" = "$expected_hash" ]; then
      release_archive_error=
      return 0
    fi
    printf 'php-darwin: checksum mismatch from %s; trying the next origin\n' "$release_url" >&2
    release_archive_error=checksum
    resume_bytes=
  done
  return 1
}

