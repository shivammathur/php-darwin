const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { archiveDirectories } = require('../native/extension-pack-compatibility.test.cjs');
const { key } = require('../../installer/install-extensions.cjs');

test('compatibility accepts single flattened artifacts and grouped packs without ignoring missing variants', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-compatibility-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const context = { php_version: '8.2', build: 'debug', thread_safety: 'zts', architecture: 'arm64' };
  fs.writeFileSync(path.join(root, `${key({ ...context, name: 'mongodb' })}.json`), '{}');
  const single = path.join(root, `extension-${key({ ...context, name: 'mongodb' })}`);
  fs.writeFileSync(path.join(root, 'validation.txt'), 'original producer report');
  assert.deepEqual(archiveDirectories(root, context, ['mongodb']), [{ name: 'mongodb', output: single }]);
  assert.equal(fs.readFileSync(path.join(single, 'validation.txt'), 'utf8'), 'original producer report');
  assert.throws(() => archiveDirectories(root, { ...context, architecture: 'x86_64' }, ['mongodb']));
  assert.throws(() => archiveDirectories(root, context, ['mongodb', 'imagick']));
  const expected = ['imagick', 'mongodb', 'memcached'].map(name => {
    const output = path.join(root, `extension-${key({ ...context, name })}`);
    fs.mkdirSync(output, { recursive: true });
    return { name, output };
  });
  assert.deepEqual(archiveDirectories(root, context, expected.map(item => item.name)), expected);
});
