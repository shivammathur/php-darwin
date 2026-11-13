const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {test} = require('node:test');

function fixture(t, files = {'php.ini': '; package defaults\n'}, config = '8.7') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cached-extension-defaults-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const prefix = path.join(root, 'prefix');
  const source = path.join(root, 'source');
  const runnerConfig = path.join(prefix, 'etc/php', config);
  fs.mkdirSync(path.join(runnerConfig, 'conf.d'), {recursive: true});
  fs.writeFileSync(path.join(runnerConfig, 'php.ini'), 'extension=pcov.so\n');
  fs.writeFileSync(path.join(runnerConfig, 'conf.d/20-xdebug.ini'), 'zend_extension=xdebug.so\n');
  const paths = Object.keys(files).map(file => `etc/php/${config}/${file}`);
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(source, 'etc/php', config, file);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, content);
  }
  const archive = path.join(root, 'cache.tar');
  const extensions = ['pcov', 'xdebug'].map(name => ({name, type: name === 'pcov' ? 'extension' : 'zend_extension',
    path: `lib/php/pecl/20260925/${name}.so`}));
  for (const extension of extensions) {
    const file = path.join(prefix, extension.path);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, 'broken previous extension');
    const packaged = path.join(source, extension.path);
    fs.mkdirSync(path.dirname(packaged), {recursive: true});
    fs.writeFileSync(packaged, 'packaged extension fixture');
  }
  const repack = () => {
    const tar = spawnSync('tar', ['-cf', archive, '-C', source, ...paths, ...extensions.map(e => e.path)], {encoding: 'utf8'});
    assert.equal(tar.status, 0, tar.stderr);
  };
  repack();
  const metadata = path.join(root, 'cache.json');
  fs.writeFileSync(metadata, JSON.stringify({state_paths: paths, extensions}));
  const php = path.join(root, 'php');
  // Model PHP's INI selection and extension loading without requiring PHP on the
  // validation runner. The archive extraction and helper run unmodified.
  fs.writeFileSync(php, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({args, phprc: process.env.PHPRC, scan: process.env.PHP_INI_SCAN_DIR}) + '\\n');
if (args.includes('--ini')) { console.log('Loaded Configuration File: ' + process.env.PHPRC); process.exit(0); }
let ini = '';
if (!args.includes('-n')) {
  const main = args.includes('-c') ? args[args.indexOf('-c') + 1] : process.env.PHPRC;
  ini = fs.readFileSync(main, 'utf8');
  for (const file of fs.readdirSync(process.env.PHP_INI_SCAN_DIR).filter(file => file.endsWith('.ini'))) {
    ini += '\\n' + fs.readFileSync(path.join(process.env.PHP_INI_SCAN_DIR, file), 'utf8');
  }
}
if (args.includes('-d')) ini += '\\n' + args[args.indexOf('-d') + 1];
if (args.includes('-n') && args.includes('-d')) {
  const module = args[args.indexOf('-d') + 1].split('=').slice(1).join('=');
  if (fs.readFileSync(module, 'utf8') !== 'packaged extension fixture') {
    console.error('Module does not load'); process.exit(139);
  }
}
const expression = args[args.indexOf('-r') + 1];
const name = expression.match(/extension_loaded\\('([^']+)'\\)/)[1];
const loaded = ini.split('\\n').some(line => /^(zend_)?extension\\s*=/.test(line.trim()) && line.includes(name + '.so'));
process.exit(expression.includes('!extension_loaded') ? (loaded ? 0 : 1) : (loaded ? 1 : 0));
`, {mode: 0o755});
  const log = path.join(root, 'calls.jsonl');
  return {root, prefix, source, repack, runnerConfig, log, extensions,
    run: () => spawnSync('bash', ['scripts/tests/helpers/check-cached-extensions.sh', archive, metadata, php, prefix, config], {
      encoding: 'utf8', env: {...process.env, RUNNER_TEMP: root, CALL_LOG: log,
        PHPRC: path.join(runnerConfig, 'php.ini'), PHP_INI_SCAN_DIR: path.join(runnerConfig, 'conf.d')}
    })};
}

test('archive defaults ignore existing PHP settings and inherited INI overrides for every variant', t => {
  for (const config of ['8.7', '8.7-zts', '8.7-debug', '8.7-debug-zts']) {
    const f = fixture(t, undefined, config);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const calls = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.filter(call => call.args.includes('-n')).length, 2);
    assert.equal(calls.filter(call => call.args.includes('-c')).length, 2);
    for (const call of calls) {
      assert.notEqual(call.phprc, path.join(f.runnerConfig, 'php.ini'));
      assert.notEqual(call.scan, path.join(f.runnerConfig, 'conf.d'));
    }
    assert.equal(fs.readFileSync(path.join(f.runnerConfig, 'php.ini'), 'utf8'), 'extension=pcov.so\n');
    assert.equal(fs.readFileSync(path.join(f.runnerConfig, 'conf.d/20-xdebug.ini'), 'utf8'), 'zend_extension=xdebug.so\n');
    assert.ok(!fs.readdirSync(f.root).some(name => name.startsWith('php-darwin-defaults.')));
  }
});

for (const [name, files] of [
  ['pcov', {'php.ini': 'extension=pcov.so\n'}],
  ['xdebug', {'php.ini': '; defaults\n', 'conf.d/coverage.ini': 'zend_extension=xdebug.so\n'}]
]) {
  test(`rejects ${name} enabled by packaged INI files and reports the loaded configuration`, t => {
    const f = fixture(t, files);
    const result = f.run();
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, new RegExp(`${name} is enabled by default in the cache`));
    assert.match(result.stderr, /Loaded Configuration File:/);
    assert.ok(!fs.readdirSync(f.root).some(file => file.startsWith('php-darwin-defaults.')));
  });
}

test('rejects an archive without php.ini instead of falling back to runner defaults', t => {
  const f = fixture(t, {'conf.d/empty.ini': '; empty\n'});
  const result = f.run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /archive PHP configuration is missing/);
  assert.ok(!fs.existsSync(f.log));
});

test('missing or broken previously installed modules cannot block validation of the new archive', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.prefix, f.extensions[0].path));
  fs.unlinkSync(path.join(f.prefix, f.extensions[1].path));
  fs.symlinkSync('/missing/old/xdebug.so', path.join(f.prefix, f.extensions[1].path));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readlinkSync(path.join(f.prefix, f.extensions[1].path)), '/missing/old/xdebug.so');
  assert.ok(!fs.existsSync(path.join(f.prefix, f.extensions[0].path)));
});

test('still rejects a broken module in the new archive', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, f.extensions[0].path), 'broken new extension');
  f.repack();
  const result = f.run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /cached pcov failed its explicit load test/);
});

test('rejects an empty module in the new archive', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, f.extensions[0].path), '');
  f.repack();
  const result = f.run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /archive is missing cached pcov/);
});
