#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"
staging=${1:?release staging directory required}
mode=${2:-all}
case "$mode" in all|installer-only) ;; *) php_darwin_die "invalid mirror mode: $mode" ;; esac
version=${PHP_VERSION:?}
php_darwin_validate_version "$version"
tag=php-$version
manifest="$staging/$tag-manifest.json"
php_darwin_validate_release_manifest "$manifest" "$version" >/dev/null
[ -s "$staging/install.sh" ] || php_darwin_die 'release installer is missing'
bash -n "$staging/install.sh"
export AWS_ACCESS_KEY_ID=${CF_R2_AWS_ACCESS_KEY_ID:?}
export AWS_SECRET_ACCESS_KEY=${CF_R2_AWS_SECRET_ACCESS_KEY:?}
export AWS_DEFAULT_REGION=auto AWS_EC2_METADATA_DISABLED=true AWS_MAX_ATTEMPTS=5 AWS_RETRY_MODE=standard
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
endpoint=${CF_R2_AWS_S3_ENDPOINT:?}
mirror=$(php_darwin_release_mirror shivammathur/php-darwin "$version")
[ -n "$mirror" ] || php_darwin_die 'the release mirror URL is empty'
work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-mirror.XXXXXX")
trap 'rm -rf "$work_dir"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

upload() {
  local name=$1 cache_control=$2
  aws --endpoint-url "$endpoint" s3 cp "$staging/$name" "s3://php-darwin/$tag/$name" \
    --cli-connect-timeout 5 --cli-read-timeout 30 \
    --cache-control "$cache_control" --only-show-errors
}

if [ "$mode" = installer-only ]; then
  # An unchanged, committed mirror manifest proves this exact artifact set was
  # already verified. Refreshing installer code needs no archive transfer.
  curl -fsSL --retry 3 --connect-timeout 5 --max-time 30 "$mirror/$tag-manifest.json" -o "$work_dir/current-manifest"
  cmp -s "$manifest" "$work_dir/current-manifest" || php_darwin_die 'mirror manifest changed before installer refresh'
else
  # Validate every file before mutating either of the public commit points.
  jq -r '.assets[] | [(.download // .name),.sha256,(.bytes|tostring)] | @tsv' "$manifest" > "$work_dir/assets"
  while IFS=$'\t' read -r name hash bytes; do
    [ "$(php_darwin_sha256 "$staging/$name")" = "$hash" ] || php_darwin_die "invalid mirror input: $name"
    [ "$(wc -c < "$staging/$name" | tr -d '[:space:]')" = "$bytes" ] || php_darwin_die "invalid mirror size: $name"
    [ "$(php_darwin_checksum_from_file "$staging/$name.sha256" "$name")" = "$hash" ] || \
      php_darwin_die "invalid mirror checksum: $name"
  done < "$work_dir/assets"
  while IFS=$'\t' read -r name hash bytes; do
    # A public read both verifies the delivered bytes and warms the CDN. Existing
    # immutable objects are reused only after verifying their actual contents.
    if ! curl -fsSL --retry 2 --connect-timeout 5 --max-time 120 "$mirror/$name" -o "$work_dir/archive" 2>/dev/null || \
      [ "$(php_darwin_sha256 "$work_dir/archive")" != "$hash" ]; then
      upload "$name" 'public, max-age=31536000, immutable'
      curl -fsSL --retry 3 --connect-timeout 5 --max-time 120 "$mirror/$name" -o "$work_dir/archive"
      [ "$(php_darwin_sha256 "$work_dir/archive")" = "$hash" ] || php_darwin_die "R2 verification failed: $name"
    fi
    upload "$name.sha256" 'public, max-age=31536000, immutable'
    printf 'Verified R2 archive: %s (%s bytes)\n' "$name" "$bytes"
  done < "$work_dir/assets"
fi
# The installer embeds this manifest. Both are mutable and must be revalidated
# on every request; archives exist and have been verified before either changes.
upload install.sh 'no-cache, max-age=0, must-revalidate'
if [ "$mode" = all ]; then
  upload "$tag-manifest.json" 'no-cache, max-age=0, must-revalidate'
fi
for name in install.sh "$tag-manifest.json"; do
  curl -fsSL --retry 3 --connect-timeout 5 --max-time 30 "$mirror/$name" -o "$work_dir/verified"
  cmp -s "$staging/$name" "$work_dir/verified" || php_darwin_die "R2 verification failed: $name"
done
printf 'Verified R2 release: %s\n' "$tag"
