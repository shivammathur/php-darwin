const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ReleaseCache, family, releaseAsset, assetIdentity } = require('./source-bottle-releases.cjs');
const { keyFor, readBottle } = require('./source-bottle-cache.cjs');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-bottle-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = { release: null, assets: [], deleted: [], failDownload: false, uploadRace: false, next: 0 };
  const request = async (url, options) => {
    const parsed = new URL(url);
    const endpoint = parsed.pathname.replace('/repos/shivammathur/php-darwin/', '');
    const json = (body, status = 200) => Response.json(body, { status });
    if (endpoint.startsWith('releases/tags/')) return json(state.release, state.release ? 200 : 404);
    if (endpoint === 'releases' && options.method === 'POST') {
      const body = JSON.parse(options.body);
      assert.equal(body.make_latest, 'false');
      assert.equal(body.prerelease, false);
      state.release = { id: 1 };
      return json(state.release, 201);
    }
    if (endpoint === 'releases/1/assets' && options.method === 'POST') {
      const chunks = [];
      for await (const chunk of options.body) chunks.push(chunk);
      const data = Buffer.concat(chunks);
      const name = parsed.searchParams.get('name');
      if (!state.assets.some(asset => asset.name === name)) state.assets.push({
        id: ++state.next, name, label: parsed.searchParams.get('label'),
        digest: `sha256:${digest(data)}`, data,
      });
      return json({}, state.uploadRace ? 422 : 201);
    }
    if (endpoint === 'releases/1/assets') return json(state.assets.map(({ data, ...asset }) => asset));
    const id = Number(endpoint.split('/').at(-1));
    const asset = state.assets.find(asset => asset.id === id);
    if (options.method === 'DELETE') {
      state.deleted.push(asset.name);
      state.assets = state.assets.filter(asset => asset.id !== id);
      return new Response(null, { status: 204 });
    }
    if (state.failDownload) return new Response('unavailable', { status: 503 });
    return new Response(asset.data);
  };
  const cache = new ReleaseCache({ repository: 'shivammathur/php-darwin', token: 'fixture', request,
    versionsToPrune: versions => versions.filter(version => Number(version) < Math.max(...versions.map(Number))) });
  function bottle(version, overrides = {}) {
    const inputs = { formula: 'libxml2', version, environment: { arch: 'arm64', macos: '14', prefix: '/opt/homebrew' }, ...overrides };
    const key = keyFor(inputs);
    const directory = path.join(root, key);
    fs.mkdirSync(directory, { recursive: true });
    const file = `libxml2--${version}.arm64_sonoma.bottle.tar.gz`;
    const contents = `native compiled bottle ${version}`;
    fs.writeFileSync(path.join(directory, file), contents);
    fs.writeFileSync(path.join(directory, 'metadata.json'), JSON.stringify({
      schema: 1, key, file, sha256: digest(contents), inputs,
    }));
    return { directory, key, ...releaseAsset(JSON.parse(fs.readFileSync(path.join(directory, 'metadata.json')))) };
  }
  return { root, state, cache, bottle };
}

test('persistent release round-trip and pruning only older versions in the same package family', async t => {
  const f = fixture(t);
  const old = f.bottle('1');
  assert.equal(await f.cache.restoreCache([old.directory], old.key), undefined);
  await f.cache.saveCache([old.directory], old.key);
  const restored = path.join(f.root, 'restored');
  assert.equal(await f.cache.restoreCache([restored], old.key), old.key);
  assert.ok(readBottle(restored, old.key));
  const intel = f.bottle('1', { environment: { arch: 'x86_64', macos: '15', prefix: '/usr/local' } });
  await f.cache.saveCache([intel.directory], intel.key);
  const current = f.bottle('2');
  await f.cache.saveCache([current.directory], current.key);
  assert.deepEqual(f.state.deleted, [old.name]);
  assert.equal(await f.cache.restoreCache([restored], old.key), undefined);
  assert.ok(f.state.assets.some(asset => asset.name === intel.name));
  // An older job finishing later removes its own superseded version, never the newer one.
  await f.cache.saveCache([old.directory], old.key);
  assert.ok(f.state.assets.some(asset => asset.name === current.name));
  assert.ok(!f.state.assets.some(asset => asset.name === old.name));
});

test('failed remote verification preserves old versions', async t => {
  const f = fixture(t);
  const old = f.bottle('1');
  await f.cache.saveCache([old.directory], old.key);
  f.state.failDownload = true;
  const current = f.bottle('2');
  await assert.rejects(f.cache.saveCache([current.directory], current.key), /503/);
  assert.deepEqual(f.state.deleted, []);
});

