const { fixture: r2Fixture } = require('../helpers/r2-fixture.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { prefetch, download, digest, key, validateEntry, validateContext, safePath, inspectTree, packEnvironment, relocateResources, phpApi, prepareArchive, movePrepared, runtimeContext } = require('../../installer/install-extensions.cjs');
const { copyRuntime, copyHeaders } = require('../../build/extension-pack.cjs');

const context = { php_version: '8.4', build: 'release', thread_safety: 'nts', architecture: 'arm64' };
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
    php_api: '20240924', php_semver: '8.4.26', minimum_macos: 14, bytes: content.length };
  metadata.file = `${key(metadata)}-${metadata.sha256}.tar.zst`;
  return metadata;
}

test('extension context uses php-config for version and variant without starting PHP', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'php-config-context-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const config = path.join(directory, 'php-config');
  fs.mkdirSync(path.join(directory, 'Zend'));
  fs.writeFileSync(path.join(directory, 'Zend/zend_modules.h'), '#define ZEND_MODULE_API_NO 20260925\n');
  for (const version of ['8.7.0-dev', '8.7.0alpha1', '8.7.0beta2', '8.7.0RC1', '8.7.0']) for (const flags of ['', '--enable-debug', '--enable-zts', '--enable-debug --enable-maintainer-zts']) {
    fs.writeFileSync(config, `#!/bin/sh\ncase "$1" in\n--version) echo ${version};;\n--include-dir) dirname "$0";;\n--extension-dir) echo /opt/homebrew/lib/php/pecl;;\n--configure-options) echo "${flags}";;\n*) exit 1;;\nesac\n`, {mode: 0o755});
    const context = runtimeContext(config, '/must/not/run/php');
    assert.equal(context.php_version, '8.7');
    assert.equal(context.build, flags.includes('debug') ? 'debug' : 'release');
    assert.equal(context.thread_safety, flags.includes('zts') ? 'zts' : 'nts');
  }
});
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

