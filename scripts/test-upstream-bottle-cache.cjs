const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { prefetch, matrix, publish, publicURL, key, validate } = require('./upstream-bottle-cache.cjs');
const bytes = Buffer.from('a verified bottle archive');
const digest = crypto.createHash('sha256').update(bytes).digest('hex');
function record(overrides = {}) {
  return { formula: 'gcc', version: '16.2.0', tag: 'sequoia', sha256: digest,
    url: `https://ghcr.io/v2/homebrew/core/gcc/blobs/sha256:${digest}`, ...overrides };
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bottle-cache-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { record: record({ cached_download: path.join(directory, 'downloads', 'gcc.tar.gz') }),
    directory, missFile: path.join(directory, 'misses.jsonl'), log: () => {}, warn: () => {} };
}
test('verified Cloudflare bytes populate the exact Homebrew path without upstream transfer', async t => {
  const f = fixture(t);
  await prefetch([f.record], { ...f, download: async (url, file) => {
    assert.equal(url, publicURL(f.record)); fs.writeFileSync(file, bytes); return 200;
  } });
  assert.deepEqual(fs.readFileSync(f.record.cached_download), bytes);
  assert.equal(fs.existsSync(f.missFile), false);
  assert.deepEqual(fs.readdirSync(path.dirname(f.record.cached_download)), ['gcc.tar.gz']);
});
test('404, outage, and corrupt bottles queue exact identities without installing partial data', async t => {
  for (const failure of ['miss', 'outage', 'corrupt']) {
    const f = fixture(t);
    await prefetch([f.record], { ...f, download: async (url, file) => {
      fs.writeFileSync(file, 'incomplete');
      if (failure === 'outage') throw new Error('network unavailable');
      return failure === 'miss' ? 404 : 200;
    } });
    assert.equal(fs.existsSync(f.record.cached_download), false);
    assert.deepEqual(fs.readdirSync(path.dirname(f.record.cached_download)), []);
    assert.equal(JSON.parse(fs.readFileSync(f.missFile)).sha256, digest);
    assert.equal(JSON.parse(fs.readFileSync(f.missFile)).cached_download, undefined);
  }
});
test('valid local downloads are preserved and an uncached revision is queued', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.record.cached_download));
  fs.writeFileSync(f.record.cached_download, bytes);
  await prefetch([f.record], { ...f, download: async (url, file, options) => {
    assert.equal(options.head, true); assert.equal(file, os.devNull); return 404;
  } });
  assert.deepEqual(fs.readFileSync(f.record.cached_download), bytes);
  assert.equal(JSON.parse(fs.readFileSync(f.missFile)).sha256, digest);
});
test('one matrix job per dependency deduplicates variants but retains new digests and platforms', () => {
  const otherDigest = 'a'.repeat(64);
  const next = record({ sha256: otherDigest, tag: 'arm64_sonoma',
    url: `https://ghcr.io/v2/homebrew/core/gcc/blobs/sha256:${otherDigest}` });
  const result = matrix([record(), record(), next]);
  assert.equal(result.include.length, 1);
  assert.equal(result.include[0].bottles.length, 2);
  assert.notEqual(key(record()), key(next));
});
test('untrusted records cannot choose upload paths or authenticated network destinations', () => {
  for (const bad of [ { sha256: '../outside' }, { formula: '../gcc' }, { tag: '' },
    { url: 'https://example.com/bottle' }, { url: record().url + '?token=secret' },
    { url: record().url.replace('homebrew/core', 'untrusted/tap') },
    { url: record().url.replace(digest, 'b'.repeat(64)) } ]) {
    assert.throws(() => validate(record(bad)));
  }
});
const env = { CF_R2_AWS_S3_ENDPOINT: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`,
  CF_R2_AWS_ACCESS_KEY_ID: 'test-access', CF_R2_AWS_SECRET_ACCESS_KEY: 'test-secret' };
test('publish checks upstream and public download hashes and uses only the bottle prefix', async () => {
  let uploaded = false, reads = 0;
  const results = await publish([record()], { env, download: async (url, file, options) => {
    reads++;
    if (url.startsWith('https://ghcr.io/')) assert.equal(options.upstream, true);
    else if (!uploaded) return 404;
    fs.writeFileSync(file, bytes); return 200;
  }, run: async (program, args, options) => {
    assert.equal(program, 'aws');
    assert.ok(args.includes(`s3://php-darwin/${key(record())}`));
    assert.equal(options.env.AWS_MAX_ATTEMPTS, '1');
    assert.equal(options.env.AWS_ACCESS_KEY_ID, env.CF_R2_AWS_ACCESS_KEY_ID);
    uploaded = true;
  } });
  assert.equal(reads, 3); assert.equal(results[0].result, 'uploaded');
});
test('publication refuses corrupt upstream data and a corrupt public readback', async () => {
  for (const corruptUpstream of [true, false]) {
    let uploaded = false;
    await assert.rejects(publish([record()], { env, download: async (url, file) => {
      if (!url.startsWith('https://ghcr.io/') && !uploaded) return 404;
      fs.writeFileSync(file, (url.startsWith('https://ghcr.io/') && !corruptUpstream) ? bytes : 'corrupt');
      return 200;
    }, run: async () => { assert.equal(corruptUpstream, false); uploaded = true; } }),
    corruptUpstream ? /Invalid upstream/ : /verification failed/);
  }
});
test('existing verified objects require no upstream request or upload', async () => {
  const result = await publish([record()], { env, download: async (url, file) => {
    assert.equal(url, publicURL(record())); fs.writeFileSync(file, bytes); return 200;
  }, run: async () => { assert.fail('unexpected upload'); } });
  assert.equal(result[0].result, 'existing');
});
