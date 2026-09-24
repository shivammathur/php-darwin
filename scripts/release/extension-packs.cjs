const fs = require('node:fs');
const path = require('node:path');
const { command, digest, key, validateEntry, origins } = require('../installer/install-extensions.cjs');
const configuration = require('../../conf/extension-packs.json');
const platforms = require('../../conf/platforms.json');
const root = path.resolve(__dirname, '../..');

function builderHash() {
  return digest(fs.readFileSync(path.join(root, 'scripts/build/extension-pack.cjs')));
}
function unchanged(entry, repositories, phpManifest) {
  try {
    validateEntry(entry);
    if (entry.builder_sha256 !== builderHash() || entry.php_semver !== phpManifest.php_semver ||
        !entry.source_records?.length) return false;
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
  const scheduled = process.env.GITHUB_EVENT_NAME === 'schedule';
  const versions = (process.env.PHP_VERSIONS || (scheduled ? configuration.versions.join(' ') : '8.4')).split(/\s+/);
  const selectedPacks = (process.env.EXTENSION_PACKS || Object.keys(configuration.packs).join(' ')).split(/\s+/);
  const builds = (process.env.BUILDS || (scheduled ? 'debug release' : 'release')).split(/\s+/);
  const modes = (process.env.THREAD_SAFETY || (scheduled ? 'nts zts' : 'nts')).split(/\s+/);
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
  console.log(result);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${result}\ncount=${include.length}\n`);
}
function scan(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    const file = path.join(directory, item.name);
    return item.isDirectory() ? scan(file) : [file];
  });
}
async function publish(directory) {
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
  if (!entries.length || new Set(entries.map(({ entry }) => key(entry))).size !== entries.length) throw new Error('Invalid extension publish batch');
  const repo = 'shivammathur/php-darwin';
  const release = 'extensions';
  try { command('gh', ['release', 'view', release, '--repo', repo]); }
  catch { command('gh', ['release', 'create', release, '--repo', repo, '--title', 'Optional PHP extension caches', '--notes', '', '--latest=false']); }
  const staging = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || '/tmp', 'extension-release-'));
  const env = { ...process.env, AWS_ACCESS_KEY_ID: process.env.CF_R2_AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.CF_R2_AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION: 'auto',
    AWS_EC2_METADATA_DISABLED: 'true', AWS_MAX_ATTEMPTS: '1', AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required' };
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY || !process.env.CF_R2_AWS_S3_ENDPOINT) throw new Error('Cloudflare credentials are required');
  async function mirror(file, immutable) {
    const name = path.basename(file);
    command('aws', ['--endpoint-url', process.env.CF_R2_AWS_S3_ENDPOINT, 's3', 'cp', file, `s3://php-darwin/extensions/${name}`,
      '--cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache, max-age=0, must-revalidate', '--only-show-errors'], { env });
    const response = await fetch(`${origins[1]}/${name}?verify=${Date.now()}`, { signal: AbortSignal.timeout(45000) });
    if (!response.ok || digest(Buffer.from(await response.arrayBuffer())) !== digest(fs.readFileSync(file))) throw new Error(`Mirror verification failed: ${name}`);
  }
  try {
    for (const { archive } of entries) {
      command('gh', ['release', 'upload', release, archive, '--repo', repo, '--clobber']);
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
      command('gh', ['release', 'upload', release, manifest, '--repo', repo, '--clobber']);
    }
    const installer = path.join(root, 'scripts/installer/install-extensions.cjs');
    await mirror(installer, false);
    command('gh', ['release', 'upload', release, installer, '--repo', repo, '--clobber']);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
module.exports = { unchanged, builderHash, readManifest, plan, publish };
if (require.main === module) (async () => {
  if (process.argv[2] === 'plan') await plan();
  else if (process.argv[2] === 'publish') await publish(process.argv[3]);
  else throw new Error('Usage: extension-packs.cjs plan|publish');
})().catch(error => { console.error(error); process.exitCode = 1; });
