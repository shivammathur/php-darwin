const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { r2, fingerprint } = require('../../lib/r2.cjs');
const { retryPolicy } = require('../../release/extension-transfers.cjs');
const { fixture, info } = require('../helpers/r2-fixture.cjs');
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'archive'), bytes = Buffer.from('authenticated archive');
  fs.writeFileSync(file, bytes);
  const mock = fixture(), waits = [], retry = retryPolicy({ wait: async ms => waits.push(ms) });
  const store = run => r2({ endpoint: 'https://fixture.invalid', env: {}, run: run || mock.run, retry });
  return { directory, file, bytes, mock, waits, store };
}
test('R2 checks origin metadata, sends Content-MD5, confirms the commit, and reuses verified objects', async t => {
  const f = setup(t), store = f.store();
  assert.equal((await store.ensure(f.file, 'php-8.7/archive')).uploaded, true);
  assert.deepEqual(f.mock.calls.map(c => c.operation), ['head-object', 'put-object', 'head-object']);
  assert.equal((await store.ensure(f.file, 'php-8.7/archive')).uploaded, false);
  assert.equal(f.mock.calls.filter(c => c.operation === 'put-object').length, 1);
  assert.deepEqual(f.waits, []);
});
test('successful-looking missing uploads are retried, and lost replies reuse the committed object', async t => {
  for (const mode of ['missing', 'lost', 'post-head']) {
    const f = setup(t);
    let puts = 0, postFailure = mode === 'post-head';
    const store = f.store(async (program, args, options) => {
      if (args.includes('put-object')) {
        puts++;
        if (mode === 'missing' && puts < 3) return JSON.stringify({ ETag: info(f.bytes).ETag });
        const result = await f.mock.run(program, args, options);
        if (mode === 'lost') throw new Error('Lost successful upload reply');
        return result;
      }
      if (puts && postFailure) { postFailure = false; throw new Error('Origin timeout'); }
      return f.mock.run(program, args, options);
    });
    await store.ensure(f.file, 'key');
    assert.equal(puts, mode === 'missing' ? 3 : 1);
    assert.deepEqual(f.waits, mode === 'missing' ? [1000, 2000] : [1000]);
  }
});
test('all metadata and upload errors are bounded; uncertain reads never authorize a write', async t => {
  for (const mode of ['head-denied', 'head-invalid', 'put-denied', 'uncommitted']) {
    const f = setup(t); let writes = 0, heads = 0;
    const store = f.store(async (program, args, options) => {
      if (args.includes('head-object')) {
        heads++;
        if (mode === 'head-denied') throw new Error('An error occurred (403) when calling the HeadObject operation: Forbidden');
        if (mode === 'head-invalid') return '{}';
      } else if (args.includes('put-object')) {
        writes++;
        if (mode === 'put-denied') throw new Error('AccessDenied');
        return JSON.stringify({ ETag: info(f.bytes).ETag });
      }
      return f.mock.run(program, args, options);
    });
    await assert.rejects(store.ensure(f.file, 'key'));
    assert.equal(writes, mode.startsWith('head-') ? 0 : 3);
    assert.equal(heads, mode === 'uncommitted' ? 6 : 3);
    assert.deepEqual(f.waits, [1000, 2000]);
  }
});
test('legacy multipart bytes are SHA256 verified through the origin without rewriting them', async t => {
  const f = setup(t); let gets = 0;
  const object = { ...info(f.bytes), ETag: `"${'a'.repeat(32)}-8"`, Metadata: {} };
  const store = f.store(async (_program, args) => {
    if (args.includes('head-object')) return JSON.stringify(object);
    assert.ok(args.includes('get-object')); gets++;
    assert.equal(args[args.indexOf('--if-match') + 1], object.ETag);
    fs.writeFileSync(args.at(-1), f.bytes);
    return JSON.stringify(object);
  });
  assert.equal((await store.ensure(f.file, 'legacy')).uploaded, false);
  assert.equal(gets, 1);
});
test('matching size and client metadata cannot disguise corrupt stored bytes', async t => {
  const f = setup(t);
  f.mock.objects.set('key', Buffer.alloc(f.bytes.length, 'x'));
  await f.store().ensure(f.file, 'key');
  assert.deepEqual(f.mock.objects.get('key'), f.bytes);
  assert.equal(f.mock.calls.filter(c => c.operation === 'put-object').length, 1);
});
test('direct restore verifies SHA256 and treats only a confirmed missing object as absent', async t => {
  const f = setup(t), store = f.store(), file = path.join(f.directory, 'restored');
  const expected = await fingerprint(f.file);
  assert.equal(await store.restore('key', file, expected.sha256), false);
  f.mock.objects.set('key', f.bytes);
  assert.equal(await store.restore('key', file, expected.sha256), true);
  assert.deepEqual(fs.readFileSync(file), f.bytes);
  assert.equal(await store.restore('key', file, 'a'.repeat(64)), false);
});
