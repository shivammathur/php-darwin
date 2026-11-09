const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

for (const original of [false, true]) test(`temporary producer recipes preserve ${original ? 'existing' : 'absent'} core without full history`, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'php-darwin-shallow-core-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const source = path.join(directory, 'source'), prefix = path.join(directory, 'brew');
  const fixture = path.join(directory, 'fixture'), bin = path.join(directory, 'bin');
  const core = path.join(prefix, 'Library/Taps/homebrew/homebrew-core');
  fs.mkdirSync(source); fs.mkdirSync(bin);
  if (original) {
    fs.mkdirSync(core, {recursive: true});
    fs.writeFileSync(path.join(core, 'original'), 'original pinned core');
  }
  const execute = (program, args, env) => {
    const result = spawnSync(program, args, {encoding: 'utf8', env: {...process.env, ...env}});
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim();
  };
  execute('git', ['-C', source, 'init', '-q']);
  for (const value of ['old', 'approved']) {
    fs.writeFileSync(path.join(source, 'recipe'), value);
    execute('git', ['-C', source, 'add', '.']);
    execute('git', ['-C', source, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', value]);
  }
  const commit = execute('git', ['-C', source, 'rev-parse', 'HEAD']);
  execute('git', ['clone', '--depth=1', 'file://' + source, fixture]);
  fs.writeFileSync(path.join(bin, 'brew'), `#!/bin/sh
case "$*" in
  --prefix|--repository) printf '%s\\n' "$FIXTURE_PREFIX";;
  '--repository homebrew/core') printf '%s\\n' "$FIXTURE_CORE";;
  *) echo "Unexpected Homebrew operation: $*" >&2; exit 91;;
esac
`, {mode: 0o755});
  const env = {PATH: bin + path.delimiter + process.env.PATH, GITHUB_ACTIONS: 'true',
    FIXTURE_PREFIX: prefix, FIXTURE_CORE: core, RUNNER_TEMP: directory,
    GITHUB_ENV: path.join(directory, 'env'), HOMEBREW_CORE_COMMIT: commit,
    PHP_DARWIN_CORE_CHECKOUT: core};
  const layout = path.join(__dirname, '../helpers/core-tap-layout.sh');
  execute('bash', [layout, 'prepare'], env);
  execute('bash', [layout, 'fixture', fixture, commit], env);
  execute('bash', [path.join(__dirname, '../../build/pin-core.sh')], env);
  assert.equal(execute('git', ['-C', core, 'rev-parse', '--is-shallow-repository']), 'true');
  assert.equal(execute('git', ['-C', core, 'rev-list', '--count', 'HEAD']), '1');
  assert.equal(fs.readFileSync(path.join(core, 'recipe'), 'utf8'), 'approved');
  execute('bash', [layout, 'restore'], env);
  assert.equal(fs.existsSync(core), original);
  if (original) assert.equal(fs.readFileSync(path.join(core, 'original'), 'utf8'), 'original pinned core');
  assert.equal(fs.existsSync(path.join(core, '.git')), false);
  assert.equal(execute('git', ['-C', fixture, 'rev-parse', '--is-shallow-repository']), 'true');
  assert.ok(fs.readFileSync(env.GITHUB_ENV, 'utf8').endsWith(`PHP_DARWIN_CORE_CHECKOUT=\nPHP_DARWIN_CORE_PREPARED=\nHOMEBREW_NO_INSTALL_FROM_API=${original ? '1' : ''}\n`));
});

test('pinning never creates a missing core tap implicitly', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'php-darwin-missing-core-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const bin = path.join(directory, 'bin'), core = path.join(directory, 'absent');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'brew'), '#!/bin/sh\n[ "$*" = "--repository homebrew/core" ] || exit 91\nprintf "%s\\n" "$FIXTURE_CORE"\n', {mode: 0o755});
  const result = spawnSync('bash', [path.join(__dirname, '../../build/pin-core.sh')], {encoding: 'utf8',
    env: {...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_ACTIONS: 'true',
      HOMEBREW_CORE_COMMIT: 'a'.repeat(40), PHP_DARWIN_CORE_CHECKOUT: '', FIXTURE_CORE: core}});
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Prepare pinned recipes/);
  assert.equal(fs.existsSync(core), false);
});

