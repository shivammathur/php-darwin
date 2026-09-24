const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { prefetch, download, digest, key, validateEntry, safePath, inspectTree, packEnvironment } = require('../../installer/install-extensions.cjs');
const { unchanged, builderHash } = require('../../release/extension-packs.cjs');

const context = { php_version: '8.4', build: 'release', thread_safety: 'nts', architecture: 'arm64' };
function entry(name, content = Buffer.from(name)) {
  const metadata = { ...context, name, schema: 1, sha256: digest(content), inputs_sha256: '1'.repeat(64),
    php_api: '20240924', minimum_macos: 14, bytes: content.length };
  metadata.file = `${key(metadata)}-${metadata.sha256}.tar.zst`;
  return metadata;
}
async function fixture(t, handler) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-unit-'));
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, url: `http://127.0.0.1:${server.address().port}` };
}
test('all requested packs download concurrently, with no unrequested downloads', async t => {
  const names = ['imagick', 'mongodb', 'memcached'];
  const assets = names.map(name => entry(name));
  const pending = [];
  const requested = [];
  const { directory, url } = await fixture(t, (req, res) => {
    requested.push(req.url);
    if (req.url.endsWith('.json')) return res.end(JSON.stringify({ schema: 1, assets }));
    const asset = assets.find(item => req.url === '/' + item.file);
    assert.ok(asset);
    pending.push({ res, name: asset.name });
    // Sequential downloads would deadlock; all three requests must arrive.
    if (pending.length === 3) pending.forEach(item => item.res.end(item.name));
  });
  assert.deepEqual(await prefetch(directory, context, names, { bases: [url] }), names);
  assert.equal(requested.length, 4);
  for (const asset of assets) assert.equal(fs.readFileSync(path.join(directory, asset.file), 'utf8'), asset.name);
});
test('a checksum failure uses the mirror and never promotes corrupt bytes', async t => {
  const content = Buffer.from('good');
  const paths = [];
  const { directory, url } = await fixture(t, (req, res) => { paths.push(req.url); res.end(req.url.startsWith('/primary/') ? 'evil' : content); });
  await download('pack.tar.zst', path.join(directory, 'pack'), { bases: [url + '/primary', url + '/mirror'], sha256: digest(content), bytes: 4 });
  assert.deepEqual(paths, ['/primary/pack.tar.zst', '/mirror/pack.tar.zst']);
  assert.equal(fs.readFileSync(path.join(directory, 'pack'), 'utf8'), 'good');
  assert.ok(!fs.existsSync(path.join(directory, 'pack.partial')));
});
test('a missing pack does not discard successfully downloaded packs', async t => {
  const assets = ['imagick', 'mongodb'].map(name => entry(name));
  const { directory, url } = await fixture(t, (req, res) => {
    if (req.url.endsWith('.json')) return res.end(JSON.stringify({ schema: 1, assets }));
    res.end('imagick');
  });
  assert.deepEqual(await prefetch(directory, context, ['imagick', 'memcached'], { bases: [url] }), ['imagick']);
  assert.ok(fs.existsSync(path.join(directory, 'imagick.json')));
  assert.ok(!fs.existsSync(path.join(directory, 'memcached.json')));
});
test('wrong variants and duplicate manifest entries do not download archives', async t => {
  let requests = 0;
  const assets = [entry('imagick'), entry('imagick'), { ...entry('mongodb'), architecture: 'x86_64' }];
  const { directory, url } = await fixture(t, (_req, res) => { requests++; res.end(JSON.stringify({ schema: 1, assets })); });
  assert.deepEqual(await prefetch(directory, context, ['imagick', 'mongodb'], { bases: [url] }), []);
  assert.equal(requests, 1);
});
test('reject unsupported contexts, unsafe archive paths and invalid identities', () => {
  for (const value of ['../escape', '/absolute', 'a/../../b', 'a//b', 'a\nb', 'a\\b']) assert.equal(safePath(value), false);
  assert.equal(safePath('kegs/library/1.0/LICENSE file'), true);
  for (const patch of [{ name: 'invalid' }, { bytes: -1 }, { sha256: 'bad' }, { php_version: '5.4' },
    { architecture: 'other' }, { php_api: 'wrong' }, { file: '../bad.tar.zst' }]) assert.throws(() => validateEntry({ ...entry('imagick'), ...patch }));
});
test('private runtime symlinks must resolve inside the archive', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-links-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'lib'));
  fs.writeFileSync(path.join(directory, 'lib/a'), 'a');
  fs.symlinkSync('a', path.join(directory, 'lib/b'));
  inspectTree(directory);
  fs.symlinkSync('/etc/passwd', path.join(directory, 'lib/c'));
  assert.throws(() => inspectTree(directory), /Unsafe/);
});
test('only ImageMagick resource paths can be exported by a pack', () => {
  assert.deepEqual(packEnvironment({ environment: { MAGICK_CONFIGURE_PATH: ['kegs/imagemagick/etc'] } }, '/pack'),
    { MAGICK_CONFIGURE_PATH: '/pack/kegs/imagemagick/etc' });
  assert.throws(() => packEnvironment({ environment: { PATH: ['bin'] } }, '/pack'));
  assert.throws(() => packEnvironment({ environment: { MAGICK_CONFIGURE_PATH: ['../escape'] } }, '/pack'));
});
test('freshness tracks dependency recipes, PHP releases and builder changes', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-freshness-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'formula.rb'), 'original');
  const metadata = { ...entry('imagick'), builder_sha256: builderHash(), php_semver: '8.4.26',
    source_records: [{ repository: 'core', path: 'formula.rb', sha256: digest('original') }] };
  const repositories = { core: directory };
  assert.ok(unchanged(metadata, repositories, { php_semver: '8.4.26' }));
  assert.equal(unchanged(metadata, repositories, { php_semver: '8.4.27' }), false);
  assert.equal(unchanged({ ...metadata, builder_sha256: '0'.repeat(64) }, repositories, { php_semver: '8.4.26' }), false);
  fs.writeFileSync(path.join(directory, 'formula.rb'), 'updated dependency');
  assert.equal(unchanged(metadata, repositories, { php_semver: '8.4.26' }), false);
});
