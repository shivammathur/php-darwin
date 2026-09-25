const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { command, retryPolicy, httpError, readDiagnostic, transfers } = require('../../release/extension-transfers.cjs');
const { digest } = require('../../installer/install-extensions.cjs');

function fixture(t, failure) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-transfers-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'pack.tar.zst');
  fs.writeFileSync(file, 'verified archive');
  const github = new Map(), cloudflare = new Map(), cachedMissing = new Set(), calls = [], waits = [];
  const cacheMissing = ['cached-miss', 'cloudflare-response'].includes(failure);
  const run = async (program, args) => {
    calls.push({ program, args });
    if (program === 'gh' && args[0] === 'api') {
      return JSON.stringify(args.includes('--paginate') ? [[...github.values()]] : { id: 123 });
    }
    if (program === 'gh') {
      const body = fs.readFileSync(args[3]), name = path.basename(args[3]);
      github.set(name, { name, size: body.length, digest: `sha256:${digest(body)}` });
      if (failure === 'github-response') { failure = ''; throw httpError(503, 'Lost upload response'); }
    } else if (program === 'aws' && args.includes('put-object')) {
      if (failure === 'credentials') throw new Error('AccessDenied');
      const body = fs.readFileSync(args[args.indexOf('--body') + 1]);
      cloudflare.set(path.basename(args[args.indexOf('--key') + 1]), body);
      if (failure === 'cloudflare-response') { failure = ''; throw httpError(503, 'Lost upload response'); }
    } else if (program === 'aws') return JSON.stringify({ ContentLength: 16, ETag: 'test' });
    else if (program === 'curl') {
      const url = new URL(args.at(-1)), name = path.basename(url.pathname);
      if (failure === 'edge-503') { failure = ''; return '503'; }
      if (cacheMissing && !url.search && cachedMissing.has(name)) return '404';
      if (!cloudflare.has(name)) { cachedMissing.add(name); return '404'; }
      fs.writeFileSync(args[args.indexOf('--output') + 1], cloudflare.get(name));
      return '200';
    }
    return '';
  };
  const retry = retryPolicy({ wait: async ms => waits.push(ms) });
  const create = () => transfers({ directory, endpoint: 'https://test.invalid', env: { AWS_MAX_ATTEMPTS: '1' }, run, retry });
  return { file, calls, waits, github, cloudflare, create };
}
test('resuming publication reuses matching GitHub digests and fully verified Cloudflare bytes', async t => {
  const f = fixture(t), first = f.create();
  await first.github(f.file, true); await first.mirror(f.file, true);
  assert.equal(first.report.github_uploaded, 1); assert.equal(first.report.cloudflare_uploaded, 1);
  const before = f.calls.length, resumed = f.create();
  await resumed.github(f.file, true); await resumed.mirror(f.file, true);
  assert.equal(resumed.report.github_reused, 1); assert.equal(resumed.report.cloudflare_reused, 1);
  assert.ok(!f.calls.slice(before).some(c => c.args.includes('put-object') || c.args.includes('upload')));
  const reads = f.calls.slice(before).filter(c => c.program === 'curl');
  assert.equal(reads.length, 1);
  assert.equal(new URL(reads[0].args.at(-1)).search, '');
});
test('verification after a new immutable upload bypasses a cached missing response', async t => {
  const f = fixture(t, 'cached-miss'), transfer = f.create();
  await transfer.mirror(f.file, true);
  assert.equal(transfer.report.cloudflare_uploaded, 1);
  const reads = f.calls.filter(c => c.program === 'curl');
  assert.equal(reads.length, 2);
  assert.equal(new URL(reads[0].args.at(-1)).search, '');
  assert.match(new URL(reads[1].args.at(-1)).search, /^\?verify=\d+$/);
  assert.deepEqual(f.waits, []);
});
for (const backend of ['github', 'cloudflare']) {
  test(`a lost ${backend} upload response reconciles remote bytes before another write`, async t => {
    const f = fixture(t, `${backend}-response`), transfer = f.create();
    await transfer[backend === 'github' ? 'github' : 'mirror'](f.file, true);
    assert.equal(f.calls.filter(c => c.args.includes('upload') || c.args.includes('put-object')).length, 1);
    assert.deepEqual(f.waits, [5000]);
  });
}
test('a transient edge failure retries once and does not reupload a valid object', async t => {
  const f = fixture(t, 'edge-503');
  f.cloudflare.set(path.basename(f.file), fs.readFileSync(f.file));
  await f.create().mirror(f.file, true);
  assert.deepEqual(f.waits, [5000]);
  assert.ok(!f.calls.some(c => c.args.includes('put-object')));
});
test('corrupt immutable objects and credential failures stop immediately without retries or replacement', async t => {
  for (const failure of ['checksum', 'credentials']) {
    const f = fixture(t, failure);
    if (failure === 'checksum') f.cloudflare.set(path.basename(f.file), Buffer.from('corrupt'));
    await assert.rejects(f.create().mirror(f.file, true), /Checksum|AccessDenied/);
    assert.deepEqual(f.waits, []);
    assert.equal(f.calls.filter(c => c.args.includes('put-object')).length, failure === 'checksum' ? 0 : 1);
  }
});
test('mutable manifests are replaced only when their bytes differ', async t => {
  const f = fixture(t), transfer = f.create();
  f.cloudflare.set(path.basename(f.file), Buffer.from('previous'));
  await transfer.mirror(f.file, false);
  await transfer.mirror(f.file, false);
  assert.equal(f.calls.filter(c => c.args.includes('put-object')).length, 1);
  assert.ok(f.calls.filter(c => c.program === 'curl').every(c => new URL(c.args.at(-1)).search.startsWith('?verify=')));
});
test('recovery is bounded per operation and by a shared job budget', async () => {
  const waits = [], retry = retryPolicy({ budget: 2, wait: async ms => waits.push(ms) });
  let calls = 0;
  await assert.rejects(retry('persistent outage', async () => { calls++; throw httpError(503, 'outage'); }));
  assert.equal(calls, 2);
  let attempts = 0;
  await retry('temporary outage', async () => { if (!attempts++) throw httpError(502, 'outage'); });
  calls = 0;
  await assert.rejects(retry('budget exhausted', async () => { calls++; throw httpError(503, 'outage'); }));
  assert.equal(calls, 1);
  assert.deepEqual(waits, [5000, 5000]);
  for (const status of [400, 401, 403, 404, 422]) assert.equal(httpError(status, 'test').transient, false);
});
test('process diagnostics distinguish retryable service errors from permanent failures', async () => {
  for (const [message, transient] of [['HTTP 503: service unavailable', true], ['AccessDenied: no permission', false],
    ['Connection was closed before we received a valid response from endpoint URL', true],
    ['InternalError: internal connectivity issue', true], ['SSL certificate verification failed', false]]) {
    await assert.rejects(command(process.execPath, ['-e', 'process.stderr.write(process.argv[1]);process.exit(1)', message]),
      error => Boolean(error.transient) === transient && error.message.includes(message));
  }
});
test('a real stalled HTTP body retains timing and partial-byte diagnostics without response secrets', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-read-diagnostic-'));
  const headers = path.join(directory, 'headers'), downloaded = path.join(directory, 'body');
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Length': '100', 'CF-Ray': '123456-IAD', 'CF-Cache-Status': 'MISS',
      'Set-Cookie': 'secret-cookie', Location: 'https://example.invalid/?token=secret' });
    response.write('partial');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await assert.rejects(command('curl', ['-q', '-sS', '--max-time', '0.3', '--output', downloaded, '--dump-header', headers,
    '--write-out', '%{http_code}\n%{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total} %{size_download} %{http_version} %{remote_ip}',
    `http://127.0.0.1:${server.address().port}`]), error => {
    assert.ok(error.transient);
    assert.ok(!Object.keys(error).includes('output'));
    const diagnostic = readDiagnostic(error.output, headers, downloaded);
    assert.equal(diagnostic.http_status, 200);
    assert.equal(diagnostic.saved_bytes, 7);
    assert.equal(diagnostic.received_bytes, 7);
    assert.ok(diagnostic.total_seconds >= 0.29);
    assert.ok(diagnostic.first_byte_seconds < diagnostic.total_seconds);
    assert.deepEqual(diagnostic.headers, { 'content-length': '100', 'cf-ray': '123456-IAD', 'cf-cache-status': 'MISS' });
    assert.doesNotMatch(JSON.stringify(diagnostic), /secret|token|cookie|example/);
    return true;
  });
});
test('diagnostics use only the final HTTP response and reject untrusted header characters', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-read-headers-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const headers = path.join(directory, 'headers');
  fs.writeFileSync(headers, 'HTTP/1.1 302 Found\r\nCF-Ray: earlier-IAD\r\nLocation: secret\r\n\r\n' +
    'HTTP/2 200\r\nContent-Length: 7\r\nCF-Ray: bad\u001b[31mheader\r\n');
  assert.deepEqual(readDiagnostic('200', headers, path.join(directory, 'missing')),
    { http_status: 200, saved_bytes: 0, headers: { 'content-length': '7' } });
});
