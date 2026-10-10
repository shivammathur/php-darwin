const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { install, environment, brewSource, command, readBottle } = require('./source-bottle-cache.cjs');
const { ReleaseCache } = require('./source-bottle-releases.cjs');
const { readLock, validatePlatform, ApprovedDependencies } = require('./approved-dependencies.cjs');
const { portable } = require('./upstream-bottle-cache.cjs');
const { supportsPack } = require('../installer/install-extensions.cjs');
const recipes = require('./dependency-recipes.cjs');
const {verifyOpenSslLinkage, verifyRuntimeLinkage} = require('./openssl-linkage.cjs');
const {retireDependencies, pruneUnusedDependencies} = require('./retired-dependencies.cjs');
const {buildGuard} = require('./dependency-build-guard.cjs');
const root = path.resolve(__dirname, '../..');
const config = name => JSON.parse(fs.readFileSync(path.join(root, 'conf', name), 'utf8'));
const records = file => fs.readFileSync(path.join(root, 'conf', file), 'utf8').split('\n')
  .map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(line => line.split(/\s+/));

function roots() {
  const packages = config('package.json'), packs = config('extension-packs.json');
  const result = new Set(['jq', 'zstd']);
  for (const [, php] of records('versions')) {
    for (const [build, ts] of records('variants')) {
      const suffix = `${build === 'debug' ? '-debug' : ''}${ts === 'zts' ? '-zts' : ''}`;
      result.add(`${packages.tap}/php@${php}${suffix}`);
    }
    const extensions = records(`cached-extensions/${php}`).map(([name]) => name);
    extensions.push(...Object.entries(packs.packs).filter(([name]) => supportsPack(name, php))
      .flatMap(([, modules]) => modules.map(extension => extension.name)));
    for (const name of extensions) result.add(`${packages.extension_tap}/${name}@${php}`);
  }
  return [...result].sort();
}

function requireRunner() {
  if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('Dependency preparation and cleanup require a macOS Actions runner');
  }
}

function clean() {
  requireRunner();
  const names = command('brew', ['list', '--formula']).trim().split('\n').filter(Boolean);
  if (names.some(name => !/^[A-Za-z0-9@+_.-]+$/.test(name))) throw new Error('Invalid installed formula name');
  const pinned = command('brew', ['list', '--pinned']).trim().split('\n').filter(Boolean);
  if (pinned.length) command('brew', ['unpin', ...pinned], { inherit: true });
  if (names.length) command('brew', ['uninstall', '--formula', '--force', '--ignore-dependencies', ...names], { inherit: true });
}

