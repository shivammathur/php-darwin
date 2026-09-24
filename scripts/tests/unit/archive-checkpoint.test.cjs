const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { command } = require('../../cache/source-bottle-cache.cjs');
const { checkpointKey, identity, kegDigest, verifyCheckpoint, restoreCheckpoint, stageCheckpoint, pruneCheckpoints } = require('../../cache/archive-checkpoint.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inputs = { schema: 1, php: '8.6', arch: 'arm64', build: 'debug', ts: 'zts',
    revision: 'a'.repeat(40), phpCommit: 'b'.repeat(40), extensionsCommit: 'c'.repeat(40),
    platform: { compiler: 'clang-1', sdk: '14', macos: '14' }, packages: [{ name: 'libxml2', version: '1', payload: 'abc' }] };
  const item = identity(inputs);
  const builds = path.join(root, 'builds');
  const staged = path.join(root, 'staged');
  fs.mkdirSync(builds);
  const bytes = 'verified native archive fixture';
  fs.writeFileSync(path.join(builds, item.archive), bytes);
  fs.writeFileSync(path.join(builds, item.archive + '.sha256'), crypto.createHash('sha256').update(bytes).digest('hex') + '  ' + item.archive + '\n');
  fs.writeFileSync(path.join(builds, item.metadata), JSON.stringify({ archive: item.archive,
    php_version: inputs.php, architecture: inputs.arch, build: inputs.build, thread_safety: inputs.ts,
    homebrew_php_commit: inputs.phpCommit, homebrew_extensions_commit: inputs.extensionsCommit }));
  stageCheckpoint(inputs, builds, staged);
  const zip = path.join(root, 'artifact.zip');
  command('zip', ['-q', zip, ...item.files], { cwd: staged });
  const data = fs.readFileSync(zip);
  const artifact = { id: 1, name: item.name, digest: 'sha256:' + crypto.createHash('sha256').update(data).digest('hex'),
    workflow_run: { id: 10, head_sha: inputs.revision } };
  const warnings = [];
  const cache = { warn: value => warnings.push(value), api: async (endpoint, options) => {
    if (endpoint.startsWith('actions/artifacts?')) return { artifacts: [artifact] };
    return options.consume(new Response(data));
  } };
  return { root, inputs, item, builds, staged, zip, artifact, warnings, cache };
}

test('archive fingerprints cover variants, workflow, source, dependency bytes and toolchain', () => {
  const inputs = { php: '8.6', arch: 'arm64', build: 'debug', ts: 'zts', revision: 'a',
    phpCommit: 'b', extensionsCommit: 'c', platform: { compiler: 'clang-1' }, packages: [{ payload: 'a' }] };
  for (const key of Object.keys(inputs)) assert.notEqual(checkpointKey(inputs), checkpointKey({ ...inputs, [key]: 'changed' }));
  assert.equal(checkpointKey({ a: 1, b: { c: 2, d: 3 } }), checkpointKey({ b: { d: 3, c: 2 }, a: 1 }));
});

test('installed keg bytes and links invalidate checkpoints, receipt and SBOM timestamps do not', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keg-fingerprint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'library'), 'one');
  fs.writeFileSync(path.join(root, 'INSTALL_RECEIPT.json'), '{"time":1}');
  fs.writeFileSync(path.join(root, 'sbom.spdx.json'), '{"creationInfo":{"created":"2026-09-14T06:37:41Z"}}');
  fs.symlinkSync('library', path.join(root, 'link'));
  const baseline = kegDigest(root);
  fs.writeFileSync(path.join(root, 'INSTALL_RECEIPT.json'), '{"time":2}');
  fs.writeFileSync(path.join(root, 'sbom.spdx.json'), '{"creationInfo":{"created":"2026-09-14T07:08:37Z"}}');
  assert.equal(kegDigest(root), baseline);
  fs.writeFileSync(path.join(root, 'library'), 'two');
  assert.notEqual(kegDigest(root), baseline);
  fs.writeFileSync(path.join(root, 'library'), 'one');
  fs.unlinkSync(path.join(root, 'link'));
  fs.symlinkSync('other', path.join(root, 'link'));
  assert.notEqual(kegDigest(root), baseline);
});

test('a checkpoint from a previous run restores all verified variant files', async t => {
  const f = fixture(t);
  const destination = path.join(f.root, 'restored');
  const result = await restoreCheckpoint(f.cache, f.inputs, destination, { temporary: f.root });
  assert.equal(result.hit, true);
  assert.deepEqual(verifyCheckpoint(destination, f.inputs), f.item);
});

test('archive or metadata corruption is rejected before reuse', async t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.builds, f.item.archive), 'corruption');
  assert.throws(() => verifyCheckpoint(f.builds, f.inputs), /mismatch/);
  fs.appendFileSync(path.join(f.staged, f.item.metadata), ' ');
  assert.throws(() => verifyCheckpoint(f.staged, f.inputs), /mismatch/);
  f.artifact.digest = 'sha256:' + '0'.repeat(64);
  const result = await restoreCheckpoint(f.cache, f.inputs, path.join(f.root, 'restore'), { temporary: f.root });
  assert.equal(result.hit, false);
  assert.match(f.warnings[0], /digest mismatch/);
});

test('changed inputs, expired artifacts, and explicit rebuilds cannot hit a checkpoint', async t => {
  const f = fixture(t);
  for (const inputs of [{ ...f.inputs, phpCommit: 'd'.repeat(40) }, f.inputs]) {
    if (inputs === f.inputs) f.artifact.expired = true;
    assert.equal((await restoreCheckpoint(f.cache, inputs, path.join(f.root, 'miss'), { temporary: f.root })).hit, false);
  }
  f.cache.api = async () => { throw new Error('must not perform a lookup'); };
  assert.equal((await restoreCheckpoint(f.cache, f.inputs, f.builds, { reuse: false })).hit, false);
  assert.deepEqual(f.warnings, []);
});

test('checkpoint cleanup waits for upload and preserves other variants and architectures', async t => {
  const f = fixture(t);
  const artifacts = [
    { id: 1, name: f.item.prefix + 'old' },
    { id: 2, name: identity({ ...f.inputs, ts: 'nts' }).name },
    { id: 3, name: identity({ ...f.inputs, arch: 'x86_64' }).name },
  ];
  const deleted = [];
  const cache = { api: async (endpoint, options = {}) => {
    if (options.method === 'DELETE') deleted.push(endpoint);
    else {
      assert.equal(endpoint, 'actions/runs/10/artifacts?per_page=100&page=1');
      return { artifacts };
    }
  } };
  await assert.rejects(pruneCheckpoints(cache, f.item, '10'), /not uploaded/);
  assert.deepEqual(deleted, []);
  artifacts.push({ id: 4, name: f.item.name });
  await pruneCheckpoints(cache, f.item, '10');
  assert.deepEqual(deleted, ['actions/artifacts/1']);
});
