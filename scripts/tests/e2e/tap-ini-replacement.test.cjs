const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { command, digest, extensions, extensionIni } = require('../../installer/install-extensions.cjs');
const {install, extensionInputs} = require('../../cache/source-bottle-cache.cjs');
const {ApprovedDependencies, readLock} = require('../../cache/approved-dependencies.cjs');
const {ReleaseCache} = require('../../cache/source-bottle-releases.cjs');
const {buildGuard} = require('../../cache/dependency-build-guard.cjs');

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'This fixture replaces CI extension installations');
const version = process.env.PHP_VERSION;
assert.equal(version, '7.2');
const names = ['igbinary', 'msgpack', 'imagick', 'memcached', 'mongodb', 'swoole', 'xdebug', 'pcov'];
const php = command('which', ['php']);
const original = digest(fs.readFileSync(fs.realpathSync(php)));
const scan = path.join(command('brew', ['--prefix']), 'etc/php', version, 'conf.d');
function verify() {
  const result = spawnSync(php, ['-r', `
    foreach (${JSON.stringify(names)} as $name) {
      if (!extension_loaded($name)) { throw new Exception($name . ' not loaded'); }
    }
    echo "All cached modules load without startup warnings\\n";
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '', 'PHP startup must not emit duplicate-load warnings');
  assert.equal(result.stdout, 'All cached modules load without startup warnings\n');
  assert.equal(digest(fs.readFileSync(fs.realpathSync(php))), original);
}
verify();
const ini = command(php, ['-r', 'echo php_ini_loaded_file();']);
assert.doesNotMatch(fs.readFileSync(ini, 'utf8'), /^\s*(?:zend_)?extension\s*=.*(?:xdebug|pcov)\.so/m);
for (const name of names) assert.ok(fs.existsSync(path.join(scan, extensionIni(extensions[name]))));
async function replace() {
  const lock = readLock();
  Object.assign(process.env, {HOMEBREW_CORE_COMMIT: lock.core_commit, HOMEBREW_NO_AUTO_UPDATE: '1',
    HOMEBREW_NO_INSTALL_FROM_API: '1', HOMEBREW_NO_AUTOREMOVE: '1'});
  command('bash', ['scripts/build/cleanup-taps.sh'], {stdio: ['ignore', 'pipe', 'inherit']});
  command('bash', ['scripts/build/pin-core.sh'], {stdio: ['ignore', 'pipe', 'inherit']});
  command('brew', ['tap', 'shivammathur/extensions']);
  command('brew', ['trust', 'shivammathur/extensions']);
  const abstract = path.join(command('brew', ['--repository', 'shivammathur/extensions']), 'Abstract/abstract-php-extension.rb');
  const phpPrefix = command('brew', ['--prefix', `shivammathur/php/php@${version}`]);
  const context = extensionInputs(abstract, phpPrefix, 'release', 'nts');
  const cache = new ReleaseCache({readOnly: true});
  const approvedDependencies = new ApprovedDependencies(lock);
  const preparedTargets = [];
  for (const name of names) {
    const formula = `shivammathur/extensions/${name}@${version}`;
    if (spawnSync('brew', ['list', '--versions', formula]).status === 0) {
      command('brew', ['uninstall', '--force', '--ignore-dependencies', formula], { stdio: ['ignore', 'pipe', 'inherit'] });
    }
    const result = await install({formula, context, cache, approvedDependencies, preparedTargets,
      cacheOnly: true, skipLink: true, run: buildGuard()});
    assert.equal(result.built, 0, 'Homebrew replacement must use prepared bottles');
    preparedTargets.push(formula);
    verify();
    console.log(`Homebrew replaced ${name} from a verified bottle without duplicate INI entries`);
  }
}
replace().catch(error => {console.error(error); process.exitCode = 1;});