async function prepare() {
  requireRunner();
  const core = process.env.HOMEBREW_CORE_COMMIT;
  if (!/^[a-f0-9]{40}$/.test(core || '')) throw new Error('Missing dependency snapshot commit');
  const platform = environment();
  const expected = config('platforms.json')[platform.arch];
  if (!expected || platform.prefix !== expected.brew_prefix || Number(platform.macos) !== expected.minimum_macos) {
    throw new Error('Prepare dependencies on their configured baseline macOS runner');
  }
  const recipeCommits = recipes.configured(core);
  const updates = JSON.parse(process.env.PHP_DARWIN_DEPENDENCY_UPDATES || '[]');
  const bottleUpdates = JSON.parse(process.env.PHP_DARWIN_BOTTLE_UPDATES || '[]');
  if (![updates, bottleUpdates].every(items => Array.isArray(items) && items.every(name => /^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/)?[A-Za-z0-9@+_.-]+$/.test(name))) ||
      updates.some(name => bottleUpdates.includes(name))) {
    throw new Error('Invalid selective dependency update');
  }
  const baseline = readLock();
  const previous = baseline.core_commit === core ? baseline : undefined;
  if (previous && previous.core_commit !== core) throw new Error('Selective update must preserve the approved base');
  const requested = [...new Set([...roots(), ...updates.filter(name => !name.includes('/')), ...bottleUpdates.filter(name => previous?.platforms[platform.arch].packages[name])])];
  const approved = previous && new ApprovedDependencies(previous, {updates, bottleUpdates, allowNewBottles: true});
  const cache = new ReleaseCache();
  const cacheRoot = '.source-bottle-cache';
  await install({ formula: 'jq', dependencyRoots: requested, cache, cacheRoot, approvedDependencies: approved,
    run: buildGuard() });
  const packageRoots = new Set(requested.filter(name => name.includes('/')));
  const plan = JSON.parse(brewSource('info', ['seed', JSON.stringify(requested), 'true', JSON.stringify(approved?.versions(platform) || {})]))
    .filter(item => !packageRoots.has(item.full_name) && !(item.requested && item.full_name.includes('/')));
  const cached = fs.existsSync(cacheRoot) ? fs.readdirSync(cacheRoot).flatMap(name => {
    const metadata = path.join(cacheRoot, name, 'metadata.json');
    return fs.existsSync(metadata) ? [JSON.parse(fs.readFileSync(metadata))] : [];
  }) : [];
  let packages = {...previous?.platforms[platform.arch].packages};
  for (const item of plan) {
    if (!item.installed) throw new Error(`Prepared dependency is not installed: ${item.full_name}`);
    if (item.openssl_major) {
      verifyRuntimeLinkage(item.prefix, platform.prefix, [item.name, ...item.runtime_formulae]);
      const links = verifyOpenSslLinkage(item.prefix, item.openssl_major);
      console.log(`Verified ${item.full_name}: ${links} direct OpenSSL ${item.openssl_major} library links`);
    }
    if (approved?.has(item)) continue;
    if (item.bottle) {
      packages[item.full_name] = { version: item.version, bottle: portable(item.bottle) };
      continue;
    }
    const matching = cached.filter(record => record.inputs.formula === item.full_name && record.inputs.version === item.version);
    if (matching.length !== 1) throw new Error(`Expected one prepared source bottle for ${item.full_name}; found ${matching.length}`);
    const { key, inputs } = matching[0];
    const directory = path.join(cacheRoot, 'verified', key);
    fs.mkdirSync(directory, { recursive: true });
    if (await cache.restoreCache([directory], key, [], inputs) !== key) {
      throw new Error(`Dependency was not saved for future cache jobs: ${item.full_name}`);
    }
    readBottle(directory, key);
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'metadata.json')));
    packages[item.full_name] = { version: item.version, source: { key, inputs, sha256: metadata.sha256 } };
  }
  const retired = (process.env.PHP_DARWIN_RETIRE_DEPENDENCIES || '').trim().split(/\s+/).filter(Boolean);
  packages = retireDependencies(packages, retired, plan);
  if (process.env.PHP_DARWIN_AUTOMATIC === 'true') packages = pruneUnusedDependencies(packages, plan);
  for (const name of retired) delete recipeCommits[name];
  const candidate = { schema: 1, core_commit: core,
    ...(fs.existsSync('dependency-inputs.json') ? {tap_inputs: JSON.parse(fs.readFileSync('dependency-inputs.json'))} : {}),
    ...(Object.keys(recipeCommits).length ? {recipe_commits: recipeCommits} : {}), platforms: {
    [platform.arch]: { macos: Number(platform.macos), prefix: platform.prefix, packages },
  } };
  validatePlatform(candidate.platforms[platform.arch], platform.arch);
  fs.writeFileSync(`dependencies-${platform.arch}.json`, JSON.stringify(candidate, null, 2) + '\n');
  fs.writeFileSync('dependency-roots.json', JSON.stringify(requested, null, 2) + '\n');
  fs.writeFileSync('dependency-plan.json', JSON.stringify(plan, null, 2) + '\n');
  console.log(`Prepared ${Object.keys(packages).length} approved dependencies for ${platform.arch}`);
}

