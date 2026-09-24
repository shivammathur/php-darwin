const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { command, brewSource, environment, recipeHash } = require('./source-bottle-cache.cjs');
const { ReleaseCache } = require('./source-bottle-releases.cjs');
const { recordMetric } = require('../lib/build-metrics.cjs');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function checkpointKey(inputs) { return sha(JSON.stringify(canonical(inputs))); }

function kegDigest(root) {
  const hash = crypto.createHash('sha256');
  function visit(relative = '') {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      // Homebrew regenerates receipts and SBOM creation times when pouring the
      // same bottle. Recipes are keyed separately; hash the installed payload.
      if (!relative && ['.brew', 'INSTALL_RECEIPT.json', 'sbom.spdx.json'].includes(name)) continue;
      const member = path.join(relative, name);
      const file = path.join(root, member);
      const stat = fs.lstatSync(file);
      hash.update(JSON.stringify([member, stat.mode & 0o7777]));
      if (stat.isSymbolicLink()) hash.update(JSON.stringify(['link', fs.readlinkSync(file)]));
      else if (stat.isDirectory()) visit(member);
      else if (stat.isFile()) hash.update(sha(fs.readFileSync(file)));
      else throw new Error(`Unsupported checkpoint file: ${member}`);
    }
  }
  visit();
  return hash.digest('hex');
}