test('pinning discards modified runner formulae while retaining the local dirty-tree guard', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'php-darwin-pin-core-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const core = path.join(directory, 'core'), bin = path.join(directory, 'bin');
  fs.mkdirSync(core); fs.mkdirSync(bin);
  const git = args => {
    const result = spawnSync('git', ['-C', core, ...args], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q']);
  const formula = path.join(core, 'rustup.rb');
  const commit = value => {
    fs.writeFileSync(formula, value);
    git(['add', '.']);
    git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', value]);
    return git(['rev-parse', 'HEAD']);
  };
  const pinned = commit('approved formula\n');
  const current = commit('runner formula\n');
  fs.writeFileSync(formula, 'runner modification\n');
  const updated = path.join(directory, 'updated');
  fs.writeFileSync(path.join(bin, 'brew'), '#!/bin/sh\ncase "$1" in\n update) test "$HOMEBREW_UPDATE_TO_TAG" = 1 && test "$2" = --force && touch "$PIN_CORE_FIXTURE_UPDATED";;\n tap) exit 0;;\n --repository) printf "%s\\n" "$PIN_CORE_FIXTURE";;\n *) exit 1;;\nesac\n', {mode: 0o755});
  const run = ci => spawnSync('bash', [path.resolve(__dirname, '../../build/pin-core.sh')], {
    encoding: 'utf8', env: {...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      PIN_CORE_FIXTURE: core, PIN_CORE_FIXTURE_UPDATED: updated, HOMEBREW_CORE_COMMIT: pinned, GITHUB_ACTIONS: ci},
  });
  assert.notEqual(run('false').status, 0);
  assert.equal(fs.existsSync(updated), false, 'local pinning must not update Homebrew');
  assert.equal(git(['rev-parse', 'HEAD']), current);
  assert.equal(fs.readFileSync(formula, 'utf8'), 'runner modification\n');
  const result = run('true');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(updated), false, 'pinning must not update Homebrew after recipes are attached');
  assert.equal(git(['rev-parse', 'HEAD']), pinned);
  assert.equal(fs.readFileSync(formula, 'utf8'), 'approved formula\n');
  assert.equal(git(['status', '--porcelain']), '');
});

test('Homebrew update waits through lock and DNS failures, bounds retries, and stops on other errors', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'php-darwin-update-lock-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const bin = path.join(directory, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'brew'), `#!/bin/sh
count=0
if [ -f "$UPDATE_FIXTURE_COUNT" ]; then count=$(cat "$UPDATE_FIXTURE_COUNT"); fi
count=$((count + 1)); printf '%s' "$count" > "$UPDATE_FIXTURE_COUNT"
if [ "$UPDATE_FIXTURE_MODE" = recover ] && [ "$count" -ge 3 ]; then exit 0; fi
case "$UPDATE_FIXTURE_MODE" in
  recover|locked) echo 'Another \`brew update\` process is already running.' >&2;;
  dns) echo 'Could not resolve host: github.com' >&2;;
  *) echo 'Invalid Homebrew repository' >&2;;
esac
exit 7
`, {mode: 0o755});
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  for (const [mode, attempts, status] of [['recover', 3, 0], ['locked', 6, 7], ['dns', 6, 7], ['invalid', 1, 7]]) {
    const count = path.join(directory, mode);
    const result = spawnSync('bash', [path.resolve(__dirname, '../../build/update-homebrew.sh')], {
      encoding: 'utf8', env: {...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        GITHUB_ACTIONS: 'true', UPDATE_FIXTURE_COUNT: count, UPDATE_FIXTURE_MODE: mode},
    });
    assert.equal(result.status, status, result.stdout + result.stderr);
    assert.equal(Number(fs.readFileSync(count, 'utf8')), attempts);
  }
});