async function verify() {
  requireRunner();
  const platform = environment();
  const file = `dependencies-${platform.arch}.json`;
  const lock = readLock(file), approved = new ApprovedDependencies(lock);
  // Prove every approved bottle, including tools used only when producing a
  // dependency. Consumer jobs prune those compilation-only dependencies.
  const names = Object.keys(lock.platforms[platform.arch].packages);
  // A genuinely empty prefix proves every dependency is obtainable without
  // source compilation, including tools that were preinstalled on the image.
  clean();
  // Cold means an empty installed prefix. Reuse checksum-verified downloads
  // from preparation instead of fetching large compiler bottles a second time.
  const result = await install({ formula: 'jq', dependencyRoots: names, approvedDependencies: approved,
    cache: new ReleaseCache(), cacheRoot: '.source-bottle-cache', run: buildGuard() });
  if (result.built !== 0) throw new Error('Approved dependency verification compiled a package');
  command('brew', ['linkage', '--test', ...names], { inherit: true });
  const openssl = names.filter(name => /^openssl@\d+$/.test(name));
  let opensslLinks = 0;
  if (openssl.length === 1) {
    const major = openssl[0].split('@')[1];
    for (const name of names) {
      opensslLinks += verifyOpenSslLinkage(command('brew', ['--prefix', name]).trim(), major);
    }
    console.log(`Verified all approved dependencies: ${opensslLinks} OpenSSL ${major} library links`);
    for (const name of names.filter(name => /^python@\d+\.\d+$/.test(name))) {
      const prefix = command('brew', ['--prefix', name]).trim();
      command(path.join(prefix, 'bin', name.replace('@', '')), ['-c',
        `import ssl, urllib.request; assert ssl.OPENSSL_VERSION.startswith('OpenSSL ${major}.'); print(ssl.OPENSSL_VERSION)`], {inherit: true});
    }
    if (names.includes('llvm')) {
      const prefix = command('brew', ['--prefix', 'llvm']).trim();
      const lldb = path.join(prefix, 'bin/lldb');
      if (fs.existsSync(lldb)) {
        const output = command(lldb, ['-b', '-o',
          `script import ssl; assert ssl.OPENSSL_VERSION.startswith('OpenSSL ${major}.'); print('LLVM Python OpenSSL ${major} verified')`, '-o', 'quit']);
        if (!output.split('\n').includes(`LLVM Python OpenSSL ${major} verified`)) {
          throw new Error('LLVM could not use the approved Python OpenSSL runtime');
        }
        console.log(output);
      }
    }
  }
  for (const [program, args] of [['jq', ['--version']], ['zstd', ['--version']]]) {
    command(program, args, { inherit: true });
  }
  for (const [formula, executable, args] of [['cmake', 'cmake', ['--version']], ['meson', 'meson', ['--version']],
    ['httpd', 'httpd', ['-t']]]) {
    if (names.includes(formula)) {
      command(path.join(command('brew', ['--prefix', formula]).trim(), 'bin', executable), args, {inherit: true});
    }
  }
  for (const name of names.filter(name => /^gcc(?:@\d+)?$/.test(name))) {
    const major = lock.platforms[platform.arch].packages[name].version.split('.')[0];
    const prefix = command('brew', ['--prefix', name]).trim();
    const directory = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'approved-gcc-'));
    try {
      const source = path.join(directory, 'smoke.cc'), binary = path.join(directory, 'smoke');
      fs.writeFileSync(source, '#include <iostream>\nint main() { std::cout << 42; }\n');
      command(path.join(prefix, 'bin', `g++-${major}`), [source, '-o', binary], { inherit: true });
      if (command(binary, []).trim() !== '42') throw new Error(`Approved ${name} failed its compiler smoke test`);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
  const hot = await install({ formula: 'jq', dependencyRoots: names, approvedDependencies: approved,
    cache: new ReleaseCache(), cacheRoot: '.source-bottle-cache', run: buildGuard() });
  if (hot.built !== 0 || hot.restored !== 0) throw new Error('Warm approved dependencies were not reused');
  const sha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(`dependency-verification-${platform.arch}.json`, JSON.stringify({
    schema: 1, arch: platform.arch, core_commit: lock.core_commit, sha256,
    dependencies: names.length, cold_source_builds: result.built, hot_source_builds: hot.built,
    openssl_formulae: openssl, openssl_library_links_checked: opensslLinks,
  }, null, 2) + '\n');
}

