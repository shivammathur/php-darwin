const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

test('approved replacement can remove obsolete kegs while PHP dependency drift still fails', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'php-dependency-baseline-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const prefix = path.join(root, 'brew'), bin = path.join(root, 'bin');
  const work = path.join(root, 'php-darwin-build');
  for (const dir of [bin, work, path.join(prefix, 'opt/php@8.6/bin')]) fs.mkdirSync(dir, {recursive: true});
  fs.cpSync(path.join(__dirname, '../../../conf'), path.join(root, 'conf'), {recursive: true});
  const platformsFile = path.join(root, 'conf/platforms.json');
  const platforms = JSON.parse(fs.readFileSync(platformsFile));
  platforms.arm64.brew_prefix = prefix;
  fs.writeFileSync(platformsFile, JSON.stringify(platforms));
  const executable = (file, source) => fs.writeFileSync(file, '#!/bin/sh\n' + source, {mode: 0o755});
  executable(path.join(bin, 'uname'), 'case "$1" in -s) echo Darwin;; -m) echo arm64;; *) exit 1;; esac\n');
  executable(path.join(bin, 'brew'), `case "$*" in
    --prefix) printf '%s\\n' "$TEST_PREFIX";;
    'list --formula --versions') cat "$TEST_FORMULAE";;
    unlink*|link*) exit 0;;
    *) echo "Unexpected brew command: $*" >&2; exit 1;;
  esac\n`);
  executable(path.join(prefix, 'opt/php@8.6/bin/php'), 'exit 0\n');
  executable(path.join(prefix, 'opt/php@8.6/bin/php-config'), 'echo 8.6.0\n');
  fs.writeFileSync(path.join(work, 'before.tsv'), 'filesystem baseline\n');
  fs.writeFileSync(path.join(work, 'preserved-formulae.txt'), 'aom\nlibvmaf\n');
  fs.writeFileSync(path.join(work, 'preserved-versions.txt'), 'aom 3.14.1 3.15.1\nlibvmaf 3.2.1 3.2.0\n');
  const formulae = path.join(root, 'formulae');
  fs.writeFileSync(formulae, 'aom 3.15.1\nlibvmaf 3.2.1\nphp@8.6 8.6.0\n');
  const env = {...process.env, PATH: bin + path.delimiter + process.env.PATH,
    PHP_DARWIN_ROOT: root, PHP_DARWIN_ALLOW_LOCAL_BUILD: 'true', RUNNER_TEMP: root,
    TEST_PREFIX: prefix, TEST_FORMULAE: formulae, PHP_VERSION: '8.6', BUILD: 'release', TS: 'nts', ARCH: 'arm64',
    HOMEBREW_PHP_COMMIT: 'a'.repeat(40), HOMEBREW_EXTENSIONS_COMMIT: 'b'.repeat(40)};
  const run = stage => spawnSync('bash', [path.join(__dirname, '../../build/build.sh'), stage], {env, encoding: 'utf8'});
  assert.match(run('finalize').stderr, /changed pinned PHP dependencies/);
  let result = run('snapshot-dependencies');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(work, 'preserved-versions.txt'), 'utf8'), 'aom 3.15.1\nlibvmaf 3.2.1\n');
  result = run('finalize');
  assert.equal(result.status, 0, result.stderr);
  fs.writeFileSync(formulae, 'aom 3.15.1\nlibvmaf 3.2.2\nphp@8.6 8.6.0\n');
  assert.match(run('finalize').stderr, /changed pinned PHP dependencies/);
});
