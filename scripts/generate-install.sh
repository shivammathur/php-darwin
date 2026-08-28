#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

root=$(cd "$script_dir/.." && pwd)
files="$root/conf/install-files"
template="$root/templates/install.sh"
output="$root/scripts/install.sh"
work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-generate.XXXXXX") || \
  php_darwin_die 'could not create the standalone installer staging directory'
trap 'rm -rf "$work_dir"' EXIT
payload="$work_dir/payload.txt"
archive_files="$work_dir/files.txt"
generated="$work_dir/install.sh"

: > "$archive_files" || php_darwin_die 'could not create the standalone installer input list'
while IFS= read -r relative extra; do
  [ -n "$relative" ] || continue
  case "$relative" in \#*) continue ;; esac
  [ -z "$extra" ] || php_darwin_die "invalid standalone installer input: $relative $extra"
  case "$relative" in scripts/*|conf/*) ;; *) php_darwin_die "unsafe standalone installer input: $relative" ;; esac
  case "$relative" in /*|*'/../'*|../*|*/..|*'//'* )
    php_darwin_die "unsafe standalone installer input: $relative"
    ;;
  esac
  [ -f "$root/$relative" ] || php_darwin_die "standalone installer input is missing: $relative"
  printf '%s\n' "$relative" >> "$archive_files" || php_darwin_die "could not stage $relative"
done < "$files"

tar_command=$(command -v gtar || true)
if [ -z "$tar_command" ] && tar --version 2>/dev/null | grep -Fq 'GNU tar'; then
  tar_command=$(command -v tar)
fi
[ -n "$tar_command" ] || php_darwin_die 'GNU tar is required to generate the standalone installer'
"$tar_command" --format=ustar --owner=0 --group=0 --numeric-owner \
  --mtime='UTC 2020-01-01' --no-recursion -cf - -C "$root" -T "$archive_files" | \
  gzip -9n | base64 > "$payload"
pipeline_status=("${PIPESTATUS[@]}")
[ "${pipeline_status[0]}" -eq 0 ] && [ "${pipeline_status[1]}" -eq 0 ] && \
  [ "${pipeline_status[2]}" -eq 0 ] || php_darwin_die 'could not create the standalone installer payload'
awk -v payload="$payload" '
  $0 == "__PHP_DARWIN_PAYLOAD__" {
    while ((getline line < payload) > 0) print line
    close(payload)
    found=1
    next
  }
  { print }
  END { if (!found) exit 1 }
' "$template" > "$generated" || php_darwin_die 'could not populate the standalone installer template'
chmod 0755 "$generated" || php_darwin_die 'could not make the standalone installer executable'
mv "$generated" "$output" || php_darwin_die 'could not update the standalone installer'
printf 'Generated %s (%s bytes)\n' "$output" "$(wc -c < "$output" | tr -d '[:space:]')"