function merge(directory, output) {
  const merged = { schema: 1, core_commit: '', platforms: {} };
  for (const arch of ['arm64', 'x86_64']) {
    const file = path.join(directory, `dependencies-${arch}.json`);
    const lock = readLock(file);
    const verification = JSON.parse(fs.readFileSync(path.join(directory, `dependency-verification-${arch}.json`)));
    if (verification.schema !== 1 || verification.arch !== arch || verification.core_commit !== lock.core_commit ||
        verification.dependencies !== Object.keys(lock.platforms[arch]?.packages || {}).length ||
        verification.cold_source_builds !== 0 || verification.hot_source_builds !== 0 ||
        verification.sha256 !== createHash('sha256').update(fs.readFileSync(file)).digest('hex')) {
      throw new Error(`Missing or mismatched native dependency verification: ${arch}`);
    }
    if (merged.core_commit && merged.core_commit !== lock.core_commit) throw new Error('Dependency snapshots differ across architectures');
    if (merged.core_commit && JSON.stringify(merged.recipe_commits || {}) !== JSON.stringify(recipes.validate(lock.recipe_commits))) {
      throw new Error('Dependency recipes differ across architectures');
    }
    if (merged.core_commit && JSON.stringify(merged.tap_inputs) !== JSON.stringify(lock.tap_inputs)) throw new Error('Tap dependency inputs differ across architectures');
    merged.tap_inputs = lock.tap_inputs;
    merged.core_commit = lock.core_commit;
    if (lock.recipe_commits) merged.recipe_commits = recipes.validate(lock.recipe_commits);
    merged.platforms[arch] = validatePlatform(lock.platforms[arch], arch);
  }
  for (const name of Object.keys(merged.recipe_commits || {})) {
    if (!Object.values(merged.platforms).some(platform => platform.packages[name])) delete merged.recipe_commits[name];
  }
  fs.writeFileSync(output, JSON.stringify(merged, null, 2) + '\n');
}

async function promote(file) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== 'shivammathur/php-darwin' ||
      process.env.GITHUB_REF_NAME !== 'main') throw new Error('Dependency promotion requires the php-darwin main workflow');
  const lock = readLock(file);
  for (const arch of ['arm64', 'x86_64']) validatePlatform(lock.platforms[arch], arch);
  const cache = new ReleaseCache();
  const current = await cache.api('contents/conf/dependencies.json?ref=main');
  const expected = command('git', ['rev-parse', 'HEAD:conf/dependencies.json']).trim();
  if (current.sha !== expected) throw new Error('The approved dependency snapshot changed while this update ran');
  const content = fs.readFileSync(file);
  if (Buffer.from(current.content, 'base64').equals(content)) {
    console.log('Approved dependencies are already current');
    return;
  }
  await cache.api('contents/conf/dependencies.json', { method: 'PUT', body: {
    message: 'Update approved dependency bottles', branch: 'main', sha: current.sha,
    content: content.toString('base64'),
  } });
}

module.exports = { roots, merge };
if (require.main === module) {
  (async () => {
    const [mode, directory, output] = process.argv.slice(2);
    if (mode === 'clean') clean();
    else if (mode === 'prepare') await prepare();
    else if (mode === 'verify') await verify();
    else if (mode === 'merge') merge(directory, output);
    else if (mode === 'promote') await promote(directory);
    else throw new Error('Expected clean, prepare, verify, merge, or promote');
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
