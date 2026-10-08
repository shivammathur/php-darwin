const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { selectRequested, validateBase, activate, digest, key } = require('../../installer/install-extensions.cjs');
const context = { php_version: '8.6', php_semver: '8.6.0', php_src_commit: 'a'.repeat(40),
  architecture: 'arm64', build: 'release', thread_safety: 'nts' };
function entry(name, patch = {}) {
  const value = { ...context, name, schema: 1, php_semver: '8.6.0-dev', php_api: '20260924',
    inputs_sha256: 'b'.repeat(64), sha256: digest(name), bytes: name.length, minimum_macos: 14, ...patch };
  return { ...value, file: `${key(value)}-${value.sha256}.tar.zst` };
}
function directory(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'extension-orchestration-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('raw extension selection respects disabling, versions, sources and serializer constraints', () => {
  assert.deepEqual(selectRequested(' PHP-imagick, mongodb, MEMCACHED, PHP_swoole, imagick, redis'), ['imagick', 'mongodb', 'memcached', 'swoole']);
  assert.deepEqual(selectRequested('none,imagick,memcached'), ['imagick', 'memcached']);
  for (const input of ['', 'none', 'redis', 'imagick-3.8.1', 'imagick-beta', 'imagick-user/repo@main', ':imagick',
    'imagick,:imagick', 'imagick,:PHP-imagick', 'imagick,imagick-3.8.1', 'memcached,igbinary-3.2.16',
    'memcached,:msgpack', 'memcached,memcached@other', 'imagick; touch /tmp/unsafe',
    ':swoole', 'swoole,:swoole', 'swoole,swoole-6.2.3', 'swoole,swoole@source']) {
    assert.deepEqual(selectRequested(input), [], input);
  }
});
test('base matching requires exact release, source and all variants before installation', () => {
  validateBase(entry('imagick'), context);
  for (const change of [{ php_src_commit: 'c'.repeat(40) }, { php_src_commit: '' }, { php_semver: '8.6.1' },
    { php_semver: '' }, { architecture: 'x86_64' }, { thread_safety: 'zts' }, { build: 'debug' }, { php_version: '8.7' }]) {
    assert.throws(() => validateBase(entry('imagick'), { ...context, ...change }), /does not match/);
  }
});
test('installation overlaps independent packs, waits before enabling and retains successes on a missing pack', async t => {
  const root = directory(t), names = ['imagick', 'mongodb', 'memcached'];
  fs.writeFileSync(path.join(root, 'requested.txt'), names.join('\n'));
  for (const name of names.slice(0, 2)) fs.writeFileSync(path.join(root, `${name}.json`), JSON.stringify(entry(name)));
  const started = [], completed = [], enabled = [], pending = [];
  const result = await activate(root, context, '/opt/homebrew/etc/php/8.6/conf.d', {
    installPack: async (where, name) => {
      assert.equal(where, root); started.push(name);
      await new Promise(resolve => {
        pending.push(resolve);
        if (pending.length === 2) pending.forEach(done => done());
      });
      completed.push(name);
    },
    enablePack: async (_where, name) => {
      assert.equal(completed.length, 2);
      enabled.push(name);
    }
  });
  assert.deepEqual(result, ['imagick', 'mongodb']);
  assert.deepEqual(started, result);
  assert.deepEqual(enabled, result);
});
test('stale packs and invalid config paths never run an installer; one enabling failure does not discard others', async t => {
  const root = directory(t);
  fs.writeFileSync(path.join(root, 'requested.txt'), 'imagick\nmongodb\nmemcached');
  for (const name of ['imagick', 'mongodb', 'memcached']) {
    fs.writeFileSync(path.join(root, `${name}.json`), JSON.stringify({ ...entry(name), ...(name === 'mongodb' ? { php_src_commit: '0'.repeat(40) } : {}) }));
  }
  const calls = [];
  const options = { installPack: async (_, name) => calls.push(name), enablePack: async (_, name) => {
    if (name === 'imagick') throw new Error('Cannot configure imagick');
  } };
  await assert.rejects(activate(root, context, '/opt/homebrew/etc/php/8.7/conf.d', options), /configuration directory/);
  assert.deepEqual(calls, []);
  assert.deepEqual(await activate(root, context, '/opt/homebrew/etc/php/8.6/conf.d', options), ['memcached']);
  assert.deepEqual(calls, ['imagick', 'memcached']);
});
test('downloads retry all transfer and verification errors on both origins, caps Retry-After and never promotes a partial file', async t => {
  const { download } = require('../../installer/install-extensions.cjs');
  const root = directory(t), file = path.join(root, 'pack');
  let status = 524, calls = 0;
  const waits = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls++;
    if (url.startsWith('https://primary/')) return new Response('', { status: 404 });
    if (status === 524 && calls === 6) return new Response('good');
    return new Response(status === 200 ? 'evil' : '', { status, headers: { 'retry-after': '999' } });
  });
  const options = { bases: ['https://primary', 'https://mirror'], bytes: 4, sha256: digest('good'), sleep: async ms => waits.push(ms) };
  await download('pack', file, options);
  assert.equal(fs.readFileSync(file, 'utf8'), 'good');
  assert.deepEqual(waits, [1000, 2000, 30000, 30000]);
  assert.equal(calls, 6);
  for (const failure of [403, 200, 503]) {
    fs.rmSync(file); calls = 0; waits.length = 0; status = failure;
    await assert.rejects(download('pack', file, options));
    assert.equal(calls, 6);
    assert.ok(!fs.existsSync(file));
    assert.ok(!fs.existsSync(file + '.partial'));
    fs.writeFileSync(file, 'reset');
  }
});
function activationFixture(t, name = 'memcached') {
  const { enableInstalled, packs } = require('../../installer/install-extensions.cjs');
  const root = directory(t), scan = path.join(root, 'conf.d');
  const metadata = { ...entry(name, name === 'swoole' ? { php_version: '8.5' } : {}), environment: {} };
  const destination = `/opt/homebrew/var/php-darwin/extensions/${metadata.sha256}`;
  fs.mkdirSync(scan);
  fs.writeFileSync(path.join(scan, 'user.ini'), '; retain user settings\n');
  fs.writeFileSync(path.join(root, `${name}.json`), JSON.stringify(metadata));
  const realpath = fs.realpathSync, read = fs.readFileSync;
  t.mock.method(fs, 'realpathSync', file => file === destination ? file : realpath(file));
  t.mock.method(fs, 'readFileSync', (file, ...args) => file === path.join(destination, 'metadata.json') ? JSON.stringify(metadata) : read(file, ...args));
  const php = path.join(root, 'php');
  // Model PHP's sorted scan and reject duplicate modules and serializer order
  // errors, including when the tap replaces only one module of a pack.
  fs.writeFileSync(php, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const loaded = [];
for (const file of fs.readdirSync(${JSON.stringify(scan)}).filter(file => file.endsWith('.ini')).sort()) {
  const ini = fs.readFileSync(path.join(${JSON.stringify(scan)}, file), 'utf8');
  for (const match of ini.matchAll(/^(?:zend_)?extension\\s*=\\s*"?([^"\\n]+)"?$/gm)) {
    const name = path.basename(match[1], '.so');
    if (loaded.includes(name)) throw new Error(name + ' already loaded');
    if (name === 'memcached' && !['igbinary', 'msgpack'].every(module => loaded.includes(module))) throw new Error('Missing serializers');
    loaded.push(name);
  }
}
if (process.argv[3].includes('get_loaded_extensions')) process.stdout.write(JSON.stringify(loaded));
else {
  const required = [...process.argv[3].matchAll(/extension_loaded\\('([^']+)'\\)/g)].map(match => match[1]);
  if (!(required.length ? required : ${JSON.stringify(packs[name])}).every(module => loaded.includes(module))) process.exit(2);
  if (fs.existsSync(${JSON.stringify(path.join(root, 'fail'))})) process.exit(3);
}
`, { mode: 0o755 });
  return { root, scan, php, modules: packs[name],
    legacy: path.join(scan, `zz-php-darwin-${name}.ini`),
    activate: () => enableInstalled(root, name, scan, { php, environmentFile: '' }),
    snapshot: () => Object.fromEntries(fs.readdirSync(scan).sort().map(file => [file, read(path.join(scan, file), 'utf8')])) };
}
const marker = '; Managed by php-darwin optional extension installer\n';
test('configured priorities drive activation and remain available outside the checkout', t => {
  const { extensions, extensionIni, standaloneSource, command } = require('../../installer/install-extensions.cjs');
  const f = activationFixture(t, 'imagick');
  t.after(() => { delete extensions.imagick.priority; });
  extensions.imagick.priority = 25;
  f.activate();
  assert.ok(fs.existsSync(path.join(f.scan, '25-imagick.ini')));
  assert.ok(!fs.existsSync(path.join(f.scan, '20-imagick.ini')));
  const standalone = path.join(f.root, 'install-extensions.cjs');
  fs.writeFileSync(standalone, standaloneSource());
  const actual = command(process.execPath, ['-e',
    'const {extensions,extensionIni}=require(process.argv[1]); console.log(extensionIni(extensions.imagick));', standalone]);
  assert.equal(actual, '25-imagick.ini');
  command(process.execPath, [standalone, 'select', f.root, 'imagick,memcached,swoole']);
  assert.equal(fs.readFileSync(path.join(f.root, 'requested.txt'), 'utf8'), 'imagick\nmemcached\nswoole');
  assert.equal(command(process.execPath, ['-e',
    'const {supportsPack}=require(process.argv[1]); console.log(["8.5","8.6","8.7"].map(version=>supportsPack("swoole",version)).join(","));', standalone]),
  'true,false,false');
  for (const priority of [-1, 100, 1.5, '30', null]) {
    assert.throws(() => extensionIni({ name: 'imagick', priority }), /Invalid extension INI/);
  }
});
for (const name of ['imagick', 'mongodb', 'memcached', 'swoole']) {
  test(`${name} uses tap INI filenames and survives repeated activation and individual tap replacements`, t => {
    const f = activationFixture(t, name);
    f.activate();
    const initial = f.snapshot();
    assert.deepEqual(Object.keys(initial), [...f.modules.map(module => `${module === 'memcached' ? 30 : 20}-${module}.ini`), 'user.ini']);
    for (const module of f.modules) {
      assert.equal(initial[`${module === 'memcached' ? 30 : 20}-${module}.ini`], `${marker}[${module}]\nextension="${module}.so"\n`);
    }
    f.activate();
    assert.deepEqual(f.snapshot(), initial);
    const { command } = require('../../installer/install-extensions.cjs');
    for (const module of f.modules) {
      // AbstractPhpExtension#write_config_file removes *<extension>*.ini and
      // writes the numbered file with a quoted path under its opt prefix.
      for (const file of fs.readdirSync(f.scan).filter(file => file.includes(module) && file.endsWith('.ini'))) {
        fs.rmSync(path.join(f.scan, file));
      }
      fs.writeFileSync(path.join(f.scan, `${module === 'memcached' ? 30 : 20}-${module}.ini`),
        `[${module}]\nextension="/opt/homebrew/opt/${module}@8.6/${module}.so"\n`);
      command(f.php, ['-r', 'verify']);
    }
    f.activate();
    assert.deepEqual(f.snapshot(), initial);
  });
}
test('activation migrates combined pack INIs and removes stale module INIs before probing PHP', t => {
  const f = activationFixture(t);
  fs.writeFileSync(f.legacy, marker + f.modules.map(module => `extension=${module}.so\n`).join(''));
  fs.writeFileSync(path.join(f.scan, '20-igbinary.ini'), 'extension="/opt/homebrew/opt/igbinary@8.6/igbinary.so"\n');
  fs.writeFileSync(path.join(f.scan, '99-memcached.ini'), 'extension=memcached.so\n');
  f.activate();
  assert.deepEqual(Object.keys(f.snapshot()), ['20-igbinary.ini', '20-msgpack.ini', '30-memcached.ini', 'user.ini']);
  assert.equal(f.snapshot()['user.ini'], '; retain user settings\n');
});
test('activation respects modules enabled outside extension-specific INIs', t => {
  const f = activationFixture(t);
  fs.writeFileSync(path.join(f.scan, '00-user.ini'), 'extension=igbinary.so\n');
  f.activate();
  assert.ok(!fs.existsSync(path.join(f.scan, '20-igbinary.ini')));
  assert.equal(f.snapshot()['00-user.ini'], 'extension=igbinary.so\n');
});
test('failed activation restores all prior INIs and removes new files', t => {
  const f = activationFixture(t);
  fs.writeFileSync(path.join(f.root, 'fail'), '');
  assert.throws(f.activate, /failed/);
  assert.deepEqual(f.snapshot(), { 'user.ini': '; retain user settings\n' });
  fs.writeFileSync(f.legacy, marker + f.modules.map(module => `extension=${module}.so\n`).join(''), { mode: 0o640 });
  fs.writeFileSync(path.join(f.scan, '20-igbinary.ini'), 'extension=igbinary.so\n');
  const before = f.snapshot();
  assert.throws(f.activate, /failed/);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(fs.statSync(f.legacy).mode & 0o777, 0o640);
});
test('activation refuses unsafe files and unowned legacy configurations before changing INIs', t => {
  const f = activationFixture(t);
  fs.writeFileSync(f.legacy, '; my existing configuration\n');
  const before = f.snapshot();
  assert.throws(f.activate, /Refusing to replace/);
  assert.deepEqual(f.snapshot(), before);
  fs.rmSync(f.legacy);
  fs.symlinkSync(path.join(f.scan, 'user.ini'), path.join(f.scan, '20-igbinary.ini'));
  assert.throws(f.activate, /Unsafe optional/);
  assert.equal(f.snapshot()['user.ini'], '; retain user settings\n');
});

test('explicit cached extension requests use tap INIs without changing PHP-only or versioned requests', t => {
  const { activateCached, configureModules } = require('../../installer/install-extensions.cjs');
  const f = activationFixture(t, 'imagick');
  const base = { ...context, extensions: [
    { name: 'xdebug', type: 'zend_extension' }, { name: 'pcov', type: 'extension' }
  ] };
  const scan = '/opt/homebrew/etc/php/8.6/conf.d';
  const options = { enable: modules => configureModules(modules, f.scan, { php: f.php }) };
  for (const input of ['', 'none', 'redis', ':xdebug,:pcov', 'xdebug,xdebug-3.5.0,pcov,:pcov', 'xdebug,xdebug@source']) {
    activateCached(base, input, scan, options);
    assert.deepEqual(f.snapshot(), { 'user.ini': '; retain user settings\n' }, input);
  }
  activateCached({ ...base, extensions: [] }, 'xdebug,pcov', scan, options);
  assert.deepEqual(f.snapshot(), { 'user.ini': '; retain user settings\n' });
  assert.throws(() => activateCached(base, 'xdebug', '/opt/homebrew/etc/php/8.5/conf.d', options), /configuration directory/);
  activateCached(base, 'PHP-xdebug,pcov', scan, options);
  const expected = f.snapshot();
  assert.deepEqual(Object.keys(expected), ['20-pcov.ini', '20-xdebug.ini', 'user.ini']);
  assert.match(expected['20-xdebug.ini'], /\[xdebug\]\nzend_extension="xdebug.so"/);
  assert.match(expected['20-pcov.ini'], /\[pcov\]\nextension="pcov.so"/);
  activateCached(base, 'xdebug,pcov', scan, options);
  assert.deepEqual(f.snapshot(), expected);
  for (const { name, type } of base.extensions) {
    fs.writeFileSync(path.join(f.scan, `20-${name}.ini`), `[${name}]\n${type}="/opt/homebrew/opt/${name}@8.6/${name}.so"\n`);
    require('../../installer/install-extensions.cjs').command(f.php, ['-r', "exit(extension_loaded('xdebug') && extension_loaded('pcov') ? 0 : 1);"]);
  }
  const replaced = f.snapshot();
  fs.writeFileSync(path.join(f.root, 'fail'), '');
  assert.throws(() => activateCached(base, 'xdebug,pcov', scan, options), /failed/);
  assert.deepEqual(f.snapshot(), replaced, 'failed activation must restore the tap INIs');
});
