const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {test} = require('node:test');

function run(source) {
  return spawnSync('/bin/bash', ['-c', '. "$1"; ' + source, 'test', path.join(__dirname, '../../lib/lib.sh')], {
    encoding: 'utf8'
  });
}

test('installer fallback commands use the API without core and retain pinned checkouts', () => {
  const result = run(`
    directory=$(mktemp -d)
    trap 'rm -rf "$directory"' EXIT
    mkdir -p "$directory/Library/Homebrew"
    brew() { [ "$*" = --repository ] || return 99; printf '%s\\n' "$directory"; }
    export HOMEBREW_NO_INSTALL_FROM_API=1
    php_darwin_configure_homebrew_environment
    [ -z "\${HOMEBREW_NO_INSTALL_FROM_API:-}" ] || exit 1
    [ "$HOMEBREW_NO_AUTO_UPDATE/$HOMEBREW_NO_AUTOREMOVE/$HOMEBREW_NO_INSTALL_CLEANUP/$HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK" = 1/1/1/1 ] || exit 2
    [ ! -e "$directory/Library/Taps/homebrew/homebrew-core" ] || exit 3
    mkdir -p "$directory/Library/Taps/homebrew/homebrew-core"
    php_darwin_configure_homebrew_environment
    [ "$HOMEBREW_NO_INSTALL_FROM_API" = 1 ] || exit 4
  `);
  assert.equal(result.status, 0, result.stderr);
});

for (const original of [false, true]) for (const unexpected of [false, true]) {
  test(`native core fixture restores ${original ? 'existing' : 'absent'} core after ${unexpected ? 'unexpected tap creation' : 'installation'}`, t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-core-layout-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const prefix = path.join(directory, 'brew'), bin = path.join(directory, 'bin');
    const core = path.join(prefix, 'Library/Taps/homebrew/homebrew-core');
    fs.mkdirSync(path.join(prefix, 'Library/Homebrew'), {recursive: true});
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'brew'), '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_PREFIX"\n', {mode: 0o755});
    if (original) {
      fs.mkdirSync(core, {recursive: true});
      fs.writeFileSync(path.join(core, 'original'), 'pinned recipes');
    }
    const invoke = stage => spawnSync('/bin/bash', [path.join(__dirname, '../helpers/core-tap-layout.sh'), stage], {
      encoding: 'utf8', env: {...process.env, PATH: bin + path.delimiter + process.env.PATH,
        GITHUB_ACTIONS: 'true', RUNNER_TEMP: directory, FIXTURE_PREFIX: prefix},
    });
    let result = invoke('prepare');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(core), false);
    if (unexpected) {fs.mkdirSync(core, {recursive: true}); fs.writeFileSync(path.join(core, 'unexpected'), 'new tap');}
    result = invoke('restore');
    assert.equal(result.status, unexpected ? 1 : 0, result.stderr);
    assert.equal(fs.existsSync(core), original);
    if (original) assert.equal(fs.readFileSync(path.join(core, 'original'), 'utf8'), 'pinned recipes');
    assert.equal(fs.existsSync(path.join(core, 'unexpected')), false);
    assert.equal(fs.existsSync(path.join(directory, 'php-darwin-native-core-backup')), false);
    assert.equal(invoke('restore').status, 0);
  });
}

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
