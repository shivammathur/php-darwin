const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync, spawnSync} = require('node:child_process');
const {keyFor} = require('../../cache/source-bottle-cache.cjs');

test('nightly coverage keys follow the pinned PHP source even when its API is unchanged', t => {
  const root = path.resolve(__dirname, '../../..');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-coverage-source-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const tap = path.join(directory, 'extensions');
  const phpTap = path.join(directory, 'php');
  const bin = path.join(directory, 'bin');
  const observed = path.join(directory, 'source.json');
  for (const dir of [path.join(tap, 'Abstract'), path.join(phpTap, 'Formula'), bin]) {
    fs.mkdirSync(dir, {recursive: true});
  }
  fs.writeFileSync(path.join(tap, 'Abstract/abstract-php-extension.rb'), 'class Extension\n' +
    '  depends_on "shivammathur/php/php@#{@php_version}" => [:build, :test]\n' +
    '  def php_formula; "shivammathur/php/php@#{php_version}"; end\n' +
    '  def config_scandir_path; etc / "php" / php_version / "conf.d"; end\n' +
    '  def safe_phpize\n  end\nend\n');
  const git = (...args) => execFileSync('git', ['-C', tap, ...args], {encoding: 'utf8', stdio: 'pipe'}).trim();
  git('init');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '-m', 'Pinned extension fixture');
  git('remote', 'add', 'origin', require('../../../conf/package.json').extension_tap_repository);
  const commit = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\necho Darwin\n', {mode: 0o755});
  fs.writeFileSync(path.join(bin, 'brew'), `#!/bin/sh
case "$1" in
  --prefix) echo "$FIXTURE_PREFIX" ;;
  --repository)
    case "$2" in
      shivammathur/php) echo "$FIXTURE_PHP_TAP" ;;
      shivammathur/extensions) echo "$FIXTURE_TAP" ;;
      *) exit 99 ;;
    esac ;;
  tap|trust|uninstall) exit 0 ;;
  list) exit 1 ;;
  *) exit 99 ;;
esac
`, {mode: 0o755});
  const cacheAction = path.join(directory, 'cache-action.cjs');
  fs.writeFileSync(cacheAction, `require('node:fs').writeFileSync(process.env.FIXTURE_OBSERVED,
    JSON.stringify({source_commit: process.env.PHP_DARWIN_PHP_SRC_COMMIT})); process.exit(1);`);
  function run(version, build, ts, source, mismatch = false) {
    for (const suffix of ['', '-zts', '-debug', '-debug-zts']) {
      const current = mismatch && suffix === '-debug-zts' ? 'c'.repeat(40) : source;
      fs.writeFileSync(path.join(phpTap, `Formula/php@${version}${suffix}.rb`),
        `url "https://github.com/php/php-src/archive/${current}.tar.gz?commit=${current}"\n`);
    }
    fs.rmSync(observed, {force: true});
    const env = {...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: directory,
      PHP_VERSION: version, BUILD: build, TS: ts, EXTENSION_PACK: '', HOMEBREW_EXTENSIONS_COMMIT: commit,
      PHP_DARWIN_SOURCE_CACHE_NODE: process.execPath, PHP_DARWIN_SOURCE_CACHE_ACTION: cacheAction,
      FIXTURE_PREFIX: directory, FIXTURE_TAP: tap, FIXTURE_PHP_TAP: phpTap, FIXTURE_OBSERVED: observed};
    delete env.PHP_DARWIN_PHP_SRC_COMMIT;
    const result = spawnSync('bash', [path.join(root, 'scripts/build/build-extensions.sh')], {encoding: 'utf8', env});
    // The mock deliberately stops at source-cache installation.
    assert.equal(result.status, 1);
    if (mismatch) {
      assert.equal(fs.existsSync(observed), false, 'Mixed nightly sources must not reach the cache');
      assert.match(result.stderr, /formulae do not use the same php-src commit/);
      return;
    }
    assert.ok(fs.existsSync(observed), result.stderr);
    const actual = JSON.parse(fs.readFileSync(observed, 'utf8'));
    assert.equal(actual.source_commit, version === '8.5' ? undefined : source);
    assert.equal(git('status', '--porcelain'), '');
    return keyFor({formula: `shivammathur/extensions/pcov@${version}`, version: '1.0.12_2',
      context: {build, ts, php: {version: `${version}.0-dev`, api: {ZEND_MODULE_API_NO: '20260925'}, ...actual}}});
  }
  for (const version of ['8.6', '8.7']) {
    for (const build of ['release', 'debug']) for (const ts of ['nts', 'zts']) {
      const first = run(version, build, ts, 'a'.repeat(40));
      const second = run(version, build, ts, 'b'.repeat(40));
      assert.notEqual(first, second, `${version} ${build}/${ts} must not reuse a different nightly`);
    }
    run(version, 'release', 'nts', 'a'.repeat(40), true);
  }
  run('8.5', 'release', 'nts', 'a'.repeat(40));
});
