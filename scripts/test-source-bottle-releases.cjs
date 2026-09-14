const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ReleaseCache, family, releaseAsset, assetIdentity } = require('./source-bottle-releases.cjs');
const { keyFor, readBottle } = require('./source-bottle-cache.cjs');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t, tag = 'cache') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-bottle-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = { release: null, assets: [], deleted: [], failDownload: false, uploadRace: false, next: 0, delays: [] };
  const request = async (url, options) => {
    const parsed = new URL(url);
    const endpoint = parsed.pathname.replace('/repos/shivammathur/php-darwin/', '');
    const json = (body, status = 200) => Response.json(body, { status });
    assert.ok(options.signal instanceof AbortSignal);
    const intercepted = await state.intercept?.(endpoint, options);
    if (intercepted) return intercepted;
    if (endpoint.startsWith('releases/tags/')) return json(state.release, state.release ? 200 : 404);
    if (endpoint === 'releases' && options.method === 'POST') {
      const body = JSON.parse(options.body);
      assert.equal(body.make_latest, 'false');
      assert.equal(body.prerelease, tag.startsWith('source-bottles-test-'));
      state.release = { id: 1, ...body };
      return json(state.release, 201);
    }
    if (endpoint === 'releases/1/assets' && options.method === 'POST') {
      const chunks = [];
      for await (const chunk of options.body) chunks.push(chunk);
      const data = Buffer.concat(chunks);
      const name = parsed.searchParams.get('name');
      const existing = state.assets.some(asset => asset.name === name);
      if (!existing) state.assets.push({
        id: ++state.next, name, label: parsed.searchParams.get('label'),
        state: 'uploaded', size: data.length, created_at: new Date().toISOString(),
        digest: `sha256:${digest(data)}`, data,
      });
      if (state.loseUploadReply) {
        state.loseUploadReply = false;
        throw new TypeError('fetch failed after upload');
      }
      return json({}, existing || state.uploadRace ? 422 : 201);
    }
    if (endpoint === 'releases/1/assets') return json(state.assets.map(({ data, ...asset }) => asset));
    const id = Number(endpoint.split('/').at(-1));
    const asset = state.assets.find(asset => asset.id === id);
    if (!asset) return json(null, 404);
    if (options.method === 'DELETE') {
      state.deleted.push(asset.name);
      state.assets = state.assets.filter(asset => asset.id !== id);
      return new Response(null, { status: 204 });
    }
    if (options.headers.Accept !== 'application/octet-stream') {
      const { data, ...metadata } = asset;
      return json(metadata);
    }
    if (state.failDownload) return new Response('unavailable', { status: 503 });
    return new Response(asset.data);
  };
  const cache = new ReleaseCache({ repository: 'shivammathur/php-darwin', token: 'fixture', tag, request,
    wait: async delay => state.delays.push(delay), warn: () => {},
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

test('release requests retry transient responses and respect rate-limit backoff', async t => {
  const f = fixture(t);
  const responses = [new Response('temporarily unavailable', { status: 503 }),
    new Response('rate limited', { status: 429, headers: { 'retry-after': '7' } })];
  f.state.intercept = () => responses.shift();
  assert.equal(await f.cache.release(), null);
  assert.deepEqual(f.state.delays, [1000, 7000]);
});

test('release requests stop after bounded retries and do not retry permission failures', async t => {
  const f = fixture(t);
  let attempts = 0;
  f.state.intercept = () => { attempts++; return new Response('unavailable', { status: 503 }); };
  await assert.rejects(f.cache.release(), /503/);
  assert.equal(attempts, 4);
  assert.deepEqual(f.state.delays, [1000, 2000, 4000]);
  f.state.delays = [];
  attempts = 0;
  f.state.intercept = () => { attempts++; return new Response('forbidden', { status: 403 }); };
  await assert.rejects(f.cache.release(), /403/);
  assert.equal(attempts, 1);
  assert.deepEqual(f.state.delays, []);
});

test('a lost upload response recreates the stream and verifies the existing winner', async t => {
  const f = fixture(t);
  const current = f.bottle('2');
  f.state.loseUploadReply = true;
  await f.cache.saveCache([current.directory], current.key);
  assert.equal(f.state.assets.length, 1);
  assert.deepEqual(f.state.delays, [1000]);
  assert.equal(await f.cache.restoreCache([path.join(f.root, 'restored-upload')], current.key), current.key);
});

test('a stale empty upload is recovered without losing the previous verified version', async t => {
  const f = fixture(t);
  const old = f.bottle('1');
  await f.cache.saveCache([old.directory], old.key);
  const current = f.bottle('2');
  f.state.assets.push({ id: ++f.state.next, name: current.name, state: 'starter', size: 0,
    created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), data: Buffer.alloc(0) });
  assert.equal(await f.cache.restoreCache([path.join(f.root, 'incomplete')], current.key), undefined);
  await f.cache.saveCache([current.directory], current.key);
  assert.deepEqual(f.state.deleted, [current.name, old.name]);
  assert.equal(await f.cache.restoreCache([path.join(f.root, 'recovered')], current.key), current.key);
});

test('recent, nonempty, or undated incomplete uploads cannot be deleted', async t => {
  const f = fixture(t);
  await f.cache.release(true);
  const current = f.bottle('2');
  for (const attributes of [
    { size: 0, created_at: new Date().toISOString() },
    { size: 1, created_at: '2000-01-01T00:00:00Z' },
    { size: 0 },
  ]) {
    f.state.assets = [{ id: ++f.state.next, name: current.name, state: 'starter', ...attributes }];
    await f.cache.removeAbandonedUpload(f.state.release, current.name);
  }
  assert.deepEqual(f.state.deleted, []);
});

test('an upload that completes during stale-upload inspection is preserved', async t => {
  const f = fixture(t);
  const current = f.bottle('2');
  await f.cache.saveCache([current.directory], current.key);
  const saved = f.state.assets[0];
  f.state.intercept = (endpoint, options) => {
    if (endpoint === 'releases/1/assets' && options.method === 'GET') {
      return Response.json([{ ...saved, data: undefined, state: 'starter', size: 0,
        created_at: '2000-01-01T00:00:00Z' }]);
    }
  };
  await f.cache.removeAbandonedUpload(f.state.release, current.name);
  assert.deepEqual(f.state.deleted, []);
  assert.equal(f.state.assets[0].state, 'uploaded');
});

test('interrupted downloads restart the archive before checksum verification', async t => {
  const f = fixture(t);
  const current = f.bottle('2');
  await f.cache.saveCache([current.directory], current.key);
  let interrupted = false;
  f.state.intercept = endpoint => {
    if (endpoint.startsWith('releases/assets/') && !interrupted) {
      interrupted = true;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
        pull(controller) { controller.error(new TypeError('terminated')); },
      }));
    }
  };
  const restored = path.join(f.root, 'resumed-download');
  assert.equal(await f.cache.restoreCache([restored], current.key), current.key);
  assert.ok(readBottle(restored, current.key));
  assert.deepEqual(f.state.delays, [1000]);
});

