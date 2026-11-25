const {test} = require('node:test');
const assert = require('node:assert/strict');
const {githubReader} = require('../../lib/github-read.cjs');
const route = 'repos/shivammathur/php-darwin/actions/runs/123';
const http = (status, body = {}, headers = {}) => `HTTP/2.0 ${status} Test\n${Object.entries({'Content-Type': 'application/json', ...headers})
  .map(([name, value]) => `${name}: ${value}\r\n`).join('')}\r\n${status === 304 ? '' : JSON.stringify(body)}`;
function fixture(replies, options = {}) {
  const calls = [], waits = [];
  const read = githubReader({run: async args => {
    calls.push(args);
    const reply = replies.shift();
    assert.notEqual(reply, undefined, 'unexpected API request');
    if (reply instanceof Error) throw reply;
    return reply;
  }, wait: async ms => waits.push(ms), warn: () => {}, ...options});
  return {read, calls, waits};
}
test('reads recover transport errors and 503 responses within three attempts', async () => {
  const f = fixture([new Error('connection reset'), Object.assign(new Error('gh exited 1'), {
    stdout: http(503, {message: 'unavailable'}),
  }), http(200, {id: 123})]);
  assert.deepEqual(JSON.parse(await f.read(['api', route])), {id: 123});
  assert.deepEqual(f.waits, [1000, 2000]);
});
test('primary quota honors the later Retry-After and reset headers', async () => {
  const f = fixture([http(403, {message: 'API rate limit exceeded'}, {
    'Retry-After': '120', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': Math.ceil(Date.now() / 1000) + 300,
  }), http(200)]);
  await f.read(['api', route]);
  assert.ok(f.waits[0] >= 300000 && f.waits[0] <= 302000);
  assert.equal(f.calls.length, 2, 'complete headers do not need another quota lookup');
});
test('missing reset headers use the quota endpoint without reducing Retry-After', async () => {
  const f = fixture([http(403, {message: 'API rate limit exceeded'}, {'Retry-After': '400'}),
    JSON.stringify({resources: {core: {remaining: 0, reset: Math.floor(Date.now() / 1000) + 180}}}), http(200)]);
  await f.read(['api', route]);
  assert.deepEqual(f.calls[1], ['api', 'rate_limit']);
  assert.deepEqual(f.waits, [400000]);
});
test('secondary limits wait at least a minute and ordinary authorization failures are not retried', async () => {
  const f = fixture([http(429, {message: 'secondary rate limit'}, {'Retry-After': '5'}), http(200)]);
  await f.read(['api', route]);
  assert.deepEqual(f.waits, [60000]);
  for (const status of [401, 403, 404, 422]) {
    const denied = fixture([http(status, {message: 'Denied'})]);
    await assert.rejects(denied.read(['api', route]), new RegExp(`HTTP ${status}`));
    assert.deepEqual(denied.waits, []);
  }
});
test('bounded retries stop at three attempts, the shared budget, or an excessive reset delay', async () => {
  const f = fixture(Array.from({length: 4}, () => http(502)), {budget: 2});
  await assert.rejects(f.read(['api', route]), /HTTP 502/);
  await assert.rejects(f.read(['api', route]), /HTTP 502/);
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.waits, [1000, 2000]);
  const long = fixture([http(429, {}, {'Retry-After': '3601'})]);
  await assert.rejects(long.read(['api', route]), /rate limit/);
  assert.deepEqual(long.waits, [], 'never retry earlier than the server permits');
});
test('paginated polls revalidate every page and retain pagination on 304', async () => {
  const next = `https://api.github.com/${route}?page=2`;
  const f = fixture([http(200, {workflow_runs: [1]}, {ETag: '"one"', Link: `<${next}>; rel="next"`}),
    http(200, {workflow_runs: [2]}, {ETag: '"two"'}), http(304), http(304)]);
  const args = ['api', '--paginate', '--slurp', route];
  assert.equal(await f.read(args), '[{"workflow_runs":[1]},{"workflow_runs":[2]}]');
  assert.equal(await f.read(args), '[{"workflow_runs":[1]},{"workflow_runs":[2]}]');
  assert.ok(f.calls[2].includes('If-None-Match: "one"'));
  assert.ok(f.calls[3].includes('If-None-Match: "two"'));
});
test('pagination rejects foreign origins and loops', async () => {
  for (const link of [`https://example.invalid/private`, route]) {
    const f = fixture([http(200, {}, {Link: `<${link}>; rel="next"`})]);
    await assert.rejects(f.read(['api', '--paginate', '--slurp', route]), /pagination/);
    assert.equal(f.calls.length, 1);
  }
});
test('uncertain workflow dispatch is submitted only once', async () => {
  const f = fixture([new Error('connection lost after submission')]);
  await assert.rejects(f.read(['workflow', 'run', 'update-dependencies.yml']), /connection lost/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.waits, []);
});
