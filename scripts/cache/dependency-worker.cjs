const fs = require('node:fs');
const path = require('node:path');
const {install, environment, brewSource, command, readBottle} = require('./source-bottle-cache.cjs');
const {readLock, ApprovedDependencies} = require('./approved-dependencies.cjs');
const {ReleaseCache} = require('./source-bottle-releases.cjs');
const {verifyRuntimeLinkage, verifyOpenSslLinkage} = require('./openssl-linkage.cjs');
const {buildGuard} = require('./dependency-build-guard.cjs');

async function prepare(formula) {
  if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true' ||
      process.env.GITHUB_REPOSITORY !== 'shivammathur/php-darwin') throw new Error('Dependency worker requires the macOS Actions repository');
  const updates = JSON.parse(process.env.PHP_DARWIN_DEPENDENCY_UPDATES || '[]');
  if (!/^(?:[a-z0-9_.-]+\/[a-z0-9_.-]+\/)?[a-z0-9][a-z0-9@+_.-]*$/.test(formula || '') || !updates.includes(formula)) throw new Error('Worker formula is not in the selective update');
  const platform = environment(), expected = require('../../conf/platforms.json')[platform.arch];
  if (!expected || platform.prefix !== expected.brew_prefix || Number(platform.macos) !== expected.minimum_macos) {
    throw new Error('Build the dependency on its configured baseline runner');
  }
  const approved = new ApprovedDependencies(readLock(), {updates, allowNewBottles: true});
  const cache = new ReleaseCache(), cacheRoot = '.source-bottle-cache';
  const result = await install({formula, cache, cacheRoot,
    approvedDependencies: approved, run: buildGuard(formula)});
  const [runtime] = JSON.parse(brewSource('info', ['archive', JSON.stringify([formula])]));
  const names = runtime.packages.map(item => item.name.split('/').at(-1));
  const contracts = JSON.parse(brewSource('info', ['archive', JSON.stringify(runtime.packages.map(item => item.name))]));
  let opensslLinks = 0;
  for (const item of runtime.packages) {
    verifyRuntimeLinkage(item.prefix, platform.prefix, names);
    const contract = contracts.find(value => value.full_name === item.name);
    if (contract?.openssl_major) opensslLinks += verifyOpenSslLinkage(item.prefix, contract.openssl_major);
  }
  if (runtime.openssl_major && !opensslLinks) throw new Error(`Missing expected OpenSSL ${runtime.openssl_major} linkage`);
  command('brew', ['linkage', '--test', formula], {inherit: true});
  if (formula.startsWith('python@')) command(path.join(runtime.prefix, 'bin', formula.replace('@', '')), ['-c',
    `import ssl, sqlite3, ctypes, decimal; assert ssl.OPENSSL_VERSION.startswith('OpenSSL ${runtime.openssl_major}.'); print(ssl.OPENSSL_VERSION)`], {inherit: true});
  if (formula === 'httpd') command(path.join(runtime.prefix, 'bin/httpd'), ['-t'], {inherit: true});
  const sources = [];
  for (const name of fs.existsSync(cacheRoot) ? fs.readdirSync(cacheRoot) : []) {
    const file = path.join(cacheRoot, name, 'metadata.json');
    if (!fs.existsSync(file)) continue;
    const metadata = JSON.parse(fs.readFileSync(file));
    if (metadata.inputs.formula !== formula) continue;
    const directory = path.join(cacheRoot, 'remote-verification', metadata.key);
    fs.mkdirSync(directory, {recursive: true});
    if (await cache.restoreCache([directory], metadata.key, [], metadata.inputs) !== metadata.key) {
      throw new Error(`Published worker bottle is unavailable: ${formula}`);
    }
    readBottle(directory, metadata.key);
    const restored = JSON.parse(fs.readFileSync(path.join(directory, 'metadata.json')));
    if (restored.sha256 !== metadata.sha256) throw new Error('Published worker bottle checksum differs');
    sources.push({key: metadata.key, sha256: metadata.sha256, inputs: metadata.inputs});
  }
  if (!runtime.bottled && sources.length !== 1) throw new Error('Expected one remotely verified source bottle');
  fs.writeFileSync('dependency-worker.json', JSON.stringify({formula, architecture: platform.arch, version: runtime.version,
    source_commit: process.env.GITHUB_SHA, result, openssl_links: opensslLinks, runtime: names, sources}, null, 2) + '\n');
  console.log(`Verified ${formula} on ${platform.arch}: ${result.built} built, ${result.restored} restored`);
}
prepare(process.argv[2]).catch(error => {console.error(error); process.exitCode = 1;});
