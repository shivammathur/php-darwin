const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {rateLimitError, retryAfter, quotaDelay} = require('./github-rate-limit.cjs');
const execute = async args => (await promisify(execFile)('gh', args, {
  encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30000,
})).stdout;

function response(output) {
  const match = String(output || '').match(/^HTTP\/\S+ (\d{3})[^\n]*\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/);
  if (!match) return;
  const headers = new Headers();
  for (const line of match[2].split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
  }
  const status = Number(match[1]);
  return new Response([204, 304].includes(status) ? null : match[3], {status, headers});
}

// Only GETs are retried. A lost workflow-dispatch response can still have
// created a run, so callers must reconcile it instead of submitting twice.
function githubReader({run = execute, wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  warn = console.warn, budget = 12, maxWait = 3600000} = {}) {
  const cache = new Map();
  async function page(route) {
    const cached = cache.get(route);
    for (let attempt = 1; ; attempt++) {
      let result, failure;
      try {
        let output;
        try { output = await run(['api', '--include', ...(cached ? ['-H', `If-None-Match: ${cached.etag}`] : []), route]); }
        catch (error) { failure = error; output = error.stdout; }
        result = response(output);
        if (!result) throw failure || new Error('Invalid GitHub HTTP response');
        if (result.status === 304 && cached) return cached;
        const limited = await rateLimitError(result);
        if (limited) {
          if (limited.primary && !(result.headers.get('x-ratelimit-remaining') === '0' && /^\d+$/.test(result.headers.get('x-ratelimit-reset') || ''))) {
            try { limited.retryAfterMs = Math.max(limited.retryAfterMs, quotaDelay(JSON.parse(await run(['api', 'rate_limit'])))); }
            catch { /* Keep the bounded fallback if quota discovery fails. */ }
          }
          throw limited;
        }
        if (!result.ok) throw new Error(`GitHub GET ${route}: HTTP ${result.status}`);
        if (failure) throw failure;
        const entry = {value: await result.json(), etag: result.headers.get('etag'), link: result.headers.get('link')};
        if (entry.etag) cache.set(route, entry);
        else cache.delete(route);
        return entry;
      } catch (error) {
        const transient = !result || (failure && result.ok) || error.rateLimited || [408, 500, 502, 503, 504].includes(result.status);
        const delay = Math.max(1000 * 2 ** (attempt - 1), error.retryAfterMs || (result && retryAfter(result)) || 0);
        if (!transient || attempt >= 3 || budget-- <= 0 || delay > maxWait) throw error;
        warn(`Retrying GitHub read (${attempt + 1}/3) in ${Math.ceil(delay / 1000)}s: ${route}`);
        await wait(delay);
      }
    }
  }
  return async args => {
    if (args[0] !== 'api') return run(args);
    const paginate = args.includes('--paginate');
    if (args.slice(1, -1).some(arg => !['--paginate', '--slurp'].includes(arg))) throw new Error('Unsupported GitHub read arguments');
    let route = args.at(-1);
    const pages = [], seen = new Set();
    while (route) {
      if (seen.has(route) || seen.size >= 100) throw new Error('GitHub pagination exceeded its bound');
      seen.add(route);
      const entry = await page(route);
      pages.push(entry.value);
      const next = paginate && entry.link?.match(/<([^>]+)>;\s*rel="next"/);
      route = next ? next[1] : undefined;
      if (route && !route.startsWith('https://api.github.com/')) throw new Error('Unexpected GitHub pagination origin');
    }
    return JSON.stringify(paginate ? pages : pages[0]);
  };
}
const githubRead = githubReader();
module.exports = {githubReader, githubRead};
if (require.main === module) githubRead(['api', '--paginate', '--slurp', process.argv[2]])
  .then(output => process.stdout.write(output + '\n')).catch(error => { console.error(error.message); process.exitCode = 1; });
