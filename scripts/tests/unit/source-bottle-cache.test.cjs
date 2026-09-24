const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { install, keyFor, readBottle, extensionInputs } = require('../../cache/source-bottle-cache.cjs');
const { withFreshConfiguration } = require('../../cache/source-bottle-config.cjs');

test('source builds bottle clean defaults and restore existing configuration on success or failure', t => {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'php-darwin-source-config-'));
  t.after(() => fs.rmSync(prefix, { recursive: true, force: true }));
  const relative = 'etc/openldap/slapd.conf';
  const target = path.join(prefix, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'user configuration', { mode: 0o600 });
  fs.writeFileSync(path.join(prefix, 'etc/unrelated'), 'unrelated');
  for (const failure of [false, true]) {
    const build = () => withFreshConfiguration(prefix, [relative], () => {
      assert.equal(fs.existsSync(target), false);
      fs.writeFileSync(target, 'new default configuration');
      assert.equal(fs.readFileSync(path.join(prefix, 'etc/unrelated'), 'utf8'), 'unrelated');
      if (failure) throw new Error('build failed');
    });
    if (failure) assert.throws(build, /build failed/); else build();
    assert.equal(fs.readFileSync(target, 'utf8'), 'user configuration');
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.equal(fs.readdirSync(path.join(prefix, 'etc')).filter(name => name.startsWith('.php-darwin')).length, 0);
  }
  fs.symlinkSync('/missing-config-directory', path.join(prefix, 'etc/redirect'));
  assert.throws(() => withFreshConfiguration(prefix, ['etc/redirect/config'], () => {}), /Unsafe/);
  assert.throws(() => withFreshConfiguration(prefix, ['etc/../outside'], () => {}), /Invalid/);
  assert.throws(() => withFreshConfiguration(prefix, ['var/service-data'], () => {}), /Invalid/);
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'php-darwin-source-cache-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = path.join(directory, 'remote');
  const cacheRoot = path.join(directory, 'local');
  fs.mkdirSync(store);
  const events = [];
  const warnings = [];
  const state = { library: '1.0', php: '8.4.1', recipe: 'recipe', compiler: 'clang-1' };
  const plan = () => [
    { full_name: 'libxml2', name: 'libxml2', version: state.library, post_install: true },
    { full_name: 'shivammathur/php/php@8.4', name: 'php@8.4', version: state.php, post_install: true },
  ];
  const cache = {
    async restoreCache([destination], key, fallback) {
      assert.deepEqual(fallback, []);
      if (!fs.existsSync(path.join(store, key))) return;
      fs.cpSync(path.join(store, key), destination, { recursive: true });
      return key;
    },
    async saveCache([source], key) {
      fs.cpSync(source, path.join(store, key), { recursive: true });
    },
  };
  const args = {
    formula: 'shivammathur/php/php@8.4', cache, cacheRoot,
    query: () => plan(), buildEnvironment: () => ({ compiler: state.compiler }),
    inputs: (item, environment) => ({
      formula: item.full_name, version: item.version, environment, recipe: state.recipe,
      dependencies: item.name === 'libxml2' ? [] : [{ name: 'libxml2', version: state.library, post_install: true }],
    }),
    log: () => {}, warn: message => warnings.push(message),
    run: (program, argv, options = {}) => {
      assert.equal(program, 'brew');
      if (argv.includes('--build-bottle')) {
        assert.equal(argv[0], 'php-darwin-source', 'Source builds must preserve the compiler dependency environment');
        assert.ok(options.env.PATH.startsWith(path.resolve(__dirname, '../../cache') + path.delimiter));
        argv = argv.slice(1);
      }
      if (argv[0] === 'install') assert.ok(argv.includes('--ignore-dependencies'),
        'Homebrew must not repeat dependency resolution after the cache installed its complete plan');
      if (argv[0] === 'install' && argv.at(-1).endsWith('.bottle.tar.gz')) {
        assert.equal(options.env.HOMEBREW_DEVELOPER, '1');
      }
      events.push(argv);
      if (argv[0] === 'deps') return 'libxml2\n';
      if (argv[0] === 'bottle') {
        const item = plan().find(item => item.full_name === argv.at(-1));
        fs.writeFileSync(path.join(options.cwd, `${item.name}--${item.version}.arm64_sonoma.bottle.tar.gz`),
          `compiled ${item.full_name} ${item.version}`);
      }
      return '';
    },
  };
  return { args, events, state, store, cacheRoot, warnings,
    freshRunner() { fs.rmSync(cacheRoot, { recursive: true, force: true }); events.length = 0; } };
}

