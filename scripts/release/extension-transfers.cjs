const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { digest, origins } = require('../installer/install-extensions.cjs');

// Release and recovery only: no added work in the installation fast path.
function command(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
    let output = '', diagnostic = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-8192); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) return resolve(output.trim());
      const error = new Error(`${program} exited ${code}: ${diagnostic.trim()}`);
      // Curl still writes transfer metrics when it times out. Keep stdout
      // available to the reader without exposing arbitrary command output in logs.
      Object.defineProperty(error, 'output', { value: output.trim() });
      const status = diagnostic.match(/HTTP(?:\/\S+)?\s+(\d{3})\b/);
      error.transient = (program === 'curl' && [5, 6, 7, 18, 28, 52, 55, 56, 92].includes(code)) ||
        (status && [408, 429, 500, 502, 503, 504].includes(Number(status[1]))) ||
        /\b(InternalError|InternalFailure|ServiceUnavailable|SlowDown|RequestTimeout)\b/.test(diagnostic) ||
        /unexpected EOF|connection reset by peer|TLS handshake timeout|connection timed out|connection was closed before we received a valid response/i.test(diagnostic);
      reject(error);
    });
  });
}
function retryPolicy({ wait = ms => new Promise(resolve => setTimeout(resolve, ms)), budget = 6 } = {}) {
  return async (label, work) => {
    try { return await work(); }
    catch (error) {
      // At most one extra attempt per operation and six across the whole job.
      // Permanent errors (credentials, checksums, metadata) never enter here.
      if (!error.transient || budget-- <= 0) throw error;
      console.warn(`${label}: transient service failure; one recovery attempt in 5 seconds (${budget} remain for this job)`);
      await wait(5000);
      return work();
    }
  };
}
function httpError(status, label) {
  const error = new Error(`${label}: HTTP ${status}`);
  error.transient = [408, 429, 500, 502, 503, 504].includes(Number(status));
  return error;
}
function readDiagnostic(output, headerFile, downloaded) {
  const [status = '', timing = ''] = String(output || '').split('\n');
  const values = timing.split(' '), result = { http_status: /^\d{3}$/.test(status) ? Number(status) : 0 };
  ['dns_seconds', 'connect_seconds', 'tls_seconds', 'first_byte_seconds', 'total_seconds', 'received_bytes'].forEach((name, i) => {
    if (/^\d+(?:\.\d+)?$/.test(values[i] || '')) result[name] = Number(values[i]);
  });
  if (/^[\d.]+$/.test(values[6] || '')) result.http_version = values[6];
  if (/^[\da-fA-F:.]+$/.test(values[7] || '')) result.remote_ip = values[7];
  result.saved_bytes = fs.existsSync(downloaded) ? fs.statSync(downloaded).size : 0;
  let headers = {};
  if (fs.existsSync(headerFile)) for (const line of fs.readFileSync(headerFile, 'utf8').split(/\r?\n/)) {
    if (line.startsWith('HTTP/')) headers = {};
    const match = line.match(/^(cf-ray|cf-cache-status|age|content-length|content-range):\s*([\w ./:-]{1,100})$/i);
    if (match) headers[match[1].toLowerCase()] = match[2];
  }
  return { ...result, headers };
}
async function githubJSON(route, { run = command, retry = retryPolicy(), paginate = false } = {}) {
  const result = await retry(`Read ${route}`, () => run('gh', ['api', ...(paginate ? ['--paginate', '--slurp'] : []), route]));
  return JSON.parse(result);
}
async function workflowJobs(route, attempts, options = {}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error('Invalid source run attempt');
  const jobs = new Map();
  // The run-wide jobs endpoint can return 502 for large cancelled matrices.
  // Explicit attempts also retain successful jobs omitted from partial reruns.
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const pages = await githubJSON(`${route}/attempts/${attempt}/jobs?per_page=100`, { ...options, paginate: true });
    for (const job of pages.flatMap(page => page.jobs)) jobs.set(job.name, job);
  }
  return [...jobs.values()];
}
function transfers({ directory, env, endpoint, run = command, retry = retryPolicy() }) {
  const repo = 'shivammathur/php-darwin', release = 'extensions';
  let assets;
  const report = { github_reused: 0, github_uploaded: 0, cloudflare_reused: 0, cloudflare_uploaded: 0, reads: [] };
  async function refreshAssets() {
    const record = JSON.parse(await run('gh', ['api', `repos/${repo}/releases/tags/${release}`]));
    assets = new Map(JSON.parse(await run('gh', ['api', '--paginate', '--slurp',
      `repos/${repo}/releases/${record.id}/assets?per_page=100`])).flat().map(asset => [asset.name, asset]));
  }
  async function read(file, base, { missing = false, different = false, fresh = true } = {}) {
    const name = path.basename(file), downloaded = path.join(directory, `verify-${name}`);
    const headers = `${downloaded}.headers`;
    let output = '', failure, verified = false;
    try {
      output = await run('curl', ['-q', '--silent', '--show-error', '--location',
        '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '5', '--max-time', '45',
        '--output', downloaded, '--dump-header', headers, '--write-out',
        '%{http_code}\n%{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total} %{size_download} %{http_version} %{remote_ip}',
        `${base}/${name}${fresh ? `?verify=${Date.now()}` : ''}`]);
      const status = output.split('\n')[0];
      if (status === '404' && missing) return false;
      if (status !== '200') throw httpError(status, `Verify ${name}`);
      const expected = fs.readFileSync(file), received = fs.readFileSync(downloaded);
      if (received.length !== expected.length || digest(received) !== digest(expected)) {
        if (different) return false;
        throw new Error(`Checksum/size mismatch: ${name}`);
      }
      verified = true;
      return true;
    } catch (error) {
      failure = error;
      output = error.output || output;
      throw error;
    } finally {
      const diagnostic = { file: name, origin: base === origins[0] ? 'github' : 'cloudflare',
        ...readDiagnostic(output, headers, downloaded), verified, ...(failure ? { error: failure.message } : {}) };
      report.reads.push(diagnostic);
      console.log(`Publication read: ${JSON.stringify(diagnostic)}`);
      fs.rmSync(downloaded, { force: true });
      fs.rmSync(headers, { force: true });
    }
  }
  async function github(file, immutable) {
    const name = path.basename(file), bytes = fs.readFileSync(file), sha = digest(bytes);
    let uncertain = false;
    await retry(`GitHub ${name}`, async () => {
      // Reconcile after a lost upload response before trying another upload.
      if (!assets || uncertain) await refreshAssets();
      const previous = assets.get(name);
      if (previous && previous.size === bytes.length && previous.digest === `sha256:${sha}`) {
        report.github_reused++;
        console.log(`Reused verified GitHub asset: ${name}`);
        return;
      }
      if (previous && immutable) {
        if (await read(file, origins[0], { fresh: false })) {
          report.github_reused++;
          return;
        }
      }
      uncertain = true;
      await run('gh', ['release', 'upload', release, file, '--repo', repo, ...(immutable ? [] : ['--clobber'])]);
      report.github_uploaded++;
      assets.set(name, { name, size: bytes.length, digest: `sha256:${sha}` });
      console.log(`Uploaded GitHub asset: ${name}`);
    }).catch(error => { throw Object.assign(new Error(`GitHub publication failed: ${name}; ${error.message}`, { cause: error }),
      { transient: Boolean(error.transient) }); });
  }
  async function mirror(file, immutable) {
    const name = path.basename(file);
    let uncertain = false;
    await retry(`Cloudflare ${name}`, async () => {
      // Reuse only after reading the complete object and verifying its SHA256.
      // This also resolves uploads that succeeded but lost their response.
      // SHA-addressed archives cannot change. Reuse their ordinary cache key
      // while still hashing every byte; unique queries force cold origin reads.
      // Mutable files and verification after an upload require a fresh read
      // (the ordinary URL may still have a cached pre-upload 404).
      if (await read(file, origins[1], { missing: true, different: !immutable, fresh: !immutable || uncertain })) {
        report.cloudflare_reused++;
        console.log(`Reused verified Cloudflare object: ${name}`);
        return;
      }
      console.log(`Uploading Cloudflare object: ${name}`);
      uncertain = true;
      await run('aws', ['--endpoint-url', endpoint, 's3api', 'put-object', '--bucket', 'php-darwin',
        '--key', `extensions/${name}`, '--body', file,
        '--cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache, max-age=0, must-revalidate',
        '--cli-connect-timeout', '5', '--cli-read-timeout', '60'], { env });
      await read(file, origins[1]);
      report.cloudflare_uploaded++;
      console.log(`Verified Cloudflare object: ${name}; SHA256 ${digest(fs.readFileSync(file))}`);
    }).catch(async error => {
      try {
        const object = JSON.parse(await run('aws', ['--endpoint-url', endpoint, 's3api', 'head-object',
          '--bucket', 'php-darwin', '--key', `extensions/${name}`, '--cli-connect-timeout', '5', '--cli-read-timeout', '30'], { env }));
        console.error(`R2 object exists: ${name}; ${object.ContentLength} bytes, ETag ${object.ETag}`);
      } catch { console.error(`R2 HeadObject could not confirm object: ${name}`); }
      throw Object.assign(new Error(`Cloudflare publication failed: ${name}; ${error.message}`, { cause: error }),
        { transient: Boolean(error.transient) });
    });
  }
  return { github, mirror, report };
}
module.exports = { command, retryPolicy, httpError, readDiagnostic, githubJSON, workflowJobs, transfers };