test('concurrent upload winners are verified and reused without clobbering', async t => {
  const f = fixture(t);
  f.state.uploadRace = true;
  const current = f.bottle('2');
  await f.cache.saveCache([current.directory], current.key);
  await f.cache.saveCache([current.directory], current.key);
  assert.equal(f.state.assets.length, 1);
  assert.deepEqual(f.state.deleted, []);
});

test('a late older build does not prune against an unverified newer upload', async t => {
  const f = fixture(t);
  const old = f.bottle('1');
  await f.cache.saveCache([old.directory], old.key);
  f.state.failDownload = true;
  const current = f.bottle('2');
  await assert.rejects(f.cache.saveCache([current.directory], current.key), /503/);
  f.state.failDownload = false;
  f.state.assets.find(asset => asset.name === current.name).data = Buffer.from('corrupt');
  await assert.rejects(f.cache.saveCache([old.directory], old.key), /checksum/);
  assert.deepEqual(f.state.deleted, []);
});

test('corrupt release bytes are rejected before extracting a bottle', async t => {
  const f = fixture(t);
  const current = f.bottle('2');
  await f.cache.saveCache([current.directory], current.key);
  f.state.assets[0].data = Buffer.from('corrupt');
  const destination = path.join(f.root, 'corrupt');
  await assert.rejects(f.cache.restoreCache([destination], current.key), /checksum/);
  assert.ok(!fs.existsSync(destination));
});

test('cleanup keeps PHP extension ABI families separate', () => {
  const inputs = { formula: 'shivammathur/extensions/pcov@8.4', environment: { arch: 'arm64', macos: '14' },
    context: { build: 'release', ts: 'nts', php: { version: '8.4.1' } } };
  assert.notEqual(family(inputs), family({ ...inputs, context: { ...inputs.context, ts: 'zts' } }));
  assert.notEqual(family(inputs), family({ ...inputs, context: { ...inputs.context, build: 'debug' } }));
  assert.equal(family(inputs), family({ ...inputs, context: { ...inputs.context, php: { version: '8.4.2' } } }));
});

test('readable names preserve full cache identity independently of display labels', () => {
  const inputs = { formula: 'shivammathur/extensions/xdebug@8.4', version: '3.5.3_1',
    environment: { arch: 'arm64', macos: '14', prefix: '/opt/homebrew' },
    context: { build: 'debug', ts: 'zts' } };
  const key = keyFor(inputs);
  const asset = releaseAsset({ inputs, key });
  assert.equal(asset.label, `xdebug@8.4--3.5.3_1.macos-14.arm64.debug-zts.${key.slice(-64, -52)}.tar`);
  assert.ok(asset.name.startsWith('xdebug@8.4--3.5.3_1.macos-14.arm64.debug-zts.'));
  assert.deepEqual(assetIdentity({ ...asset, label: 'Edited in GitHub' }),
    { version: inputs.version, group: family(inputs), key });
  assert.equal(assetIdentity({ name: asset.label }), undefined);
});

test('legacy assets restore and are pruned when a readable replacement is verified', async t => {
  const f = fixture(t);
  const old = f.bottle('1');
  await f.cache.saveCache([old.directory], old.key);
  const legacy = f.state.assets[0];
  const identity = assetIdentity(legacy);
  legacy.name = `${old.key}.tar`;
  legacy.label = `source-v1:${identity.group}:1`;
  assert.equal(await f.cache.restoreCache([path.join(f.root, 'legacy')], old.key), old.key);
  const current = f.bottle('2');
  await f.cache.saveCache([current.directory], current.key);
  assert.deepEqual(f.state.deleted, [legacy.name]);
  assert.deepEqual(f.state.assets.map(asset => asset.name), [current.name]);
});

test('same-version builds retain distinct inputs and ignore edited display labels', async t => {
  const f = fixture(t);
  const first = f.bottle('1', { recipe: 'first' });
  const second = f.bottle('1', { recipe: 'second' });
  await f.cache.saveCache([first.directory], first.key);
  f.state.assets[0].label = 'Custom display name';
  await f.cache.saveCache([second.directory], second.key);
  assert.equal(f.state.assets.length, 2);
  assert.deepEqual(f.state.deleted, []);
  assert.equal(await f.cache.restoreCache([path.join(f.root, 'first')], first.key), first.key);
  assert.equal(await f.cache.restoreCache([path.join(f.root, 'second')], second.key), second.key);
  const next = f.bottle('2');
  await f.cache.saveCache([next.directory], next.key);
  assert.deepEqual(f.state.deleted.sort(), [first.name, second.name].sort());
});
