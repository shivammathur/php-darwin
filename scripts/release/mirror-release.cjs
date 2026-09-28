const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { r2, fingerprint } = require('../lib/r2.cjs');
const { command, retryPolicy, publicReader } = require('./extension-transfers.cjs');

async function mirror(staging, version, base, mode = 'all', { run = command, retry = retryPolicy(),
  env = process.env, endpoint = env.CF_R2_AWS_S3_ENDPOINT } = {}) {
  if (!['all', 'installer-only'].includes(mode)) throw new Error('Invalid mirror mode');
  const tag = `php-${version}`, manifestName = `${tag}-manifest.json`;
  const manifestFile = path.join(staging, manifestName), manifest = JSON.parse(fs.readFileSync(manifestFile));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'php-darwin-mirror-'));
  const store = r2({ endpoint, env, run, retry });
  const read = publicReader({ directory, run });
  async function publish(name, immutable) {
    const file = path.join(staging, name);
    const result = await store.ensure(file, `${tag}/${name}`, { immutable,
      contentType: name.endsWith('.zst') ? 'application/zstd' : 'text/plain' });
    let attempt = 0;
    await retry(`Verify public ${tag}/${name}`, () => read(file, base,
      { fresh: ++attempt > 1 || !immutable || result.uploaded, resume: immutable }));
  }
  try {
    if (mode === 'installer-only') {
      const expected = await fingerprint(manifestFile);
      if (!await store.restore(`${tag}/${manifestName}`, path.join(directory, 'manifest'), expected.sha256)) {
        throw new Error('Mirror manifest changed before installer refresh');
      }
    } else {
      // Validate the entire local batch before uploading or replacing any commit point.
      for (const entry of manifest.assets) {
        const name = entry.download || entry.name, file = path.join(staging, name);
        if (path.basename(name) !== name) throw new Error('Unsafe mirror archive name');
        const actual = await fingerprint(file);
        const checksum = fs.readFileSync(`${file}.sha256`, 'utf8').trim().split(/\s+/);
        if (actual.sha256 !== entry.sha256 || actual.bytes !== entry.bytes ||
            checksum[0] !== entry.sha256 || checksum[1] !== name) throw new Error(`Invalid mirror input: ${name}`);
      }
      for (const entry of manifest.assets) {
        const name = entry.download || entry.name;
        await publish(name, true);
        await publish(`${name}.sha256`, true);
      }
    }
    // Verify the installer before committing the manifest for this generation.
    await publish('install.sh', false);
    if (mode === 'all') await publish(manifestName, false);
    else await retry(`Verify public ${manifestName}`, () => read(manifestFile, base));
    console.log(`Verified R2 release: ${tag}`);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
module.exports = { mirror };
if (require.main === module) mirror(...process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
