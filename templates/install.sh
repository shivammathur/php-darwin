#!/usr/bin/env bash

php_darwin_client=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-client.XXXXXX") || {
  printf 'php-darwin: could not create the standalone installer directory\n' >&2
  exit 1
}

php_darwin_client_cleanup() {
  php_darwin_status=$?
  trap - EXIT
  rm -rf "$php_darwin_client"
  exit "$php_darwin_status"
}
trap php_darwin_client_cleanup EXIT

php_darwin_base64_decode=-D
[ "$(uname -s)" = Darwin ] || php_darwin_base64_decode=-d
base64 "$php_darwin_base64_decode" <<'PHP_DARWIN_CLIENT' | gzip -dc | tar -xf - -C "$php_darwin_client"
__PHP_DARWIN_PAYLOAD__
PHP_DARWIN_CLIENT
php_darwin_pipeline_status=("${PIPESTATUS[@]}")
if [ "${php_darwin_pipeline_status[0]}" -ne 0 ] || \
  [ "${php_darwin_pipeline_status[1]}" -ne 0 ] || \
  [ "${php_darwin_pipeline_status[2]}" -ne 0 ]; then
  printf 'php-darwin: could not unpack the standalone installer\n' >&2
  exit 1
fi

bash "$php_darwin_client/scripts/install-package.sh" "$@"
