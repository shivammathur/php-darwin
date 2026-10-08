const { test } = require('node:test');
const assert = require('node:assert/strict');
const { releaseForFormula, productionRelease } = require('../../cache/source-cache-layout.cjs');
const { releaseAsset } = require('../../cache/source-bottle-releases.cjs');
const { keyFor } = require('../../cache/source-bottle-cache.cjs');
const mirror = require('../../cache/source-bottle-mirror.cjs');

test('named releases group PHP and extensions while retaining versioned core dependencies', () => {
  for (const formula of ['php', 'php@8.3', 'php-debug', 'php-debug-zts', 'shivammathur/php-zts/php@5.6-zts']) {
    assert.equal(releaseForFormula(formula), 'cache-php');
  }
  for (const name of ['imagick', 'mongodb', 'memcached', 'igbinary', 'msgpack', 'pcov', 'xdebug', 'swoole']) {
    for (const php of ['5.6', '7.4', '8.7']) assert.equal(releaseForFormula(`shivammathur/extensions/${name}@${php}`), `cache-${name}`);
    assert.equal(productionRelease(`cache-${name}`), true);
  }
  for (const formula of ['imagemagick', 'openssl@3', 'bison@2.7', 'libxml2', 'xz']) {
    assert.equal(releaseForFormula(formula), 'cache');
  }
  for (const tag of ['cache-locks', 'cache-source-a7', 'php-8.5', 'cache-../php']) assert.equal(productionRelease(tag), false);
});

test('source bottle mirror identity survives release placement and rejects the wrong family', () => {
  const inputs = { formula: 'shivammathur/extensions/imagick@5.6', version: '3.8.1',
    environment: { arch: 'arm64', macos: '14', prefix: '/opt/homebrew' }, context: { build: 'debug', ts: 'zts' } };
  const asset = { ...releaseAsset({ key: keyFor(inputs), inputs }), id: 1, state: 'uploaded',
    digest: `sha256:${'a'.repeat(64)}`, size: 512 };
  const record = mirror.record(asset, 'shivammathur/php-darwin', 'cache-imagick');
  assert.equal(mirror.key(record), mirror.key(mirror.record(asset)));
  assert.equal(mirror.record(asset, 'shivammathur/php-darwin', 'cache-mongodb'), undefined);
});