test('retired archives refresh the manifest once and install the replacement with its own digest', async t => {
  const old = entry('imagick', Buffer.from('old')), next = entry('imagick', Buffer.from('new'));
  let refreshed = 0, oldReads = 0;
  const {directory, url} = await fixture(t, (req, res) => {
    if (req.url.startsWith('/extensions-8.4-manifest.json')) {
      const fresh = req.url.includes('?refresh=');
      if (fresh) refreshed++;
      return res.end(JSON.stringify({schema: 1, assets: [fresh ? next : old]}));
    }
    if (req.url === '/' + old.file) {oldReads++; res.writeHead(404); return res.end();}
    if (req.url === '/' + next.file) return res.end('new');
    res.writeHead(404); res.end();
  });
  assert.deepEqual(await prefetch(directory, context, ['imagick'], {bases: [url], prepare: async () => {}}), ['imagick']);
  assert.equal(refreshed, 1); assert.equal(oldReads, 3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'imagick.json'))).sha256, next.sha256);
  assert.equal(fs.readFileSync(path.join(directory, next.file), 'utf8'), 'new');
});
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
  const prepared = [];
  assert.deepEqual(await prefetch(directory, context, names, { bases: [url], prepare: async (root, name) => {
    assert.equal(root, directory);
    prepared.push(name);
    await new Promise(resolve => setImmediate(resolve));
  } }), names);
  assert.deepEqual(prepared.sort(), names.sort());
  assert.equal(requested.length, 4);
  for (const asset of assets) assert.equal(fs.readFileSync(path.join(directory, asset.file), 'utf8'), asset.name);
});
test('healthy extension downloads can take longer than three seconds without failing over', async t => {
  const paths = [];
  const { directory, url } = await fixture(t, (req, res) => {
    paths.push(req.url);
    res.write('go');
    setTimeout(() => res.end('od'), 4000);
  });
  await Promise.all(['manifest.json', 'pack.tar.zst'].map(async name => {
    const destination = path.join(directory, name);
    await download(name, destination, { bases: [url + '/primary', url + '/mirror'],
      sha256: digest('good'), ...(name.endsWith('.zst') ? { bytes: 4 } : {}) });
    assert.equal(fs.readFileSync(destination, 'utf8'), 'good');
    assert.ok(!fs.existsSync(`${destination}.partial`));
  }));
  assert.deepEqual(paths.sort(), ['/primary/manifest.json', '/primary/pack.tar.zst']);
});
test('a checksum failure uses the mirror and never promotes corrupt bytes', async t => {
  const content = Buffer.from('good');
  const paths = [];
  const { directory, url } = await fixture(t, (req, res) => { paths.push(req.url); res.end(req.url.startsWith('/primary/') ? 'evil' : content); });
  await download('pack.tar.zst', path.join(directory, 'pack'), { bases: [url + '/primary', url + '/mirror'], sha256: digest(content), bytes: 4 });
  assert.deepEqual(paths, ['/primary/pack.tar.zst', '/primary/pack.tar.zst', '/primary/pack.tar.zst', '/mirror/pack.tar.zst']);
  assert.equal(fs.readFileSync(path.join(directory, 'pack'), 'utf8'), 'good');
  assert.ok(!fs.existsSync(path.join(directory, 'pack.partial')));
});
test('a missing pack does not discard successfully downloaded packs', async t => {
  const assets = ['imagick', 'mongodb'].map(name => entry(name));
  const { directory, url } = await fixture(t, (req, res) => {
    if (req.url.endsWith('.json')) return res.end(JSON.stringify({ schema: 1, assets }));
    res.end('imagick');
  });
  assert.deepEqual(await prefetch(directory, context, ['imagick', 'memcached'], { bases: [url], prepare: async () => {} }), ['imagick']);
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
test('failed preparation leaves other downloaded packs available without retrying', async t => {
  const names = ['imagick', 'mongodb'];
  const assets = names.map(name => entry(name));
  const { directory, url } = await fixture(t, (req, res) => {
    if (req.url.endsWith('.json')) return res.end(JSON.stringify({ schema: 1, assets }));
    res.end(assets.find(item => req.url === '/' + item.file).name);
  });
  const calls = [];
  assert.deepEqual(await prefetch(directory, context, names, { bases: [url], prepare: async (_root, name) => {
    calls.push(name);
    if (name === 'mongodb') throw new Error('fixture extraction failed');
  } }), ['imagick']);
  assert.deepEqual(calls.sort(), names.sort());
  assert.ok(fs.existsSync(path.join(directory, 'imagick.json')));
  assert.ok(!fs.existsSync(path.join(directory, 'mongodb.json')));
});
test('preparation verifies archives and metadata without running PHP or writing the Homebrew prefix', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-prepare-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  fs.mkdirSync(path.join(source, 'modules'), { recursive: true });
  const metadata = { ...entry('imagick'), modules: ['imagick'], relocations: [], environment: {} };
  fs.writeFileSync(path.join(source, 'metadata.json'), JSON.stringify(metadata));
  fs.writeFileSync(path.join(source, 'modules/imagick.so'), 'native module fixture');
  const archive = path.join(directory, 'fixture.tar.zst');
  execFileSync('tar', ['--zstd', '-cf', archive, '-C', source, 'metadata.json', 'modules']);
  const record = { ...metadata, ...entry('imagick', fs.readFileSync(archive)) };
  fs.renameSync(archive, path.join(directory, record.file));
  fs.writeFileSync(path.join(directory, 'imagick.json'), JSON.stringify(record));
  const stage = prepareArchive(directory, 'imagick');
  assert.equal(stage, path.join(directory, `imagick-${record.sha256}.stage`));
  assert.equal(fs.readFileSync(path.join(stage, 'modules/imagick.so'), 'utf8'), 'native module fixture');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stage, 'metadata.json'))), metadata);
  assert.equal(fs.readdirSync(directory).filter(name => name.startsWith('.prepare-')).length, 0);
  const bytes = fs.readFileSync(path.join(directory, record.file));
  const served = await fixture(t, (req, res) => {
    res.end(req.url.endsWith('.json') ? JSON.stringify({ schema: 1, assets: [record] }) : bytes);
  });
  assert.deepEqual(await prefetch(served.directory, context, ['imagick'], { bases: [served.url] }), ['imagick']);
  assert.equal(fs.readFileSync(path.join(served.directory, `imagick-${record.sha256}.stage/modules/imagick.so`), 'utf8'), 'native module fixture');
  fs.rmSync(stage, { recursive: true });
  fs.writeFileSync(path.join(directory, record.file), 'corrupt');
  assert.throws(() => prepareArchive(directory, 'imagick'), /changed after download/);
  assert.ok(!fs.existsSync(stage));
});
test('prepared packs move atomically when the temporary directory is on another volume', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-move-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stage = path.join(directory, 'stage'), destination = path.join(directory, 'installed');
  fs.mkdirSync(stage);
  fs.writeFileSync(path.join(stage, 'module'), 'native module');
  fs.symlinkSync('module', path.join(stage, 'alias'));
  const rename = fs.renameSync;
  const moves = [];
  t.mock.method(fs, 'renameSync', (from, to) => {
    moves.push([from, to]);
    if (from === stage) throw Object.assign(new Error('other volume'), { code: 'EXDEV' });
    assert.equal(fs.readFileSync(path.join(from, 'module'), 'utf8'), 'native module');
    assert.equal(fs.readlinkSync(path.join(from, 'alias')), 'module');
    return rename(from, to);
  });
  movePrepared(stage, destination);
  assert.equal(moves.length, 2);
  assert.equal(fs.readFileSync(path.join(destination, 'alias'), 'utf8'), 'native module');
  assert.ok(!fs.readdirSync(directory).some(name => name.startsWith('.install-')));
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

