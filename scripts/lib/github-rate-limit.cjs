// Uploads do not consistently include the API rate-limit headers. Recognize
// GitHub's error body as well, without treating an ordinary 403 as throttling.
function retryAfter(response, now = Date.now()) {
  const after = response.headers.get('retry-after');
  const reset = response.headers.get('x-ratelimit-reset');
  const afterMs = after ? (/^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - now) : 0;
  const resetMs = response.headers.get('x-ratelimit-remaining') === '0' && /^\d+$/.test(reset || '') ?
    Math.max(0, Number(reset) * 1000 - now) + 1000 : 0;
  // Homebrew honors both headers when a primary quota is exhausted.
  return Math.max(0, Number.isFinite(afterMs) ? afterMs : 0, resetMs);
}

async function rateLimitError(response) {
  if (![403, 429].includes(response.status)) return;
  const delay = retryAfter(response);
  const message = await response.clone().text();
  const primary = response.headers.get('x-ratelimit-remaining') === '0' || /API rate limit exceeded/i.test(message);
  if (response.status !== 429 && !primary && !response.headers.has('retry-after') &&
      !/rate limit|secondary rate|abuse detection/i.test(message)) return;
  const error = new Error(`GitHub rate limit: HTTP ${response.status}`);
  // Match Homebrew's minimum one-minute wait for secondary limits.
  error.retryAfterMs = primary ? delay || 60000 : Math.max(60000, delay);
  error.rateLimited = true;
  error.primary = primary;
  return error;
}

function quotaDelay(value, now = Date.now()) {
  const quota = value.resources?.core || value.rate;
  return quota?.remaining === 0 && Number.isFinite(quota.reset) ?
    Math.max(1000, quota.reset * 1000 - now + 1000) : 60000;
}

module.exports = {retryAfter, rateLimitError, quotaDelay};
