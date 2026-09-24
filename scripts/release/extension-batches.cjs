const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { digest, command } = require('../installer/install-extensions.cjs');

function downloadArtifact(artifact, directory, { run = spawnSync,
  wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  if (!Number.isSafeInteger(artifact.artifact_id) || artifact.artifact_id < 1) throw new Error('Invalid artifact ID');
  fs.mkdirSync(directory, { recursive: true });
  const zip = path.join(directory, 'artifact.zip');
  for (let attempt = 1; ; attempt++) {
    try {
      const fd = fs.openSync(zip, 'w');
      let result;
      try {
        result = run('gh', ['api', `repos/shivammathur/php-darwin/actions/artifacts/${artifact.artifact_id}/zip`],
          { stdio: ['ignore', fd, 'pipe'], encoding: 'utf8', timeout: 180000 });
      } finally { fs.closeSync(fd); }
      if (result.error || result.status !== 0) throw result.error || new Error(`Artifact ${artifact.artifact_id}: ${result.stderr}`);
      if (artifact.artifact_digest && `sha256:${digest(fs.readFileSync(zip))}` !== artifact.artifact_digest) throw new Error('Artifact digest mismatch');
      break;
    } catch (error) {
      fs.rmSync(zip, { force: true });
      if (attempt === 3) throw error;
      console.warn(`Artifact ${artifact.artifact_id} transfer failed; retry ${attempt + 1}/3: ${error.message}`);
      wait(1000 * 2 ** (attempt - 1));
    }
  }
  // Artifacts are selected only from this repository's completed main workflows.
  const members = command('unzip', ['-Z1', zip]).split('\n');
  if (members.some(member => member.startsWith('/') || member.split('/').includes('..'))) throw new Error('Unsafe artifact path');
  command('unzip', ['-q', zip, '-d', directory]);
  fs.rmSync(zip);
}
module.exports = { downloadArtifact };
