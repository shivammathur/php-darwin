const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { digest, origins } = require('../installer/install-extensions.cjs');

// Publication only: no retries or added work in the installation fast path.
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
function transfers({ directory, env, endpoint, run = command, retry = retryPolicy() }) {
  const repo = 'shivammathur/php-darwin', release = 'extensions';
  let assets;
  const report = { github_reused: 0, github_uploaded: 0, cloudflare_reused: 0, cloudflare_uploaded: 0 };
  async function refreshAssets() {
    const record = JSON.parse(await run('gh', ['api', `repos/${repo}/releases/tags/${release}`]));
    assets = new Map(JSON.parse(await run('gh', ['api', '--paginate', '--slurp',
      `repos/${repo}/releases/${record.id}/assets?per_page=100`])).flat().map(asset => [asset.name, asset]));
  }
  async function read(file, base, { missing = false, different = false } = {}) {
    const name = path.basename(file), downloaded = path.join(directory, `verify-${name}`);
    try {
      const status = await run('curl', ['-q', '--silent', '--show-error', '--location',
        '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '5', '--max-time', '45',
        '--output', downloaded, '--write-out', '%{http_code}', `${base}/${name}?verify=${Date.now()}`]);
      if (status === '404' && missing) return false;
      if (status !== '200') throw httpError(status, `Verify ${name}`);
      const expected = fs.readFileSync(file), received = fs.readFileSync(downloaded);
      if (received.length !== expected.length || digest(received) !== digest(expected)) {
        if (different) return false;
        throw new Error(`Checksum/size mismatch: ${name}`);
      }
      return true;
    } finally { fs.rmSync(downloaded, { force: true }); }
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
        if (await read(file, origins[0])) {
          report.github_reused++;
          return;
        }
      }
      uncertain = true;
      await run('gh', ['release', 'upload', release, file, '--repo', repo, ...(immutable ? [] : ['--clobber'])]);
      report.github_uploaded++;
      assets.set(name, { name, size: bytes.length, digest: `sha256:${sha}` });
      console.log(`Uploaded GitHub asset: ${name}`);
    }).catch(error => { throw new Error(`GitHub publication failed: ${name}; ${error.message}`, { cause: error }); });
  }
  async function mirror(file, immutable) {
    const name = path.basename(file);
    await retry(`Cloudflare ${name}`, async () => {
      // Reuse only after reading the complete object and verifying its SHA256.
      // This also resolves uploads that succeeded but lost their response.
      if (await read(file, origins[1], { missing: true, different: !immutable })) {
        report.cloudflare_reused++;
        console.log(`Reused verified Cloudflare object: ${name}`);
        return;
      }
      console.log(`Uploading Cloudflare object: ${name}`);
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
      throw new Error(`Cloudflare publication failed: ${name}; ${error.message}`, { cause: error });
    });
  }
  return { github, mirror, report };
}
module.exports = { command, retryPolicy, httpError, transfers };
