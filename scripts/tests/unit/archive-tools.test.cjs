const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {execFileSync} = require('node:child_process');
const {restoreTools} = require('../../build/archive-tools.cjs');
const {ApprovedDependencies} = require('../../cache/approved-dependencies.cjs');

function fixture(t, {installed = [], unavailable = '', unexpected = false} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-tool-bottles-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const prefix = path.join(root, 'prefix');
  fs.mkdirSync(path.join(prefix, 'bin'), {recursive: true});
  const packages = Object.fromEntries(['zstd', 'lz4', 'xz', 'cmake'].map(name => [name, {version: '1.0',
    ...(name === 'lz4' ? {source: {sha256: 'a'.repeat(64)}} : {})}]));
  const files = {}, dependencies = {}, downloads = [], calls = [], stamped = [];
  for (const name of Object.keys(packages)) {
    const directory = path.join(root, name, '1.0');
    fs.mkdirSync(path.join(directory, '.brew'), {recursive: true});
    const deps = name === 'zstd' ? ['lz4', 'xz', ...(unexpected ? ['unapproved'] : [])] : [];
    dependencies[name] = deps;
    // Match upstream bottles: the recipe is present, the install receipt is not.
    fs.writeFileSync(path.join(directory, '.brew', `${name}.rb`), `class Fixture < Formula\n  depends_on "cmake" => :build\n${deps.map(dep => `  depends_on "${dep}"`).join('\n')}\nend\n`);
    files[name] = path.join(root, `${name}.bottle.tar.gz`);
    execFileSync('tar', ['-czf', files[name], '-C', root, `${name}/1.0`]);
  }
  for (const name of installed) {
    const directory = path.join(prefix, 'opt', name);
    fs.mkdirSync(directory, {recursive: true});
    fs.writeFileSync(path.join(directory, 'INSTALL_RECEIPT.json'), 'existing library must remain unchanged');
  }
  const approved = {
    platform: {packages}, versions() {},
    async fetchBottle(item) {
      downloads.push(item.full_name);
      if (item.full_name === unavailable) throw new Error('Verified cache unavailable');
      return files[item.full_name];
    },
    restore: ApprovedDependencies.prototype.restore,
    recordInstalled: (item, hash) => stamped.push([item.full_name, hash]),
  };
  const run = (program, args) => {
    if (program === 'tar') return execFileSync(program, args, {encoding: 'utf8'});
    if (program === 'brew' && args[0] === 'php-darwin-source') {
      assert.equal(args[1], 'tool-dependencies');
      assert.ok(execFileSync('tar', ['-xOf', args[2], `${args[3]}/1.0/.brew/${args[3]}.rb`], {encoding: 'utf8'})
        .includes('depends_on "cmake" => :build'));
      return JSON.stringify(dependencies[args[3]]);
    }
    calls.push([program, args]);
    if (program === 'brew') {
      assert.equal(args[0], 'install');
      assert.ok(args.includes('--ignore-dependencies'));
      assert.ok(args.includes('--force-bottle'));
      const bottles = args.filter(value => value.endsWith('.tar.gz'));
      assert.equal(bottles.length, args.filter(value => !value.startsWith('-')).length - 1);
      assert.ok(!bottles.includes(files.cmake), 'build tools must never enter a runtime bootstrap');
      fs.writeFileSync(path.join(prefix, 'bin/zstd'), 'fixture');
    } else assert.equal(program, path.join(prefix, 'bin/zstd'));
    return '';
  };
  return {root, prefix, files, calls, downloads, stamped, options: {
    lock: {platforms: {x86_64: {packages}}}, platform: {arch: 'x86_64', prefix},
    approved, run, cache: () => ({}), cacheRoot: path.join(root, 'cache'),
  }};
}

test('archive bootstrap restores approved runtime bottles without consulting current source-only recipes', async t => {
  const f = fixture(t);
  assert.deepEqual(await restoreTools(['zstd'], f.options), ['lz4', 'xz', 'zstd']);
  assert.deepEqual(f.downloads, ['zstd', 'lz4', 'xz']);
  assert.deepEqual(f.calls[0][1].filter(value => value.endsWith('.tar.gz')), [f.files.lz4, f.files.xz, f.files.zstd]);
  assert.deepEqual(f.stamped, [['lz4', 'a'.repeat(64)]]);
  assert.equal(f.calls.length, 2);
});

test('archive bootstrap preserves libraries already selected by existing PHP', async t => {
  const f = fixture(t, {installed: ['lz4', 'xz']});
  assert.deepEqual(await restoreTools(['zstd'], f.options), ['zstd']);
  assert.deepEqual(f.downloads, ['zstd']);
  for (const name of ['lz4', 'xz']) assert.equal(
    fs.readFileSync(path.join(f.prefix, 'opt', name, 'INSTALL_RECEIPT.json'), 'utf8'),
    'existing library must remain unchanged');
});

for (const failure of [{unavailable: 'xz'}, {unexpected: true}]) {
  test(`incomplete archive-tool runtime closure fails before any installation (${JSON.stringify(failure)})`, async t => {
    const f = fixture(t, failure);
    await assert.rejects(restoreTools(['zstd'], f.options), /unavailable|not approved/);
    assert.equal(f.calls.length, 0);
  });
}
