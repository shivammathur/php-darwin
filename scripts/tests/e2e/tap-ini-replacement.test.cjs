const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { command, digest, extensions, extensionIni } = require('../../installer/install-extensions.cjs');

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'This fixture replaces CI extension installations');
const version = process.env.PHP_VERSION;
assert.equal(version, '7.2');
const names = ['igbinary', 'msgpack', 'imagick', 'memcached', 'mongodb', 'xdebug', 'pcov'];
const php = command('which', ['php']);
const original = digest(fs.readFileSync(fs.realpathSync(php)));
const scan = path.join(command('brew', ['--prefix']), 'etc/php', version, 'conf.d');
function verify() {
  const result = spawnSync(php, ['-r', `
    foreach (${JSON.stringify(names)} as $name) {
      if (!extension_loaded($name)) { throw new Exception($name . ' not loaded'); }
    }
    echo "All seven cached modules load without startup warnings\\n";
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '', 'PHP startup must not emit duplicate-load warnings');
  assert.equal(result.stdout, 'All seven cached modules load without startup warnings\n');
  assert.equal(digest(fs.readFileSync(fs.realpathSync(php))), original);
}
verify();
const ini = command(php, ['-r', 'echo php_ini_loaded_file();']);
assert.doesNotMatch(fs.readFileSync(ini, 'utf8'), /^\s*(?:zend_)?extension\s*=.*(?:xdebug|pcov)\.so/m);
for (const name of names) assert.ok(fs.existsSync(path.join(scan, extensionIni(extensions[name]))));
for (const name of names) {
  const formula = `shivammathur/extensions/${name}@${version}`;
  if (spawnSync('brew', ['list', '--versions', formula]).status === 0) {
    command('brew', ['uninstall', '--force', '--ignore-dependencies', formula], { stdio: ['ignore', 'pipe', 'inherit'] });
  }
  command('brew', ['install', '--skip-link', formula], { stdio: ['ignore', 'pipe', 'inherit'] });
  verify();
  console.log(`Homebrew replaced ${name} without duplicate INI entries`);
}
