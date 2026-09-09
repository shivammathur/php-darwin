#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"
work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-download-test.XXXXXX") || exit 1
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

# Exercise curl itself: HTTP retries, a truncated 200 response, and a retired
# immutable URL. No Homebrew state or external service is involved.
ruby -rsocket - "$work_dir" <<'RUBY' &
directory = ARGV.fetch(0)
server = TCPServer.new('127.0.0.1', 0)
File.write("#{directory}/port", server.addr[1].to_s)
counts = Hash.new(0)
loop do
  client = server.accept
  request = client.gets
  next client.close unless request
  route = request.split[1]
  while (line = client.gets) && line != "\r\n"; end
  counts[route] += 1
  File.write("#{directory}/#{route.delete_prefix('/')}count", counts[route].to_s)
  status = if route == '/missing'
    404
  elsif route == '/unavailable' || (route == '/recover' && counts[route] == 1)
    503
  else
    200
  end
  body = "verified fixture\n"
  length = route == '/partial' && counts[route] == 1 ? body.bytesize + 20 : body.bytesize
  client.write("HTTP/1.1 #{status} Fixture\r\nContent-Length: #{length}\r\nConnection: close\r\n\r\n#{body}")
  client.close
end
RUBY
server_pid=$!
for _ in {1..50}; do
  [ ! -s "$work_dir/port" ] || break
  sleep 0.1
done
[ -s "$work_dir/port" ] || php_darwin_die 'download fixture server did not start'
port=$(cat "$work_dir/port") || exit 1
for route in recover partial missing unavailable; do
  status=$(php_darwin_fetch_release_manifest fixture/repo 8.3 "$work_dir/body" \
    "http://127.0.0.1:$port/$route") || php_darwin_die "$route transport failed after retries"
  case "$route" in
    recover|partial) expected_status=200; expected_requests=2 ;;
    missing) expected_status=404; expected_requests=1 ;;
    unavailable) expected_status=503; expected_requests=3 ;;
  esac
  [ "$status" = "$expected_status" ] || php_darwin_die "$route returned HTTP $status"
  [ "$(cat "$work_dir/${route}count")" = "$expected_requests" ] || \
    php_darwin_die "$route made the wrong number of download attempts"
  [ "$(cat "$work_dir/body")" = 'verified fixture' ] || \
    php_darwin_die "$route retained partial data from an earlier attempt"
done
printf 'Bounded cache download retry validation passed\n'
