#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

root=$(cd "$script_dir/.." && pwd)
installer="$root/scripts/install.sh"
files="$root/conf/install-files"
work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-install-validation.XXXXXX") || \
  php_darwin_die 'could not create the standalone installer validation directory'
trap 'rm -rf "$work_dir"' EXIT
payload="$work_dir/payload.txt"
client="$work_dir/client"

awk '
  index($0, "<<'"'"'PHP_DARWIN_CLIENT'"'"'") { reading=1; next }
  reading && $0 == "PHP_DARWIN_CLIENT" { found=1; exit }
  reading { print }
  END { if (!found) exit 1 }
' "$installer" > "$payload" || php_darwin_die 'standalone installer payload markers are invalid'
mkdir -p "$client" || php_darwin_die 'could not create the standalone installer validation payload'
base64_decode=-D
[ "$(uname -s)" = Darwin ] || base64_decode=-d
base64 "$base64_decode" < "$payload" | gzip -dc | tar -xf - -C "$client"
pipeline_status=("${PIPESTATUS[@]}")
[ "${pipeline_status[0]}" -eq 0 ] && [ "${pipeline_status[1]}" -eq 0 ] && \
  [ "${pipeline_status[2]}" -eq 0 ] || php_darwin_die 'standalone installer payload could not be extracted'

expected_count=0
while IFS= read -r relative extra; do
  [ -n "$relative" ] || continue
  case "$relative" in \#*) continue ;; esac
  [ -z "$extra" ] || php_darwin_die "invalid standalone installer input: $relative $extra"
  expected_count=$((expected_count + 1))
  [ -f "$client/$relative" ] || php_darwin_die "standalone installer omitted $relative"
  cmp -s "$root/$relative" "$client/$relative" || \
    php_darwin_die "standalone installer contains a stale copy of $relative"
done < "$files"
actual_count=$(find "$client" -type f | awk 'END { print NR+0 }') || \
  php_darwin_die 'could not count standalone installer files'
[ "$actual_count" -eq "$expected_count" ] || \
  php_darwin_die "standalone installer contains $actual_count files; expected $expected_count"
printf 'Standalone installer payload is current (%s files)\n' "$actual_count"