test('reuse libxml2 across PHP builds and rebuild both when libxml2 changes', async t => {
  const f = fixture(t);
  assert.deepEqual(await install(f.args), { built: 2, restored: 0 });
  assert.equal(f.events.filter(args => args[0] === 'postinstall').length, 2);
  f.freshRunner();
  assert.deepEqual(await install(f.args), { built: 0, restored: 2 });
  assert.equal(f.events.filter(args => args.includes('--build-bottle')).length, 0);
  f.freshRunner();
  f.state.php = '8.4.2';
  assert.deepEqual(await install(f.args), { built: 1, restored: 1 });
  assert.deepEqual(f.events.filter(args => args.includes('--build-bottle')).map(args => args.at(-1)),
    ['shivammathur/php/php@8.4']);
  f.freshRunner();
  f.state.library = '2.0';
  assert.deepEqual(await install(f.args), { built: 2, restored: 0 });
  f.freshRunner();
  f.state.compiler = 'clang-2';
  assert.deepEqual(await install(f.args), { built: 2, restored: 0 });
});

test('cache outages and concurrent saves do not discard successful source builds', async t => {
  const f = fixture(t);
  f.args.cache.restoreCache = async () => { throw new Error('cache unavailable'); };
  f.args.cache.saveCache = async () => { throw new Error('another job saved this key'); };
  assert.deepEqual(await install(f.args), { built: 2, restored: 0 });
  assert.equal(f.warnings.length, 4);
});

test('invalid bottle data can rebuild while owned, but unavailable ownership never starts a build', async t => {
  const f = fixture(t);
  f.args.cache.restoreCache = async () => { throw new Error('invalid cached bottle'); };
  f.args.cache.withBuildLock = async (key, build) => build(0);
  assert.deepEqual(await install(f.args), { built: 2, restored: 0 });
  f.freshRunner();
  f.args.cache.withBuildLock = async () => { throw new Error('ownership unavailable'); };
  await assert.rejects(install(f.args), /ownership unavailable/);
  assert.equal(f.events.length, 0);
});

test('a library uploaded while waiting is restored instead of being compiled twice', async t => {
  const f = fixture(t);
  await install(f.args);
  f.freshRunner();
  const restore = f.args.cache.restoreCache;
  let owned = false;
  f.args.cache.restoreCache = async (...args) => owned ? restore(...args) : undefined;
  f.args.cache.withBuildLock = async (key, build) => {
    owned = true;
    try { return await build(500); } finally { owned = false; }
  };
  assert.deepEqual(await install(f.args), { built: 0, restored: 2 });
  assert.equal(f.events.filter(args => args.includes('--build-bottle')).length, 0);
});

test('corrupt cached bottles are rejected before installation', async t => {
  const f = fixture(t);
  await install(f.args);
  for (const key of fs.readdirSync(f.store)) {
    const metadata = JSON.parse(fs.readFileSync(path.join(f.store, key, 'metadata.json')));
    fs.appendFileSync(path.join(f.store, key, metadata.file), 'corrupt');
  }
  f.freshRunner();
  assert.deepEqual(await install(f.args), { built: 2, restored: 0 });
  assert.equal(f.events.filter(args => args.at(-1).endsWith('.tar.gz')).length, 0);
});

test('a failed bottle installation stops without attempting a source rebuild', async t => {
  const f = fixture(t);
  await install(f.args);
  f.freshRunner();
  const run = f.args.run;
  f.args.run = (program, args, options) => {
    if (args[0] === 'install' && args.at(-1).endsWith('.tar.gz')) throw new Error('pour failed');
    return run(program, args, options);
  };
  await assert.rejects(install(f.args), /pour failed/);
  assert.equal(f.events.filter(args => args.includes('--build-bottle')).length, 0);
});

test('existing dependencies and upstream bottles do not get rebuilt', async t => {
  const f = fixture(t);
  f.args.query = () => [
    { full_name: 'libxml2', installed: true },
    { full_name: 'shivammathur/php/php@8.4', bottled: true },
  ];
  assert.deepEqual(await install(f.args), { built: 0, restored: 0 });
  assert.deepEqual(f.events.at(-1), ['install', '--formula', '--verbose', '--ignore-dependencies', 'shivammathur/php/php@8.4']);
});

test('missing upstream bottles are prefetched together and install still retries after fetch failure', async t => {
  const f = fixture(t);
  f.args.query = () => [
    { full_name: 'aspell', version: '0.60.8.2', bottled: true },
    { full_name: 'gcc', version: '16.2.0', bottled: true },
    { full_name: 'shivammathur/php/php@8.4', version: '8.4.1', bottled: false },
  ];
  const run = f.args.run;
  f.args.run = (program, argv, options) => {
    if (argv[0] === 'fetch') throw new Error('temporary download failure');
    return run(program, argv, options);
  };
  assert.deepEqual(await install(f.args), { built: 1, restored: 0 });
  assert.deepEqual(f.warnings, ['Upstream bottle prefetch incomplete: temporary download failure']);
  assert.deepEqual(f.events.filter(args => args[0] === 'install' && !args.includes('--build-bottle')),
    [['install', '--formula', '--verbose', '--ignore-dependencies', 'aspell'], ['install', '--formula', '--verbose', '--ignore-dependencies', 'gcc']]);
  f.args.run = run;
  f.freshRunner();
  assert.deepEqual(await install(f.args), { built: 0, restored: 1 });
  assert.deepEqual(f.events[0], ['fetch', '--formula', 'aspell', 'gcc']);
});

