const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

function fixture(t, {corePresent = true, supported = false, mode = 'success', ci = 'true', intel = false} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'php-darwin-test-homebrew-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const prefix = path.join(directory, 'brew');
  const repository = intel ? path.join(prefix, 'Homebrew') : prefix;
  const core = path.join(repository, 'Library/Taps/homebrew/homebrew-core');
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(bin);
  if (corePresent) {
    fs.mkdirSync(core, {recursive: true});
    fs.writeFileSync(path.join(core, 'original'), 'original pinned recipes');
  }
  const ready = path.join(directory, 'supported');
  if (supported) fs.writeFileSync(ready, '');
  const log = path.join(directory, 'brew.log');
  const environment = path.join(directory, 'environment');
  fs.writeFileSync(environment, 'existing environment\n');
  fs.writeFileSync(path.join(bin, 'brew'), `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$FIXTURE_LOG"
case "$1" in
  --prefix) printf '%s\\n' "$FIXTURE_PREFIX";;
  --repository) printf '%s\\n' "$FIXTURE_REPOSITORY";;
  ruby)
    test "$2" = -rformula
    test "$3" = -e
    test "$4" = 'exit(BottleSpecification.method_defined?(:manifest_sha256) ? 0 : 1)'
    test "$HOMEBREW_DEVELOPER" = 1
    test -z "\${HOMEBREW_DISABLE_LOAD_FORMULA:-}"
    test "$HOMEBREW_NO_AUTO_UPDATE" = 1
    test -f "$FIXTURE_READY";;
  update)
    test "$2" = --force
    test "$HOMEBREW_UPDATE_TO_TAG" = 1
    test "$HOMEBREW_DISABLE_LOAD_FORMULA" = 1
    test -z "\${HOMEBREW_NO_INSTALL_FROM_API:-}"
    test "$HOMEBREW_NO_INSTALL_CLEANUP/$HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK" = 1/1
    test ! -e "$FIXTURE_CORE"
    case "$FIXTURE_MODE" in
      fail) echo 'Invalid Homebrew repository' >&2; exit 7;;
      locked) echo 'Another \`brew update\` process is already running.' >&2; exit 7;;
      stale) exit 0;;
      recreate) mkdir -p "$FIXTURE_CORE"; touch "$FIXTURE_CORE/unexpected";;
    esac
    touch "$FIXTURE_READY";;
  *) echo "Unexpected Homebrew operation: $*" >&2; exit 91;;
esac
`, {mode: 0o755});
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  const result = spawnSync('bash', [path.join(__dirname, '../helpers/prepare-homebrew.sh')], {
    encoding: 'utf8', env: {...process.env, PATH: bin + path.delimiter + process.env.PATH,
      GITHUB_ACTIONS: ci, RUNNER_TEMP: directory, GITHUB_ENV: environment,
      HOMEBREW_NO_INSTALL_FROM_API: '1', FIXTURE_PREFIX: prefix, FIXTURE_REPOSITORY: repository,
      FIXTURE_CORE: core, FIXTURE_LOG: log, FIXTURE_READY: ready, FIXTURE_MODE: mode},
  });
  const commands = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  assert.equal(fs.existsSync(core), corePresent, result.stderr);
  if (corePresent) assert.equal(fs.readFileSync(path.join(core, 'original'), 'utf8'), 'original pinned recipes');
  assert.equal(fs.existsSync(path.join(core, 'unexpected')), false);
  assert.equal(fs.readFileSync(environment, 'utf8'), 'existing environment\n');
  assert.equal(fs.readdirSync(directory).some(name => name.startsWith('php-darwin-')), false,
    'prerequisite must leave no layout state for later without-core validation');
  return {result, commands};
}

for (const intel of [false, true]) for (const corePresent of [false, true]) {
  test(`compatible Homebrew skips updates and layout changes (${intel ? 'Intel' : 'ARM'}, core ${corePresent})`, t => {
    const {result, commands} = fixture(t, {intel, corePresent, supported: true});
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(commands.length, 1);
    assert.match(commands[0], /^ruby /);
  });
  test(`old Homebrew updates without fetching core and restores its layout (${intel ? 'Intel' : 'ARM'}, core ${corePresent})`, t => {
    const {result, commands} = fixture(t, {intel, corePresent});
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(commands.filter(command => command === 'update --force').length, 1);
    assert.equal(commands.filter(command => command.startsWith('ruby ')).length, 2);
  });
}

for (const corePresent of [false, true]) for (const [mode, attempts, status] of [
  ['fail', 1, 7], ['locked', 6, 7], ['stale', 1, 1], ['recreate', 1, 1],
]) {
  test(`prerequisite fails closed and restores core after ${mode} (core ${corePresent})`, t => {
    const {result, commands} = fixture(t, {corePresent, mode});
    assert.equal(result.status, status, result.stdout + result.stderr);
    assert.equal(commands.filter(command => command === 'update --force').length, attempts);
    if (mode === 'stale') assert.match(result.stderr, /still cannot load archived bottle manifest checksums/);
    if (mode === 'recreate') assert.match(result.stderr, /unexpectedly created homebrew\/core/);
  });
}

test('test prerequisite refuses to modify a non-Actions computer', t => {
  const {result, commands} = fixture(t, {ci: 'false'});
  assert.equal(result.status, 1);
  assert.deepEqual(commands, []);
});
