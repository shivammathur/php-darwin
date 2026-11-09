const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runSetupPhp } = require('../helpers/run-setup-php.cjs');
const { cleanupBuildDirectory } = require('../helpers/cleanup-build-directory.cjs');
const { command, digest, extensionFormula } = require('../../installer/install-extensions.cjs');

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'This fixture modifies CI extension installations');
const version = process.env['INPUT_PHP-VERSION'];
assert.ok(['8.3', '8.4', '8.5'].includes(version));
const php = command('which', ['php']);
const original = digest(fs.readFileSync(fs.realpathSync(php)));
const include = command('php-config', ['--include-dir']);
for (const [module, header] of [['igbinary', 'igbinary.h'], ['msgpack', 'php_msgpack.h']]) {
  const file = path.join(include, 'ext', module, header);
  assert.match(fs.realpathSync(file), /\/var\/php-darwin\/extensions\/[^/]+\/headers\//);
}

// Prevent a preinstalled extension from turning this into an enable-only test.
const { spawnSync } = require('node:child_process');
for (const module of ['yaml', 'redis']) {
  spawnSync('brew', ['uninstall', '--force', '--ignore-dependencies', `shivammathur/extensions/${extensionFormula(module)}@${version}`],
    { stdio: 'inherit', env: { ...process.env, HOMEBREW_NO_AUTOREMOVE: '1' } });
}
spawnSync('pecl', ['uninstall', 'redis'], { stdio: 'inherit' });
// Unchanged setup-php uses this fixed directory and runs configure/make with
// sudo. Earlier CI runs can leave root-owned .libs entries behind.
const redisSource = '/tmp/redis-6.3.0';
cleanupBuildDirectory(redisSource);
const extensionDirectory = command('php-config', ['--extension-dir']);
// These extensions now have optional packs. Remove their per-module INIs
// before deleting the binaries; otherwise setup-php can mistake a startup
// warning mentioning the missing module for an already loaded extension.
const scan = path.join(command('brew', ['--prefix']), 'etc/php', version, 'conf.d');
for (const file of fs.readdirSync(scan)) {
  if (file.endsWith('.ini') && ['yaml', 'redis'].some(module => file.includes(module))) {
    fs.unlinkSync(path.join(scan, file));
  }
}
// setup-php also keeps a suffixless copy for explicit PECL versions. Remove
// that fixture version so a prior CI job cannot bypass phpize/configure/make.
for (const file of ['redis.so', 'redis-6.3.0', 'yaml.so']) {
  fs.rmSync(path.join(extensionDirectory, file), { force: true });
}
const removed = spawnSync(php, ['-r', "echo json_encode([extension_loaded('yaml'), extension_loaded('redis')]);"], { encoding: 'utf8' });
assert.equal(removed.status, 0, removed.stderr);
assert.equal(removed.stderr, '', 'Removing fixture extensions must not leave PHP startup warnings');
assert.equal(removed.stdout, '[false,false]', 'The downstream fixture must remove YAML and Redis before testing fresh installations');
// Stock setup-php memoizes loaded extensions between invocations in /tmp.
// Invalidate that list after removing modules so the replacement uses Brew.
fs.rmSync(`/tmp/php${version}_extensions`, {force: true});
Object.assign(process.env, { INPUT_EXTENSIONS: 'memcached, yaml, redis-6.3.0', 'INPUT_COVERAGE': 'none',
  'INPUT_TOOLS': 'none', 'INPUT_INI-FILE': 'production', fail_fast: 'true',
  // setup-php may reinstall PHP before processing extensions. Keep its cache
  // request to memcached so that this step actually tests Brew YAML and PECL
  // Redis instead of restoring the YAML pack we deliberately removed above.
  PHP_DARWIN_TEST_EXTENSIONS: 'memcached',
  REDIS_CONFIGURE_OPTS: '--enable-redis-igbinary=yes --enable-redis-msgpack=yes' });
assert.equal(runSetupPhp(process.argv[2]), 0, 'setup-php downstream installation failed');
assert.equal(digest(fs.readFileSync(fs.realpathSync(php))), original, 'Extension installation must not replace cached PHP');
assert.match(command('brew', ['list', '--versions', `shivammathur/extensions/yaml@${version}`]), /yaml@/);
if (version === '8.3') assert.match(command('pecl', ['info', 'redis']), /6\.3\.0/);
else {
  // On PHP 8.4+, setup-php's PECL route uses phpize/make directly so there
  // is no PEAR registry entry. Require a fresh source build with both options.
  const configure = fs.readFileSync('/tmp/redis-6.3.0/config.log', 'utf8');
  assert.match(configure, /--enable-redis-igbinary=yes/);
  assert.match(configure, /--enable-redis-msgpack=yes/);
  assert.ok(fs.statSync('/tmp/redis-6.3.0/modules/redis.so').isFile());
}
console.log(command('php', ['-r', `
  if (phpversion('redis') !== '6.3.0' || yaml_parse("cache: 42")['cache'] !== 42) { exit(1); }
  $r = new Redis(); $value = ['cache' => [42, true, null]];
  foreach ([Redis::SERIALIZER_IGBINARY, Redis::SERIALIZER_MSGPACK] as $serializer) {
    if (!$r->setOption(Redis::OPT_SERIALIZER, $serializer) || $r->_unserialize($r->_serialize($value)) !== $value) { exit(1); }
  }
  echo "Brew YAML, PECL Redis, igbinary and msgpack roundtrips passed\\n";
`]));
