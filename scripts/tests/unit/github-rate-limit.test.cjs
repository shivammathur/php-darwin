const {test} = require('node:test');
const assert = require('node:assert/strict');
const {retryAfter, rateLimitError} = require('../../lib/github-rate-limit.cjs');

test('primary quota recovery honors the later reset or Retry-After like Homebrew', () => {
  const now = 1800000000000;
  const limited = after => new Response('', {status: 403, headers: {
    'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 900), 'retry-after': after,
  }});
  assert.equal(retryAfter(limited('7'), now), 901000);
  assert.equal(retryAfter(limited('1200'), now), 1200000);
  assert.equal(retryAfter(limited(new Date(now + 1200000).toUTCString()), now), 1200000);
  assert.equal(retryAfter(limited('invalid'), now), 901000);
  assert.equal(retryAfter(new Response('', {status: 503, headers: {'retry-after': '7'}}), now), 7000);
});

test('secondary limits use Homebrew\'s one-minute minimum without treating ordinary forbidden responses as quotas', async () => {
  for (const after of ['0', '7', '120']) {
    const error = await rateLimitError(new Response('secondary rate limit', {status: 403, headers: {'retry-after': after}}));
    assert.equal(error.retryAfterMs, Math.max(60000, Number(after) * 1000));
    assert.equal(error.primary, false);
  }
  assert.equal(await rateLimitError(new Response('Forbidden', {status: 403})), undefined);
  const primary = await rateLimitError(new Response('Forbidden', {status: 403, headers: {'x-ratelimit-remaining': '0'}}));
  assert.equal(primary.primary, true);
  assert.equal(primary.retryAfterMs, 60000);
});
