const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { install, keyFor, readBottle, extensionInputs } = require('./source-bottle-cache.cjs');

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
  assert.deepEqual(f.events.at(-1), ['install', '--formula', 'shivammathur/php/php@8.4']);
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
  assert.deepEqual(f.events.find(args => args.includes('--build-bottle')).slice(0, 4),
    ['install', '--formula', '--build-bottle', '--skip-link']);
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
  const calls = [];
  const run = (program, args) => { calls.push([program, args]); return args.join(' '); };
  const first = extensionInputs(abstract, '/opt/php', 'release', 'nts', run);
  assert.equal(calls.length, 4);
  assert.ok(calls.some(([program, args]) => program === '/opt/php/bin/php-config' && args[0] === '--phpapi'));
  fs.writeFileSync(abstract, 'patched recipe');
  assert.notEqual(keyFor(first), keyFor(extensionInputs(abstract, '/opt/php', 'release', 'nts', run)));
});
