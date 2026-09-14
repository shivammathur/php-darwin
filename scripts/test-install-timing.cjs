const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const {test} = require('node:test');

function run(source, env = {}) {
  return spawnSync('/bin/bash', ['-c', '. "$1"; ' + source, 'test', path.join(__dirname, 'lib.sh')], {
    encoding: 'utf8', env: {...process.env, verbose: '', VERBOSE: '', SETUP_PHP_TRACE: '0', PHP_DARWIN_TIMING: '', ...env}
  });
}

test('normal installs never read the clock or emit timings, and preserve command results', () => {
  const result = run(`
    php_darwin_timing_now() { echo 'unexpected clock read' >&2; return 99; }
    php_darwin_timing_init
    php_darwin_set_phase input
    operation() { printf payload; return 23; }
    output=$(php_darwin_timed fixture operation); status=$?
    php_darwin_timing_finish "$status"
    printf '%s' "$output"
    exit "$status"
  `);
  assert.equal(result.status, 23);
  assert.equal(result.stdout, 'payload');
  assert.equal(result.stderr, '');
});

test('vvv reports phases and parallel operations without changing stdout or failure status', () => {
  const result = run(`
    php_darwin_timing_init
    php_darwin_set_phase input
    directory=$(mktemp -d)
    export PHP_DARWIN_TIMING_LOG="$directory/timings"
    operation() { printf payload; return 23; }
    php_darwin_timed background operation > "$directory/output" 2>/dev/null &
    pid=$!
    php_darwin_set_phase wait
    wait "$pid"; status=$?
    cat "$directory/output"
    php_darwin_timing_finish "$status"
    rm -rf "$directory"
    exit "$status"
  `, {verbose: 'vvv'});
  assert.equal(result.status, 23, result.stderr);
  assert.equal(result.stdout, 'payload');
  for (const [scope, name, status] of [['phase', 'input', 0], ['operation', 'background', 23], ['phase', 'wait', 23], ['total', 'installer', 23]]) {
    assert.match(result.stderr, new RegExp(`scope=${scope} name=${name} start_ms=\\d+ elapsed_ms=\\d+ status=${status}`));
  }
  assert.equal((result.stderr.match(/scope=total/g) || []).length, 1);
});

test('setup-php trace level enables timings; an unavailable clock does not fail the install', () => {
  let result = run('php_darwin_timing_init; php_darwin_set_phase input; php_darwin_timing_finish 0', {SETUP_PHP_TRACE: '2'});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /scope=total name=installer/);
  result = run('php_darwin_timing_now() { return 1; }; php_darwin_timing_init; php_darwin_timed fixture printf ok', {SETUP_PHP_TRACE: '2'});
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'ok');
  assert.equal(result.stderr, '');
});

test('tap lookup uses the fast Homebrew root command and retains custom-layout fallback', () => {
  const result = run(`
    directory=$(mktemp -d)
    mkdir -p "$directory/Library/Homebrew"
    brew() {
      if [ "$#" -eq 1 ]; then printf '%s\\n' "$directory"; else printf 'native-tap-path\\n'; fi
    }
    result=$(php_darwin_tap_repository_path example/homebrew-tools)
    [ "$result" = "$directory/Library/Taps/example/homebrew-tools" ] || exit 1
    rmdir "$directory/Library/Homebrew"
    [ "$(php_darwin_tap_repository_path example/tools)" = native-tap-path ] || exit 2
    [ "$(php_darwin_tap_repository_path Example/Tools)" = native-tap-path ] || exit 3
    rm -rf "$directory"
  `);
  assert.equal(result.status, 0, result.stderr);
});

test('runtime selection probes installed portable Ruby and falls back without downloading', () => {
  const result = run(`
    directory=$(mktemp -d)
    brew() { [ "$*" = --repository ] || return 99; printf '%s\\n' "$directory"; }
    candidate="$directory/Library/Homebrew/vendor/portable-ruby/current/bin/ruby"
    mkdir -p "$(dirname "$candidate")"
    printf '#!/bin/sh\\nexit 0\\n' > "$candidate"
    chmod +x "$candidate"
    php_darwin_select_ruby
    [ "$PHP_DARWIN_RUBY" = "$candidate" ] || exit 1
    printf '#!/bin/sh\\nexit 1\\n' > "$candidate"
    php_darwin_select_ruby
    [ "$PHP_DARWIN_RUBY" = /usr/bin/ruby ] || exit 2
    rm "$candidate"
    php_darwin_select_ruby
    [ "$PHP_DARWIN_RUBY" = /usr/bin/ruby ] || exit 3
    rm -rf "$directory"
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
