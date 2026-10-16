const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {older, tapBehind} = require('../../build/stable-version.cjs');
test('stable release ordering rejects downgrades, including prereleases', () => {
  for (const [a, b] of [['8.4.9', '8.4.10'], ['8.4.26', '8.4.27'], ['8.5.0RC1', '8.5.0RC2'],
    ['8.5.0beta9', '8.5.0RC1'], ['8.5.0RC2', '8.5.0'], ['8.5.0alpha2', '8.5.0beta1']]) {
    assert.equal(older(a, b), true); assert.equal(older(b, a), false);
  }
  assert.equal(older('8.4.26', '8.4.26'), false);
  assert.throws(() => older('8.4.27-dev', '8.4.26'));
});
test('a public tap must catch up across all variants before normal builds resume', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'php-tap-version-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const directory = path.join(root, 'Formula'); fs.mkdirSync(directory);
  const write = (suffix, version) => fs.writeFileSync(path.join(directory, `php@8.4${suffix}.rb`), `  url "https://www.php.net/distributions/php-${version}.tar.xz"\n`);
  const manifest = {php_version: '8.4', php_semver: '8.4.27'};
  for (const suffix of ['', '-debug', '-zts', '-debug-zts']) write(suffix, '8.4.27');
  assert.equal(tapBehind(manifest, root), false);
  write('-debug-zts', '8.4.26'); assert.equal(tapBehind(manifest, root), true);
  write('-debug-zts', '8.4.28'); assert.equal(tapBehind(manifest, root), false);
});
