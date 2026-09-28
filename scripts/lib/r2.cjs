// Publication only. Use the AWS CLI's signed S3 API, never the public CDN, to
// decide whether an object exists or whether an uncertain upload committed.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

async function fingerprint(file) {
  const sha256 = crypto.createHash('sha256'), md5 = crypto.createHash('md5');
  let bytes = 0;
  for await (const chunk of fs.createReadStream(file)) { bytes += chunk.length; sha256.update(chunk); md5.update(chunk); }
  const sum = md5.digest();
  return { bytes, sha256: sha256.digest('hex'), md5: sum.toString('hex'), contentMD5: sum.toString('base64') };
}
function credentials(env = process.env) {
  return { ...env, AWS_ACCESS_KEY_ID: env.CF_R2_AWS_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: env.CF_R2_AWS_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY,
    AWS_DEFAULT_REGION: 'auto', AWS_EC2_METADATA_DISABLED: 'true', AWS_MAX_ATTEMPTS: '1', AWS_RETRY_MODE: 'standard',
    AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required', AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required', AWS_PAGER: '' };
}
function r2({ endpoint, env, run, retry }) {
  const options = { env: credentials(env) };
  const api = async (operation, key, args = []) => {
    if (typeof key !== 'string' || !key || key.startsWith('/') || /[\x00-\x1f\x7f]/.test(key) || key.split('/').includes('..')) {
      throw new Error('Invalid R2 object key');
    }
    return JSON.parse(await run('aws', ['--endpoint-url', endpoint, 's3api', operation, '--bucket', 'php-darwin',
      '--key', key, '--cli-connect-timeout', '5', '--cli-read-timeout', '120', '--output', 'json', ...args], options));
  };
  async function head(key) {
    let object;
    try { object = await api('head-object', key); }
    catch (error) {
      // AWS CLI distinguishes a missing key from denied access or a failed
      // request. Only a confirmed missing key permits an upload.
      if (/\((?:404|NoSuchKey|NotFound)\) when calling the HeadObject operation/.test(error.message)) return null;
      throw error;
    }
    if (!Number.isSafeInteger(object.ContentLength) || object.ContentLength < 0 ||
        typeof object.ETag !== 'string' || !/^"[a-f0-9]{32}(?:-\d+)?"$/.test(object.ETag)) {
      throw new Error(`Invalid R2 object metadata: ${key}`);
    }
    return object;
  }
  async function read(key, file, object) {
    await api('get-object', key, ['--if-match', object.ETag, file]);
  }
  async function matches(key, expected, object) {
    if (!object || object.ContentLength !== expected.bytes) return false;
    if (object.ETag === `"${expected.md5}"`) {
      return !object.Metadata?.sha256 || object.Metadata.sha256 === expected.sha256;
    }
    if (!/-\d+"$/.test(object.ETag)) return false;
    // Existing multipart objects have composite ETags. Authenticate those bytes
    // directly instead of trusting client-supplied SHA metadata or rewriting them.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'php-darwin-r2-'));
    try {
      const file = path.join(directory, 'object');
      await read(key, file, object);
      const actual = await fingerprint(file);
      return actual.bytes === expected.bytes && actual.sha256 === expected.sha256;
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
  async function restore(key, file, sha256) {
    return retry(`Read R2 ${key}`, async () => {
      const object = await head(key);
      if (!object) return false;
      await read(key, file, object);
      const actual = await fingerprint(file);
      return actual.bytes === object.ContentLength && actual.sha256 === sha256;
    });
  }
  async function ensure(file, key, { immutable = true, contentType = 'application/octet-stream' } = {}) {
    const expected = await fingerprint(file);
    // Every published archive is far below PutObject's 5 GiB limit. Explicit
    // PutObject avoids implicit multipart uploads and their separate commit.
    if (expected.bytes > 5 * 1024 ** 3) throw new Error(`R2 single upload exceeds 5 GiB: ${key}`);
    let attempted = false;
    const cacheControl = immutable ? 'public, max-age=31536000, immutable' : 'no-cache, max-age=0, must-revalidate';
    await retry(`Publish R2 ${key}`, async () => {
      const existing = await head(key);
      if (await matches(key, expected, existing)) return;
      attempted = true;
      const result = await api('put-object', key, ['--body', file, '--content-length', String(expected.bytes),
        '--content-md5', expected.contentMD5, '--metadata', JSON.stringify({ sha256: expected.sha256 }),
        '--cache-control', cacheControl, '--content-type', contentType]);
      if (result.ETag !== `"${expected.md5}"`) throw new Error(`R2 upload checksum mismatch: ${key}`);
      const stored = await head(key);
      if (!stored || stored.ContentLength !== expected.bytes || stored.ETag !== result.ETag ||
          stored.Metadata?.sha256 !== expected.sha256) throw new Error(`R2 upload did not commit verified bytes: ${key}`);
    });
    console.log(`Verified R2 origin: ${key}; ${expected.bytes} bytes, SHA256 ${expected.sha256}${attempted ? ' (uploaded)' : ' (reused)'}`);
    return { ...expected, uploaded: attempted };
  }
  return { head, restore, ensure };
}
module.exports = { fingerprint, credentials, r2 };
