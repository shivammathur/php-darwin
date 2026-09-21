const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { prefetch, matrix, publish, publicURL, key, validate, exec } = require('../../cache/upstream-bottle-cache.cjs');
const { retryPolicy, command } = require('../../release/extension-transfers.cjs');
const { fixture: r2Fixture } = require('../helpers/r2-fixture.cjs');
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
    retry: retryPolicy({ wait: async () => {} }), directory, missFile: path.join(directory, 'misses.jsonl'), log: () => {}, warn: () => {} };
}
test('tools entry point loads the resolver without partially initialized cache exports', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, 'brew'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o755 });
  const result = spawnSync(process.execPath, [path.join(__dirname, '../../cache/upstream-bottle-cache.cjs'), 'tools'], {
    env: { ...process.env, PATH: `${f.directory}${path.delimiter}${process.env.PATH}` }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, '');
});
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
function publishing(existing = false) {
  const origin = r2Fixture();
  if (existing) origin.objects.set(key(record()), bytes);
  const requests = [], waits = [];
  const download = async (url, file, options) => {
    requests.push(url);
    if (url.startsWith('https://ghcr.io/')) assert.equal(options.upstream, true);
    else assert.ok(origin.objects.has(key(record())), 'never request the public URL before the object exists');
    fs.writeFileSync(file, bytes); return 200;
  };
  const options = { env, run: origin.run, download, retry: retryPolicy({ wait: async ms => waits.push(ms) }) };
  return { origin, requests, waits, options };
}
test('publication checks R2 directly, verifies upstream and public bytes, and uses a checksum-validated PUT', async () => {
  const f = publishing();
  const results = await publish([record()], f.options);
  assert.equal(f.requests.length, 2);
  assert.equal(results[0].result, 'uploaded');
  assert.equal(f.origin.calls.filter(c => c.operation === 'put-object').length, 1);
  assert.ok(f.origin.calls.every(c => c.key === key(record())));
});
test('publication refuses corrupt upstream data and corrupt public readback', async () => {
  for (const corruptUpstream of [true, false]) {
    const f = publishing();
    await assert.rejects(publish([record()], { ...f.options, download: async (url, file) => {
      fs.writeFileSync(file, url.startsWith('https://ghcr.io/') && !corruptUpstream ? bytes : 'corrupt');
      return 200;
    } }), corruptUpstream ? /Invalid upstream/ : /verification failed/);
    assert.equal(f.origin.calls.filter(c => c.operation === 'put-object').length, corruptUpstream ? 0 : 1);
  }
});
test('existing verified objects require no upstream request or upload', async () => {
  const f = publishing(true);
  const result = await publish([record()], f.options);
  assert.equal(result[0].result, 'existing');
  assert.deepEqual(f.requests, [publicURL(record())]);
  assert.deepEqual(f.origin.calls.map(c => c.operation), ['head-object', 'get-object']);
});
test('source mirror public failures retry reads without uploads and remain bounded', async () => {
  for (const mode of ['recover', 'timeout', 'forbidden']) {
    const f = publishing(true); let reads = 0;
    const work = publish([record()], { ...f.options, download: async (_url, file) => {
      reads++;
      if (mode === 'timeout') throw new Error('body timeout');
      if (mode === 'forbidden') return 403;
      if (reads < 3) return reads === 1 ? 524 : 503;
      fs.writeFileSync(file, bytes); return 200;
    } });
    if (mode === 'recover') assert.equal((await work)[0].result, 'existing');
    else await assert.rejects(work, mode === 'timeout' ? /body timeout/ : /403/);
    assert.equal(reads, 3);
    assert.deepEqual(f.waits, [1000, 2000]);
    assert.ok(!f.origin.calls.some(c => c.operation === 'put-object'));
  }
});
test('both curl process adapters retain every failure for bounded retry', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, 'curl'), '#!/bin/sh\nprintf "000"\nexit "$1"\n', { mode: 0o755 });
  const options = { env: { ...process.env, PATH: `${f.directory}${path.delimiter}${process.env.PATH}` } };
  for (const run of [exec, command]) for (const code of [16, 35, 58, 60, 77, 3, 23]) {
    await assert.rejects(run('curl', [String(code)], options), error => {
      assert.match(error.message, new RegExp(`curl exited ${code}`));
      assert.equal(error.output, '000');
      return true;
    });
  }
  for (const mode of ['recover', 'persistent', 'certificate']) {
    const p = publishing(true); let reads = 0;
    const work = publish([record()], { ...p.options, download: async (_url, file) => {
      if (++reads < 3 || mode !== 'recover') await exec('curl', [mode === 'certificate' ? '60' : '35'], options);
      fs.writeFileSync(file, bytes); return 200;
    } });
    if (mode === 'recover') assert.equal((await work)[0].result, 'existing');
    else await assert.rejects(work, /curl exited/);
    assert.equal(reads, 3);
    assert.deepEqual(p.waits, [1000, 2000]);
    assert.ok(!p.origin.calls.some(c => c.operation === 'put-object'));
  }
});
test('upstream source downloads share the retry budget before one verified upload', async () => {
  const f = publishing(); let upstreamReads = 0;
  const result = await publish([record()], { ...f.options, download: async (url, file, options) => {
    if (url.startsWith('https://ghcr.io/')) {
      if (++upstreamReads === 1) throw new Error('TLS reset');
      if (upstreamReads === 2) return 503;
    }
    return f.options.download(url, file, options);
  } });
  assert.equal(result[0].result, 'uploaded');
  assert.equal(upstreamReads, 3);
  assert.equal(f.origin.calls.filter(c => c.operation === 'put-object').length, 1);
  assert.deepEqual(f.waits, [1000, 2000]);
});
test('public 404 after a verified origin upload retries delivery without uploading again', async () => {
  const f = publishing();
  await assert.rejects(publish([record()], { ...f.options, download: async (url, file, options) => {
    if (!url.startsWith('https://ghcr.io/')) return 404;
    return f.options.download(url, file, options);
  } }), /verification failed: gcc HTTP 404.*R2 origin verified/);
  assert.equal(f.origin.calls.filter(c => c.operation === 'put-object').length, 1);
  assert.ok(f.origin.objects.has(key(record())));
  assert.deepEqual(f.waits, [1000, 2000]);
});
test('R2 metadata retries malformed responses without treating them as missing objects', async () => {
  for (const recover of [true, false]) {
    const f = publishing(true); let reads = 0;
    const work = publish([record()], { ...f.options, run: async (program, args, options) => {
      if (args.includes('head-object') && (++reads < 3 || !recover)) return '{';
      return f.origin.run(program, args, options);
    } });
    if (recover) assert.equal((await work)[0].result, 'existing');
    else await assert.rejects(work, SyntaxError);
    assert.equal(reads, 3);
    assert.ok(!f.origin.calls.some(c => c.operation === 'put-object'));
  }
});
test('upload permission failures are bounded and a lost successful reply reuses the committed object', async () => {
  for (const mode of ['lost', 'permission', 'corrupt-readback']) {
    const f = publishing(); let uploads = 0, readbacks = 0;
    const work = publish([record()], { ...f.options, download: async (url, file, options) => {
      if (!url.startsWith('https://ghcr.io/') && mode === 'corrupt-readback' && ++readbacks < 3) {
        fs.writeFileSync(file, 'corrupt'); return 200;
      }
      return f.options.download(url, file, options);
    }, run: async (program, args, options) => {
      if (args.includes('put-object')) {
        uploads++;
        if (mode === 'permission') throw new Error('AccessDenied');
        const result = await f.origin.run(program, args, options);
        if (mode === 'lost') throw new Error('lost successful upload reply');
        return result;
      }
      return f.origin.run(program, args, options);
    } });
    if (mode === 'permission') { await assert.rejects(work, /AccessDenied/); assert.equal(uploads, 3); }
    else { assert.equal((await work)[0].result, 'uploaded'); assert.equal(uploads, 1); }
    assert.deepEqual(f.waits, mode === 'lost' ? [1000] : [1000, 2000]);
  }
});