test('keys distinguish recipes, platforms, dependencies, and PHP variants', () => {
  const baseline = { formula: 'php', version: '8.4', recipe: 'abc', arch: 'arm64', macos: '14', deps: 'libxml2-1' };
  for (const [field, value] of Object.entries({ formula: 'php-debug-zts', version: '8.5',
    recipe: 'def', arch: 'x86_64', macos: '15', deps: 'libxml2-2' })) {
    assert.notEqual(keyFor(baseline), keyFor({ ...baseline, [field]: value }));
  }
});

test('cache metadata cannot redirect installation outside its directory', t => {
  const f = fixture(t);
  fs.mkdirSync(f.cacheRoot);
  fs.writeFileSync(path.join(f.cacheRoot, 'metadata.json'), JSON.stringify({
    schema: 1, key: 'key', file: '../foreign.bottle.tar.gz', sha256: 'a'.repeat(64),
  }));
  assert.throws(() => readBottle(f.cacheRoot, 'key'), /identity/);
});

test('extension variants bypass upstream bottles, preserve skip-link, and isolate shared source', async t => {
  const f = fixture(t);
  const query = f.args.query;
  f.args.query = () => query().map(item => ({ ...item, bottled: true }));
  f.args.forceSource = true;
  f.args.skipLink = true;
  f.args.context = { build: 'debug', ts: 'zts', abstract: 'original', php: { api: '20240924' } };
  assert.deepEqual(await install(f.args), { built: 1, restored: 0 });
  assert.deepEqual(f.events.find(args => args.includes('--build-bottle')).slice(0, 6),
    ['install', '--formula', '--build-bottle', '--verbose', '--ignore-dependencies', '--skip-link']);
  assert.ok(!f.events.find(args => args.at(-1) === 'libxml2').includes('--skip-link'));
  f.freshRunner();
  assert.deepEqual(await install(f.args), { built: 0, restored: 1 });
  assert.ok(f.events.find(args => args.at(-1).endsWith('.tar.gz')).includes('--skip-link'));
  for (const context of [
    { ...f.args.context, abstract: 'patched' },
    { ...f.args.context, build: 'release' },
    { ...f.args.context, ts: 'nts' },
    { ...f.args.context, php: { api: '20250925' } },
  ]) {
    f.freshRunner();
    assert.deepEqual(await install({ ...f.args, context }), { built: 1, restored: 0 });
  }
});

test('extension keys include the patched base recipe and actual PHP ABI/configuration', t => {
  const f = fixture(t);
  const abstract = path.join(f.cacheRoot, 'abstract.rb');
  fs.mkdirSync(f.cacheRoot);
  fs.writeFileSync(abstract, 'original recipe');
  for (const [file, name] of [['main/php.h', 'PHP_API_VERSION'],
    ['Zend/zend_modules.h', 'ZEND_MODULE_API_NO'], ['Zend/zend_extensions.h', 'ZEND_EXTENSION_API_NO']]) {
    fs.mkdirSync(path.dirname(path.join(f.cacheRoot, file)), { recursive: true });
    fs.writeFileSync(path.join(f.cacheRoot, file), `#define ${name} 20240924\n`);
  }
  const calls = [];
  const run = (program, args) => { calls.push([program, args]); return args[0] === '--include-dir' ? f.cacheRoot : args.join(' '); };
  const first = extensionInputs(abstract, '/opt/php', 'release', 'nts', run);
  assert.equal(calls.length, 4);
  assert.equal(first.php.api.ZEND_MODULE_API_NO, '20240924');
  fs.writeFileSync(abstract, 'patched recipe');
  assert.notEqual(keyFor(first), keyFor(extensionInputs(abstract, '/opt/php', 'release', 'nts', run)));
});

test('Cloudflare prefetch completes before upstream fetch and leaves normal installation intact', async t => {
  const f = fixture(t);
  const bottles = [{ full_name: 'libxml2', name: 'libxml2', installed: false, bottled: true,
    bottle: { formula: 'libxml2', sha256: 'fixture-digest' } },
  { full_name: f.args.formula, name: 'php@8.4', installed: true }];
  f.args.query = () => bottles;
  f.args.prefetch = async records => {
    assert.deepEqual(records, [bottles[0].bottle]);
    assert.equal(f.events.length, 0);
    f.events.push(['cloudflare']);
  };
  await install(f.args);
  assert.deepEqual(f.events, [['cloudflare'], ['install', '--formula', '--verbose', '--ignore-dependencies', 'libxml2']]);
});
