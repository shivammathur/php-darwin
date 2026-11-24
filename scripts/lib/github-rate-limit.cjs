// Uploads do not consistently include the API rate-limit headers. Recognize
// GitHub's error body as well, without treating an ordinary 403 as throttling.
function retryAfter(response, now = Date.now()) {
  const after = response.headers.get('retry-after');
  const reset = response.headers.get('x-ratelimit-reset');
  if (after) return /^\d+$/.test(after) ? Number(after) * 1000 : Math.max(0, Date.parse(after) - now) || 0;
  if (response.headers.get('x-ratelimit-remaining') === '0' && reset) {
    return Math.max(0, Number(reset) * 1000 - now) + 1000;
  }
  return 0;
}

async function rateLimitError(response) {
  if (![403, 429].includes(response.status)) return;
  const delay = retryAfter(response);
  const message = await response.clone().text();
  if (response.status !== 429 && !delay && !/rate limit|secondary rate|abuse detection/i.test(message)) return;
  const error = new Error(`GitHub rate limit: HTTP ${response.status}`);
  error.retryAfterMs = delay || 60000;
  error.rateLimited = true;
  error.primary = /API rate limit exceeded/i.test(message);
  return error;
}

function quotaDelay(value, now = Date.now()) {
  const quota = value.resources?.core || value.rate;
  return quota?.remaining === 0 && Number.isFinite(quota.reset) ?
    Math.max(1000, quota.reset * 1000 - now + 1000) : 60000;
}

module.exports = {retryAfter, rateLimitError, quotaDelay};
