const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { prefetch, download, digest, key, validateEntry, validateContext, safePath, inspectTree, packEnvironment, relocateResources, phpApi } = require('../../installer/install-extensions.cjs');
const { unchanged, builderHash, compatibilityMatrix, versionBatches, dispatch } = require('../../release/extension-packs.cjs');
const { copyRuntime } = require('../../build/extension-pack.cjs');

const context = { php_version: '8.4', build: 'release', thread_safety: 'nts', architecture: 'arm64' };
test('scheduled batches cover every configured PHP version within both matrix limits', () => {
  const versions = fs.readFileSync(path.resolve(__dirname, '../../../conf/versions'), 'utf8').split('\n')
    .filter(line => /^(stable|nightly) /.test(line)).map(line => line.split(' ')[1]);
  const batches = versionBatches();
  assert.deepEqual(batches.flat(), versions);
  for (const batch of batches) {
    const entries = batch.flatMap(php_version => ['release', 'debug'].flatMap(build => ['nts', 'zts'].flatMap(thread_safety =>
      ['arm64', 'x86_64'].flatMap(architecture => ['imagick', 'mongodb', 'memcached'].map(name =>
        ({ php_version, build, thread_safety, architecture, name }))))));
    entries.forEach(validateContext);
    assert.ok(entries.length <= 256);
    assert.ok(compatibilityMatrix(entries).include.length <= 256);
  }
  for (const version of ['5.5', '7.5', '8.8', '9.0']) {
    assert.throws(() => versionBatches(version), /Unsupported/);
    assert.throws(() => validateContext({ ...context, php_version: version }), /Unsupported/);
  }
});
test('follow-up batches start only after a successful prerequisite', async () => {
  const calls = [];
  let ready = false;
  const run = (_program, args) => {
    calls.push(args);
    if (args[0] === 'api') return JSON.stringify({ status: ready ? 'completed' : 'in_progress', conclusion: ready ? 'success' : null });
    assert.ok(ready);
  };
  await dispatch({ afterRun: '123', run, wait: async delay => { assert.equal(delay, 60000); ready = true; } });
  assert.equal(calls.filter(args => args[0] === 'workflow').length, 2);
  for (const conclusion of ['failure', 'cancelled', 'timed_out']) {
    await assert.rejects(dispatch({ afterRun: '123', run: (_program, args) => {
      assert.equal(args[0], 'api');
      return JSON.stringify({ status: 'completed', conclusion });
    } }), /Prerequisite run/);
  }
});
test('read the module API from the installed PHP headers using supported php-config options', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-php-api-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'Zend'));
  fs.writeFileSync(path.join(directory, 'Zend/zend_modules.h'), '#define ZEND_MODULE_API_NO 20240924\n');
  const config = path.join(directory, 'php-config');
  fs.writeFileSync(config, '#!/bin/sh\n[ "$1" = --include-dir ] || exit 1\ndirname "$0"\n', { mode: 0o755 });
  assert.equal(phpApi(config), '20240924');
  fs.writeFileSync(path.join(directory, 'Zend/zend_modules.h'), 'invalid');
  assert.throws(() => phpApi(config), /Missing PHP module API/);
});
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
test('only known runtime resource paths can be exported by a pack', () => {
  assert.deepEqual(packEnvironment({ environment: { MAGICK_CONFIGURE_PATH: ['kegs/imagemagick/etc'] } }, '/pack'),
    { MAGICK_CONFIGURE_PATH: '/pack/kegs/imagemagick/etc' });
  assert.throws(() => packEnvironment({ environment: { PATH: ['bin'] } }, '/pack'));
  assert.throws(() => packEnvironment({ environment: { MAGICK_CONFIGURE_PATH: ['../escape'] } }, '/pack'));
  assert.deepEqual(packEnvironment({ environment: { SASL_PATH: ['kegs/cyrus-sasl/lib/sasl2'] } }, '/pack'),
    { SASL_PATH: '/pack/kegs/cyrus-sasl/lib/sasl2' });
});
test('codec descriptors use the installed private runtime directory', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-resources-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'png.la'), "libdir='@PHP_DARWIN_EXTENSION_ROOT@/kegs/imagemagick/lib/coders'\n");
  relocateResources({ relocations: ['png.la'] }, directory, '/private-pack');
  assert.equal(fs.readFileSync(path.join(directory, 'png.la'), 'utf8'), "libdir='/private-pack/kegs/imagemagick/lib/coders'\n");
  assert.throws(() => relocateResources({ relocations: ['../outside.la'] }, directory, '/private-pack'));
  assert.throws(() => relocateResources({ relocations: ['script.sh'] }, directory, '/private-pack'));
});
test('runtime copies retain licenses and codec descriptors without dangling manual-page links', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-runtime-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  const output = path.join(directory, 'output');
  const files = ['share/man/man3/ASN1.3ssl', 'share/doc/NOTICE.txt', 'share/doc/manual.html',
    'lib/libssl.dylib', 'lib/libssl.a', 'lib/libssl.la', 'lib/ImageMagick/modules-Q16/coders/png.la'];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.writeFileSync(path.join(source, file), file);
  }
  fs.symlinkSync('ASN1.3ssl', path.join(source, 'share/man/man3/NOTICEREF_free.3ssl'));
  fs.mkdirSync(path.join(source, 'libexec/gnuman/man1'), { recursive: true });
  fs.symlinkSync('../../../share/man/man3/ASN1.3ssl', path.join(source, 'libexec/gnuman/man1/tool.1'));
  copyRuntime(source, output);
  inspectTree(output);
  assert.ok(fs.existsSync(path.join(output, 'share/doc/NOTICE.txt')));
  assert.ok(fs.existsSync(path.join(output, 'lib/ImageMagick/modules-Q16/coders/png.la')));
  for (const file of ['share/man', 'libexec/gnuman', 'share/doc/manual.html', 'lib/libssl.a', 'lib/libssl.la']) {
    assert.ok(!fs.existsSync(path.join(output, file)));
  }
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
  const nightly = { ...metadata, php_version: '8.7', php_semver: '8.7.0-dev', php_src_commit: 'a'.repeat(40) };
  nightly.file = `${key(nightly)}-${nightly.sha256}.tar.zst`;
  assert.ok(unchanged(nightly, repositories, { php_semver: '8.7.0', php_src_commit: nightly.php_src_commit }));
  assert.equal(unchanged(nightly, repositories, { php_semver: '8.7.0', php_src_commit: 'b'.repeat(40) }), false);
  assert.equal(unchanged({ ...metadata, builder_sha256: '0'.repeat(64) }, repositories, { php_semver: '8.4.26' }), false);
  fs.writeFileSync(path.join(directory, 'formula.rb'), 'updated dependency');
  assert.equal(unchanged(metadata, repositories, { php_semver: '8.4.26' }), false);
});
test('compatibility covers newer hosts and self-hosted Intel while grouping packs per PHP runtime', () => {
  const entries = ['arm64', 'x86_64'].flatMap(architecture => ['imagick', 'mongodb', 'memcached'].map(name =>
    ({ ...context, architecture, name })));
  const { include } = compatibilityMatrix(entries);
  assert.equal(include.length, 5);
  assert.ok(include.some(item => item.runner === 'macos-15-x86_64'));
  assert.ok(include.some(item => item.runner === 'macos-26-intel'));
  for (const item of include) assert.deepEqual(item.packs, ['imagick', 'mongodb', 'memcached']);
});