test('temporary test releases remain prereleases', async t => {
  const f = fixture(t, 'source-bottles-test-123');
  const release = await f.cache.release(true);
  assert.equal(release.prerelease, true);
  assert.equal(release.make_latest, 'false');
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
  assert.equal(asset.label, `xdebug@8.4-3.5.3_1.macos-14.arm64.debug-zts.${key.slice(-64, -52)}.tar`);
  assert.ok(asset.name.startsWith('xdebug@8.4-3.5.3_1.macos-14.arm64.debug-zts.'));
  assert.deepEqual(assetIdentity({ ...asset, label: 'Edited in GitHub' }),
    { version: inputs.version, group: family(inputs), key });
  assert.equal(assetIdentity({ name: asset.label }), undefined);
});

test('single-hyphen filenames preserve hyphenated package names and versions', () => {
  for (const version of ['2026-09-14', '1.2.3-rc-2', '3.5.3_1']) {
    const inputs = { formula: 'vendor/tap/lib-2-tools', version,
      environment: { arch: 'arm64', macos: '14', prefix: '/opt/homebrew' } };
    const key = keyFor(inputs);
    const asset = releaseAsset({ inputs, key });
    assert.ok(asset.label.startsWith(`lib-2-tools-${version}.macos-14.arm64.`));
    assert.deepEqual(assetIdentity(asset), { version, group: family(inputs), key });
  }
});

test('double-hyphen assets restore and are pruned after a single-hyphen replacement', async t => {
  const f = fixture(t);
  const old = f.bottle('1');
  await f.cache.saveCache([old.directory], old.key);
  const legacy = f.state.assets[0];
  const { group } = assetIdentity(legacy);
  legacy.name = `libxml2--1.macos-14.arm64.source-v1-${group}.${old.key.slice(-64)}.tar`;
  legacy.label = `libxml2--1.macos-14.arm64.${old.key.slice(-64, -52)}.tar`;
  assert.equal(await f.cache.restoreCache([path.join(f.root, 'double-hyphen')], old.key), old.key);
  const current = f.bottle('2');
  await f.cache.saveCache([current.directory], current.key);
  assert.deepEqual(f.state.deleted, [legacy.name]);
  assert.deepEqual(f.state.assets.map(asset => asset.name), [current.name]);
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
