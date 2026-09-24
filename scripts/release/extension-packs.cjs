const fs = require('node:fs');
const path = require('node:path');
const { command, digest, key, validateEntry, origins } = require('../installer/install-extensions.cjs');
const configuration = require('../../conf/extension-packs.json');
const platforms = require('../../conf/platforms.json');
const { builderHash } = require('../build/extension-pack.cjs');
const { exec } = require('../cache/upstream-bottle-cache.cjs');
const root = path.resolve(__dirname, '../..');

function versionBatches(value = configuration.versions.join(' ')) {
  const versions = [...new Set(value.trim().split(/\s+/))];
  if (versions.some(version => !configuration.versions.includes(version))) throw new Error('Unsupported PHP version');
  // Eight versions produce at most 192 build and 160 compatibility jobs.
  return Array.from({ length: Math.ceil(versions.length / 8) }, (_, index) => versions.slice(index * 8, index * 8 + 8));
}
async function dispatch({ versions = process.env.PHP_VERSIONS || undefined, afterRun = process.env.AFTER_RUN,
  repository = process.env.GITHUB_REPOSITORY || 'shivammathur/php-darwin', ref = process.env.GITHUB_REF_NAME || 'main',
  run = command, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  if (repository !== 'shivammathur/php-darwin') throw new Error('Unexpected extension cache repository');
  const batches = versionBatches(versions);
  if (afterRun) {
    if (!/^[1-9][0-9]*$/.test(afterRun) || afterRun === process.env.GITHUB_RUN_ID) throw new Error('Invalid prerequisite run');
    const started = now();
    console.log(`Waiting for successful workflow run ${afterRun}`);
    while (true) {
      const result = JSON.parse(run('gh', ['api', `repos/${repository}/actions/runs/${afterRun}`]));
      if (result.status === 'completed') {
        if (result.conclusion !== 'success') throw new Error(`Prerequisite run ${afterRun} concluded ${result.conclusion}`);
        break;
      }
      if (now() - started >= 5 * 60 * 60 * 1000) throw new Error('Prerequisite run did not finish within five hours');
      await wait(60000);
    }
  }
  for (const batch of batches) {
    run('gh', ['workflow', 'run', 'cache-extensions.yml', '--repo', repository, '--ref', ref,
      '-f', `php-versions=${batch.join(' ')}`, '-f', 'builds=debug release', '-f', 'ts=nts zts', '-f', 'publish=true'], { inherit: true });
    console.log(`Dispatched optional extension caches for PHP ${batch.join(', ')}`);
  }
}
function unchanged(entry, repositories, phpManifest) {
  try {
    validateEntry(entry);
    const phpVersion = phpManifest.php_src_commit ? entry.php_semver?.split('-')[0] : entry.php_semver;
    if (entry.builder_sha256 !== builderHash() || phpVersion !== phpManifest.php_semver ||
        !entry.source_records?.length) return false;
    if ((phpManifest.php_src_commit || '') !== (entry.php_src_commit || '')) return false;
    return entry.source_records.every(record => {
      const repository = repositories[record.repository];
      if (!repository || !record.path || record.path.includes('..') || path.isAbsolute(record.path)) return false;
      const file = path.join(repository, record.path);
      return fs.existsSync(file) && digest(fs.readFileSync(file)) === record.sha256;
    });
  } catch { return false; }
}
async function readManifest(version) {
  const response = await fetch(`${origins[0]}/extensions-${version}-manifest.json`, { signal: AbortSignal.timeout(15000) });
  if (response.status === 404) return { schema: 1, assets: [] };
  if (!response.ok) throw new Error(`Cannot inspect existing extension release: HTTP ${response.status}`);
  const manifest = await response.json();
  if (manifest.schema !== 1 || !Array.isArray(manifest.assets)) throw new Error('Invalid published extension manifest');
  manifest.assets.forEach(validateEntry);
  return manifest;
}
async function plan() {
  const versions = (process.env.PHP_VERSIONS || '8.4').split(/\s+/);
  const selectedPacks = (process.env.EXTENSION_PACKS || Object.keys(configuration.packs).join(' ')).split(/\s+/);
  const builds = (process.env.BUILDS || 'release').split(/\s+/);
  const modes = (process.env.THREAD_SAFETY || 'nts').split(/\s+/);
  const repositories = { 'shivammathur/homebrew-extensions': path.resolve('homebrew-extensions'), 'Homebrew/homebrew-core': path.resolve('homebrew-core') };
  const include = [];
  for (const php_version of versions) {
    if (!configuration.versions.includes(php_version)) throw new Error('Unsupported PHP version');
    const existing = await readManifest(php_version);
    const response = await fetch(`https://github.com/shivammathur/php-darwin/releases/download/php-${php_version}/php-${php_version}-manifest.json`,
      { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Published PHP ${php_version} cache is unavailable`);
    const phpManifest = await response.json();
    for (const name of selectedPacks) for (const build of builds) for (const thread_safety of modes) for (const architecture of Object.keys(platforms)) {
      if (!Object.hasOwn(configuration.packs, name)) throw new Error('Unknown extension pack');
      const context = { name, php_version, build, thread_safety, architecture };
      const identity = key(context);
      if (!phpManifest.assets.some(asset => asset.build === build && asset.thread_safety === thread_safety && asset.architecture === architecture)) {
        throw new Error(`Published PHP cache variant is unavailable: ${identity}`);
      }
      const previous = existing.assets.find(asset => key(asset) === identity);
      if (process.env.FORCE !== 'true' && previous && unchanged(previous, repositories, phpManifest)) continue;
      include.push({ ...context, runner: platforms[architecture].build_runner });
    }
  }
  if (include.length > 256) throw new Error('Extension matrix exceeds Actions limit');
  const result = JSON.stringify({ include });
  const tests = compatibilityMatrix(include);
  console.log(result);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,
    `matrix=${result}\ncount=${include.length}\ntests=${JSON.stringify(tests)}\n`);
}
function compatibilityMatrix(entries) {
  const groups = new Map();
  for (const { name, php_version, build, thread_safety, architecture } of entries) {
    const platform = platforms[architecture];
    for (const runner of platform.test_runners.filter(runner => runner !== platform.build_runner)) {
      const context = { php_version, build, thread_safety, architecture, runner };
      const identity = JSON.stringify(context);
      if (!groups.has(identity)) groups.set(identity, { ...context, packs: [] });
      const packs = groups.get(identity).packs;
      if (!packs.includes(name)) packs.push(name);
    }
  }
  return { include: [...groups.values()] };
}
function scan(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    const file = path.join(directory, item.name);
    return item.isDirectory() ? scan(file) : [file];
  });
}
function validatePublishRun(id, run = command) {
  if (!/^[1-9][0-9]*$/.test(id || '')) throw new Error('Invalid source workflow run');
  const route = `repos/shivammathur/php-darwin/actions/runs/${id}`;
  const source = JSON.parse(run('gh', ['api', route]));
  if (source.status !== 'completed' || source.head_branch !== 'main' ||
      source.head_repository?.full_name !== 'shivammathur/php-darwin' ||
      source.path !== '.github/workflows/cache-extensions.yml') throw new Error('Untrusted extension source run');
  const jobs = JSON.parse(run('gh', ['api', '--paginate', '--slurp', `${route}/jobs?per_page=100`])).flatMap(page => page.jobs);
  const builds = jobs.filter(job => /^(imagick|mongodb|memcached) \/ PHP /.test(job.name));
  const tests = jobs.filter(job => /^Test PHP /.test(job.name));
  if (!builds.length || !tests.length || [...builds, ...tests].some(job => job.status !== 'completed' || job.conclusion !== 'success')) {
    throw new Error('Source extension builds and compatibility tests must all pass');
  }
  console.log(`Validated source run ${id}: ${builds.length} builds and ${tests.length} compatibility jobs`);
}
async function publish(directory, { run = exec } = {}) {
  const entries = scan(directory).filter(file => file.endsWith('.json')).map(file => {
    const entry = validateEntry(JSON.parse(fs.readFileSync(file)));
    const archive = path.join(path.dirname(file), entry.file);
    const bytes = fs.readFileSync(archive);
    if (digest(bytes) !== entry.sha256 || bytes.length !== entry.bytes) throw new Error('Invalid extension publish artifact');
    const report = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'validation.txt')));
    if (report.name !== entry.name || report.sha256 !== entry.sha256 || !Number.isFinite(report.install_seconds) ||
        report.install_seconds >= 10 || !report.php_preserved || !report.services_preserved) throw new Error('Extension validation did not pass');
    return { entry, archive };
  });
  if (new Set(entries.map(({ entry }) => key(entry))).size !== entries.length) throw new Error('Invalid extension publish batch');
  const repo = 'shivammathur/php-darwin';
  const release = 'extensions';
  const env = { ...process.env, AWS_ACCESS_KEY_ID: process.env.CF_R2_AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.CF_R2_AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION: 'auto',
    AWS_EC2_METADATA_DISABLED: 'true', AWS_MAX_ATTEMPTS: '1', AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
    AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required' };
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY || !process.env.CF_R2_AWS_S3_ENDPOINT) throw new Error('Cloudflare credentials are required');
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${release}`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(15000),
  });
  await response.body?.cancel();
  if (response.status === 404 && entries.length) {
    await run('gh', ['release', 'create', release, '--repo', repo, '--title', 'Optional PHP extension caches', '--notes', '', '--latest=false']);
  } else if (!response.ok) throw new Error(`Cannot inspect extension release: HTTP ${response.status}`);
  const staging = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || '/tmp', 'extension-release-'));
  async function mirror(file, immutable) {
    const name = path.basename(file);
    console.log(`Uploading Cloudflare object: ${name}`);
    await run('aws', ['--endpoint-url', process.env.CF_R2_AWS_S3_ENDPOINT, 's3', 'cp', file, `s3://php-darwin/extensions/${name}`,
      '--cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache, max-age=0, must-revalidate',
      '--cli-connect-timeout', '5', '--cli-read-timeout', '60', '--only-show-errors'], { env });
    const expected = digest(fs.readFileSync(file));
    const downloaded = path.join(staging, `verify-${name}`);
    let received;
    try {
      // Keep upload subprocesses asynchronous and use the same curl transport
      // as dependency publication, without retaining a fetch socket between uploads.
      const status = await run('curl', ['-q', '--silent', '--show-error', '--location',
        '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '5', '--max-time', '45',
        '--output', downloaded, '--write-out', '%{http_code}', `${origins[1]}/${name}?verify=${Date.now()}`]);
      received = fs.readFileSync(downloaded);
      if (status !== '200' || digest(received) !== expected) {
        throw new Error(`HTTP ${status}, expected ${expected}, received ${digest(received)} (${received.length} bytes)`);
      }
    } catch (error) {
      // Distinguish a missing R2 object from a public-edge failure. Never
      // repeat an upload or publish a manifest after failed verification.
      try {
        const object = JSON.parse(await run('aws', ['--endpoint-url', process.env.CF_R2_AWS_S3_ENDPOINT,
          's3api', 'head-object', '--bucket', 'php-darwin', '--key', `extensions/${name}`,
          '--cli-connect-timeout', '5', '--cli-read-timeout', '30'], { env }));
        console.error(`R2 object exists: ${name}; ${object.ContentLength} bytes, ETag ${object.ETag}`);
      } catch { console.error(`R2 HeadObject could not confirm the uploaded object: ${name}`); }
      throw new Error(`Mirror verification failed: ${name}; ${error.message}`, { cause: error });
    } finally { fs.rmSync(downloaded, { force: true }); }
    console.log(`Verified Cloudflare object: ${name}; ${received.length} bytes, SHA256 ${expected}`);
  }
  try {
    for (const { archive } of entries) {
      await run('gh', ['release', 'upload', release, archive, '--repo', repo, '--clobber']);
      await mirror(archive, true);
    }
    // Commit each PHP-version manifest only after every referenced archive is
    // uploaded and verified. Existing configurations remain in the manifest.
    for (const version of new Set(entries.map(({ entry }) => entry.php_version))) {
      const previous = await readManifest(version);
      const merged = new Map(previous.assets.map(entry => [key(entry), entry]));
      for (const { entry } of entries) if (entry.php_version === version) merged.set(key(entry), entry);
      const manifest = path.join(staging, `extensions-${version}-manifest.json`);
      fs.writeFileSync(manifest, JSON.stringify({ schema: 1, assets: [...merged.values()].sort((a, b) => key(a).localeCompare(key(b))) }, null, 2) + '\n');
      await mirror(manifest, false);
      await run('gh', ['release', 'upload', release, manifest, '--repo', repo, '--clobber']);
    }
    const installer = path.join(root, 'scripts/installer/install-extensions.cjs');
    await mirror(installer, false);
    await run('gh', ['release', 'upload', release, installer, '--repo', repo, '--clobber']);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
module.exports = { unchanged, builderHash, readManifest, plan, publish, compatibilityMatrix, versionBatches, dispatch, validatePublishRun };
if (require.main === module) (async () => {
  if (process.argv[2] === 'dispatch') await dispatch();
  else if (process.argv[2] === 'plan') await plan();
  else if (process.argv[2] === 'publish') await publish(process.argv[3]);
  else if (process.argv[2] === 'validate-publish-run') validatePublishRun(process.argv[3]);
  else throw new Error('Usage: extension-packs.cjs plan|publish|dispatch|validate-publish-run');
})().catch(error => { console.error(error); process.exitCode = 1; });
