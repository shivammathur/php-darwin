#!/usr/bin/env bash
# The dynamically loaded archive function reads and writes these fixture globals.
# shellcheck disable=SC2034,SC2154
set -euo pipefail
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"
work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-download-test.XXXXXX")
server_pid=
cleanup() {
  [ -z "$server_pid" ] || kill "$server_pid" 2>/dev/null || true
  [ -z "$server_pid" ] || wait "$server_pid" 2>/dev/null || true
  rm -rf "$work_dir"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'verified fixture\n' > "$work_dir/fixture"
expected_hash=$(php_darwin_sha256 "$work_dir/fixture")
version=8.3
release_repository=fixture/repo
asset=$(php_darwin_asset "$version" release nts arm64)
manifest_download_asset=$(php_darwin_download_asset "$asset" "$expected_hash")
archive="$work_dir/archive"
jq -n --arg hash "$expected_hash" --arg asset "$manifest_download_asset" '
  {schema:1,php_version:"8.3",php_semver:"8.3.1",php_src_commit:"",source_hash:$hash,
   extensions_source_hash:$hash,homebrew_extensions_commit:("a"*40),homebrew_php_commit:("a"*40),
   assets:[ ["arm64","x86_64"][] as $arch | ["release","debug"][] as $build | ["nts","zts"][] as $ts |
     ("php_8.3-"+$ts+"-"+$build+"+darwin_"+$arch+".tar.zst") as $name |
     {architecture:$arch,build:$build,thread_safety:$ts,name:$name,sha256:$hash,bytes:17,
      download:($name|sub(".tar.zst$";"."+$hash+".tar.zst")), minimum_macos:(if $arch=="arm64" then 14 else 15 end)}]}
' > "$work_dir/manifest"
php_darwin_validate_release_manifest "$work_dir/manifest" "$version" >/dev/null
# Exercise the actual archive selection function without touching Homebrew.
sed -n '/^php_darwin_download_release_archive() {/,/^}/p' "$script_dir/install-package.sh" > "$work_dir/download.sh"
# shellcheck source=/dev/null
. "$work_dir/download.sh"
php_darwin_start_archive_hash() { actual_hash=$(php_darwin_sha256 "$1"); }
php_darwin_wait_for_archive_hash() { :; }
ruby -rsocket - "$work_dir" <<'RUBY' &
directory = ARGV.fetch(0)
server = TCPServer.new('127.0.0.1', 0)
File.write("#{directory}/port", server.addr[1].to_s)
loop do
  client = server.accept
  Thread.new(client) do |connection|
    begin
      request = connection.gets
      next unless request
      route = request.split[1]
      while (line = connection.gets) && line != "\r\n"; end
      File.open("#{directory}/requests", 'a') { |f| f.puts(route) }
      mode = route.split('/')[1]
      if mode == 'error-stall'
        connection.write("HTTP/1.1 503 Fixture\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\n")
        sleep 5
        next
      end
      if mode == 'trickle'
        connection.write("HTTP/1.1 200 Fixture\r\nContent-Length: 3276800\r\nConnection: close\r\n\r\n")
        200.times { connection.write('x' * 16384); sleep 0.1 }
        next
      end
      sleep 5 if mode == 'stall'
      status = {'missing'=>404,'unavailable'=>503}.fetch(mode, 200)
      body = File.read("#{directory}/#{route.end_with?('manifest.json') ? 'manifest' : 'fixture'}")
      body = 'invalid bytes' if mode == 'corrupt'
      length = mode == 'partial' ? body.bytesize + 20 : body.bytesize
      connection.write("HTTP/1.1 #{status} Fixture\r\nContent-Length: #{length}\r\nConnection: close\r\n\r\n#{body}")
    rescue IOError, SystemCallError
    ensure
      connection.close
    end
  end
end
RUBY
server_pid=$!
for _ in {1..50}; do
  [ ! -s "$work_dir/port" ] || break
  sleep 0.1
done
[ -s "$work_dir/port" ] || php_darwin_die 'download fixture server did not start'
base=http://127.0.0.1:$(cat "$work_dir/port")
export PHP_DARWIN_MIRROR_URL="$base/good"
unset PHP_DARWIN_PREFER_MIRROR
: > "$work_dir/requests"
PHP_DARWIN_RELEASE_URL="$base/good/archive"
php_darwin_download_release_archive || php_darwin_die 'default GitHub download failed'
[ "$(cat "$work_dir/requests")" = /good/archive ] || php_darwin_die 'GitHub was not the default archive origin'
: > "$work_dir/requests"
status=$(php_darwin_fetch_release_manifest "$release_repository" "$version" "$work_dir/body" \
  "$base/good/manifest.json")
[ "$status" = 200 ] || php_darwin_die 'default GitHub manifest download failed'
[ "$(cat "$work_dir/requests")" = /good/manifest.json ] || php_darwin_die 'GitHub was not the default manifest origin'
for route in unavailable missing partial corrupt stall error-stall trickle; do
  PHP_DARWIN_RELEASE_URL="$base/$route/archive"
  : > "$work_dir/requests"
  download_started=$SECONDS
  php_darwin_download_release_archive || php_darwin_die "$route did not recover from the mirror"
  [ "$route" != trickle ] || [ "$((SECONDS - download_started))" -lt 6 ] || \
    php_darwin_die 'a trickling primary origin delayed mirror failover'
  cmp -s "$archive" "$work_dir/fixture" || php_darwin_die "$route retained invalid bytes"
  [ "$(wc -l < "$work_dir/requests" | tr -d ' ')" = 2 ] || php_darwin_die "$route retried the broken origin"
done
# An error response must fail over on its headers, without waiting for its body.
PHP_DARWIN_RELEASE_URL="$base/error-stall/archive"
download_error_started=$(date +%s)
php_darwin_download_release_archive || php_darwin_die 'slow error body did not recover'
[ "$(( $(date +%s) - download_error_started ))" -lt 3 ] || php_darwin_die 'waited for an HTTP error response body'
export PHP_DARWIN_PREFER_MIRROR=true
: > "$work_dir/requests"
PHP_DARWIN_RELEASE_URL="$base/unavailable/archive"
php_darwin_download_release_archive || php_darwin_die 'the healthy bootstrap origin was not reused'
[ "$(wc -l < "$work_dir/requests" | tr -d ' ')" = 1 ] || php_darwin_die 'retried a known failed bootstrap origin'
export PHP_DARWIN_MIRROR_URL="$base/corrupt"
PHP_DARWIN_RELEASE_URL="$base/good/archive"
php_darwin_download_release_archive || php_darwin_die 'preferred mirror did not fall back to GitHub'
export PHP_DARWIN_PREFER_MIRROR=false
export PHP_DARWIN_MIRROR_URL="$base/good"
for route in unavailable missing partial corrupt; do
  status=$(php_darwin_fetch_release_manifest "$release_repository" "$version" "$work_dir/body" \
    "$base/$route/manifest.json")
  [ "$status" = 200 ] || php_darwin_die "$route manifest did not recover"
  cmp -s "$work_dir/body" "$work_dir/manifest" || php_darwin_die 'manifest fallback changed contents'
done
export PHP_DARWIN_MIRROR_URL="$base/missing"
for route in missing unavailable corrupt; do
  PHP_DARWIN_RELEASE_URL="$base/$route/archive"
  if php_darwin_download_release_archive; then php_darwin_die 'accepted failed origins'; fi
  case "$route" in missing) reason=not-found ;; unavailable) reason=download ;; corrupt) reason=checksum ;; esac
  [ "$release_archive_error" = "$reason" ] || php_darwin_die 'lost the original failure reason'
done
export PHP_DARWIN_MIRROR_URL="$base/partial"
status=$(php_darwin_fetch_release_manifest "$release_repository" "$version" "$work_dir/body" \
  "$base/partial/manifest.json")
[ "$status" != 200 ] || php_darwin_die 'a truncated HTTP 200 was reported as a successful manifest download'
export PHP_DARWIN_MIRROR_URL=
PHP_DARWIN_RELEASE_URL="$base/missing/archive"
if php_darwin_download_release_archive; then php_darwin_die 'explicit disabled mirror was ignored'; fi
[ -z "$(php_darwin_release_mirror fixture/repo 8.3)" ] || php_darwin_die 'a fork used production assets'
printf 'Verified archive and manifest failover, HTTP errors, truncation, stalls, checksum rejection, and disabled mirrors\n'
