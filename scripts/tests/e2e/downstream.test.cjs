const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runSetupPhp } = require('../helpers/run-setup-php.cjs');
const { command, digest } = require('../../installer/install-extensions.cjs');

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
spawnSync('brew', ['uninstall', '--force', '--ignore-dependencies', `yaml@${version}`], { stdio: 'inherit' });
spawnSync('pecl', ['uninstall', 'redis'], { stdio: 'inherit' });
fs.rmSync('/tmp/redis-6.3.0', { recursive: true, force: true });
const extensionDirectory = command('php-config', ['--extension-dir']);
for (const module of ['redis', 'yaml']) fs.rmSync(path.join(extensionDirectory, `${module}.so`), { force: true });
Object.assign(process.env, { INPUT_EXTENSIONS: 'memcached, yaml, redis-6.3.0', 'INPUT_COVERAGE': 'none',
  'INPUT_TOOLS': 'none', 'INPUT_INI-FILE': 'production', fail_fast: 'true',
  REDIS_CONFIGURE_OPTS: '--enable-redis-igbinary=yes --enable-redis-msgpack=yes', PHP_DARWIN_TEST_PHASE: 'downstream' });
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
