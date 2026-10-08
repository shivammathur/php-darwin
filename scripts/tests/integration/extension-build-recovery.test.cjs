const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

test('extension builds recover a formula patched by an interrupted earlier variant', t => {
  const root = path.resolve(__dirname, '../../..');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-build-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tap = path.join(directory, 'tap');
  const bin = path.join(directory, 'bin');
  const abstract = path.join(tap, 'Abstract/abstract-php-extension.rb');
  const observed = path.join(directory, 'observed.rb');
  fs.mkdirSync(path.dirname(abstract), { recursive: true });
  fs.mkdirSync(bin);
  const template = 'class Extension\n' +
    '  depends_on "shivammathur/php/php@#{@php_version}" => [:build, :test]\n' +
    '  def php_formula; "shivammathur/php/php@#{php_version}"; end\n' +
    '  def config_scandir_path; etc / "php" / php_version / "conf.d"; end\n' +
    '  def safe_phpize\n  end\nend\n';
  fs.writeFileSync(abstract, template);
  const git = (...args) => execFileSync('git', ['-C', tap, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Pinned formula');
  git('remote', 'add', 'origin', require('../../../conf/package.json').extension_tap_repository);
  const commit = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'brew'), `#!/bin/sh
case "$1" in
  --prefix) echo "$FIXTURE_PREFIX" ;;
  --repository) echo "$FIXTURE_TAP" ;;
  tap|trust|uninstall) exit 0 ;;
  list) exit 1 ;;
  install) cp "$FIXTURE_TAP/Abstract/abstract-php-extension.rb" "$FIXTURE_OBSERVED"; exit 1 ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
  for (const [version, build, ts, formula] of [
    ['7.2', 'debug', 'nts', 'php@7.2-debug'],
    ['8.5', 'release', 'nts', 'php'],
    ['8.5', 'debug', 'zts', 'php-debug-zts'],
  ]) {
    // Reproduce a killed producer leaving its PHP 8.4 patch in the tap.
    execFileSync(process.env.PHP_DARWIN_RUBY || 'ruby',
      [path.join(root, 'scripts/build/extension-formula.rb'), abstract, 'php@8.4-debug-zts', '8.4-debug-zts', '8.4']);
    fs.rmSync(observed, { force: true });
    const result = spawnSync('bash', [path.join(root, 'scripts/build/build-extensions.sh')], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: directory, PHP_VERSION: version, BUILD: build, TS: ts, EXTENSION_PACK: 'swoole',
        HOMEBREW_EXTENSIONS_COMMIT: commit, PHP_DARWIN_SOURCE_CACHE_NODE: '',
        FIXTURE_PREFIX: directory, FIXTURE_TAP: tap, FIXTURE_OBSERVED: observed },
    });
    // Stop at the mocked installation, after selecting the new variant.
    assert.equal(result.status, 1);
    assert.ok(fs.existsSync(observed), result.stderr);
    const selected = fs.readFileSync(observed, 'utf8');
    assert.ok(selected.includes(`"shivammathur/php/${formula}"`));
    assert.ok(!selected.includes('8.4-debug-zts'));
    assert.equal(fs.readFileSync(abstract, 'utf8'), template, 'Cleanup restores the pinned formula');
    assert.equal(git('status', '--porcelain'), '');
  }
});