function fingerprint() {
  const { PHP_VERSION: php, ARCH: arch, BUILD: build, TS: ts, GITHUB_SHA: revision,
    HOMEBREW_PHP_COMMIT: phpCommit, HOMEBREW_EXTENSIONS_COMMIT: extensionsCommit } = process.env;
  if (!/^\d+\.\d+$/.test(php || '') || !['arm64', 'x86_64'].includes(arch) ||
      !['release', 'debug'].includes(build) || !['nts', 'zts'].includes(ts) ||
      ![revision, phpCommit, extensionsCommit].every(value => /^[0-9a-f]{40}$/.test(value || ''))) {
    throw new Error('Invalid archive checkpoint inputs');
  }
  const formula = command('bash', ['-c',
    '. scripts/lib/lib.sh; tap=$(php_darwin_package_config tap) && formula=$(php_darwin_requested_formula "$PHP_VERSION" "$BUILD" "$TS") && printf "%s/%s" "$tap" "$formula"'
  ]).trim();
  const [record] = JSON.parse(brewSource('info', ['archive', JSON.stringify([formula]), 'false']));
  const platform = environment();
  const extensions = fs.readFileSync(path.join(process.env.RUNNER_TEMP, 'php-darwin-build/cached-extension-paths.txt'), 'utf8')
    .trim().split('\n').filter(Boolean).map(line => {
      const [name, type, relative] = line.split('\t');
      if (!relative || path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error('Unsafe extension checkpoint path');
      return { name, type, path: relative, sha256: sha(fs.readFileSync(path.join(platform.prefix, relative))) };
    });
  return { schema: 1, php, arch, build, ts, revision, phpCommit, extensionsCommit,
    platform, extensions, packages: record.packages.map(({ prefix, ...item }) => ({ ...item,
      recipe: recipeHash(item.recipe), payload: kegDigest(prefix) })) };
}

function identity(inputs) {
  const key = checkpointKey(inputs);
  const prefix = `php-${inputs.php}-${inputs.arch}-${inputs.build}-${inputs.ts}-`;
  const archive = `php_${inputs.php}-${inputs.ts}-${inputs.build}+darwin_${inputs.arch}.tar.zst`;
  const metadata = archive.slice(0, -8) + '.json';
  const checkpoint = `checkpoint_${archive.slice(0, -8)}.json`;
  return { key, prefix, name: prefix + key, archive, metadata, checkpoint,
    files: [archive, archive + '.sha256', metadata, checkpoint] };
}

function verifyCheckpoint(directory, expected) {
  const item = identity(expected);
  const checkpoint = JSON.parse(fs.readFileSync(path.join(directory, item.checkpoint)));
  const metadataBytes = fs.readFileSync(path.join(directory, item.metadata));
  const metadata = JSON.parse(metadataBytes);
  const checksum = fs.readFileSync(path.join(directory, item.archive + '.sha256'), 'utf8').trim().split(/\s+/);
  if (checkpoint.schema !== 1 || checkpoint.key !== item.key || checkpointKey(checkpoint.inputs) !== item.key ||
      checkpoint.archive !== item.archive || checkpoint.metadata_sha256 !== sha(metadataBytes) ||
      checksum.length !== 2 || checksum[1] !== item.archive || checksum[0] !== checkpoint.sha256 ||
      !/^[0-9a-f]{64}$/.test(checksum[0]) || sha(fs.readFileSync(path.join(directory, item.archive))) !== checksum[0] ||
      metadata.archive !== item.archive || metadata.php_version !== expected.php || metadata.build !== expected.build || metadata.thread_safety !== expected.ts ||
      metadata.architecture !== expected.arch || metadata.homebrew_php_commit !== expected.phpCommit ||
      metadata.homebrew_extensions_commit !== expected.extensionsCommit) throw new Error('Archive checkpoint integrity/input mismatch');
  return item;
}

async function downloadCheckpoint(cache, artifact, directory, expected) {
  const item = identity(expected);
  fs.mkdirSync(directory, { recursive: true });
  const zip = path.join(directory, 'artifact.zip');
  await cache.api(`actions/artifacts/${artifact.id}/zip`, { binary: true, accept: 'application/vnd.github+json', consume: response =>
    pipeline(Readable.fromWeb(response.body), fs.createWriteStream(zip)) });
  if (!artifact.digest || artifact.digest !== `sha256:${sha(fs.readFileSync(zip))}`) throw new Error('Checkpoint artifact digest mismatch');
  const names = command('unzip', ['-Z1', zip]).trim().split('\n');
  if (names.length !== item.files.length || !names.every(name => item.files.includes(name)) || new Set(names).size !== names.length) {
    throw new Error('Unexpected archive checkpoint members');
  }
  for (const member of item.files) {
    const output = fs.openSync(path.join(directory, member), 'w');
    try {
      const result = spawnSync('unzip', ['-p', zip, member], { stdio: ['ignore', output, 'inherit'] });
      if (result.error || result.status !== 0) throw result.error || new Error('Could not extract checkpoint member');
    } finally { fs.closeSync(output); }
  }
  fs.unlinkSync(zip);
  verifyCheckpoint(directory, expected);
}

async function restoreCheckpoint(cache, inputs, builds, { reuse = true, temporary = process.env.RUNNER_TEMP } = {}) {
  const item = identity(inputs);
  const started = Date.now();
  if (reuse) {
    try {
      const result = await cache.api(`actions/artifacts?per_page=100&name=${encodeURIComponent(item.name)}`);
      const candidates = result.artifacts.filter(artifact => artifact.name === item.name && !artifact.expired &&
        artifact.workflow_run?.head_sha === inputs.revision).slice(0, 3);
      for (const artifact of candidates) {
        const directory = fs.mkdtempSync(path.join(temporary, 'php-darwin-checkpoint-'));
        try {
          await downloadCheckpoint(cache, artifact, directory, inputs);
          fs.mkdirSync(builds, { recursive: true });
          for (const file of item.files) fs.copyFileSync(path.join(directory, file), path.join(builds, file));
          recordMetric({ kind: 'checkpoint', result: 'restored', key: item.key, artifact: artifact.id, elapsedMs: Date.now() - started });
          return { ...item, hit: true, current: String(artifact.workflow_run.id) === process.env.GITHUB_RUN_ID };
        } catch (error) { cache.warn(`Ignoring archive checkpoint ${artifact.id}: ${error.message}`); }
        finally { fs.rmSync(directory, { recursive: true, force: true }); }
      }
    } catch (error) { cache.warn(`Archive checkpoint lookup unavailable: ${error.message}`); }
  }
  recordMetric({ kind: 'checkpoint', result: 'miss', key: item.key,
    reason: reuse ? 'no-matching-verified-artifact' : 'explicit-rebuild', elapsedMs: Date.now() - started });
  return { ...item, hit: false, current: false };
}

function stageCheckpoint(inputs, builds, directory) {
  const item = identity(inputs);
  const checksum = fs.readFileSync(path.join(builds, item.archive + '.sha256'), 'utf8').trim().split(/\s+/)[0];
  fs.writeFileSync(path.join(builds, item.checkpoint), JSON.stringify({ schema: 1, key: item.key, inputs,
    archive: item.archive, sha256: checksum, metadata_sha256: sha(fs.readFileSync(path.join(builds, item.metadata))) }));
  verifyCheckpoint(builds, inputs);
  fs.mkdirSync(directory, { recursive: true });
  for (const file of item.files) fs.copyFileSync(path.join(builds, file), path.join(directory, file));
}

async function pruneCheckpoints(cache, state, runId) {
  const artifacts = [];
  for (let page = 1; ; page++) {
    const result = await cache.api(`actions/runs/${runId}/artifacts?per_page=100&page=${page}`);
    artifacts.push(...result.artifacts);
    if (result.artifacts.length < 100) break;
  }
  if (!artifacts.some(artifact => artifact.name === state.name && !artifact.expired)) {
    throw new Error('Current verified checkpoint was not uploaded');
  }
  for (const artifact of artifacts) {
    if (artifact.name.startsWith(state.prefix) && artifact.name !== state.name) {
      await cache.api(`actions/artifacts/${artifact.id}`, { method: 'DELETE', allow: [404] });
    }
  }
}

async function main(stage) {
  const temporary = process.env.RUNNER_TEMP;
  const statePath = path.join(temporary, `php-darwin-checkpoint-${process.env.BUILD}-${process.env.TS}.json`);
  const builds = path.join(process.env.GITHUB_WORKSPACE, 'builds');
  const cache = new ReleaseCache();
  const output = values => {
    for (const [name, value] of Object.entries(values)) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  };
  if (stage === 'restore') {
    const inputs = fingerprint();
    const result = await restoreCheckpoint(cache, inputs, builds, { reuse: process.env.REUSE_ARCHIVES !== 'false' });
    fs.writeFileSync(statePath, JSON.stringify({ inputs, ...result }));
    output({ hit: result.hit, current: result.current, name: result.name });
    console.log(`Archive checkpoint: ${result.hit ? 'restored' : 'miss'} ${result.name}`);
  } else if (stage === 'stage') {
    const state = JSON.parse(fs.readFileSync(statePath));
    const directory = path.join(temporary, `php-darwin-upload-${state.inputs.build}-${state.inputs.ts}`);
    stageCheckpoint(state.inputs, builds, directory);
    output({ path: directory });
  } else if (stage === 'prune') {
    const state = JSON.parse(fs.readFileSync(statePath));
    await pruneCheckpoints(cache, state, process.env.GITHUB_RUN_ID);
  } else throw new Error('Invalid archive checkpoint stage');
}

if (require.main === module) main(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { checkpointKey, identity, kegDigest, verifyCheckpoint, downloadCheckpoint, restoreCheckpoint, stageCheckpoint, pruneCheckpoints };
