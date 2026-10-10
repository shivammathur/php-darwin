const fs = require('node:fs');
const path = require('node:path');
const upstream = require('./upstream-bottle-cache.cjs');
const { retryPolicy, httpError } = require('../release/extension-transfers.cjs');
const { recordMetric } = require('../lib/build-metrics.cjs');
const { validate: validateRecipes } = require('./dependency-recipes.cjs');

const platforms = require('../../conf/platforms.json');
const defaultFile = path.resolve(__dirname, '../../conf/dependencies.json');
const formulaPattern = /^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/)?[A-Za-z0-9@+_.-]+$/;
const hex = /^[a-f0-9]{64}$/;

function readLock(file = defaultFile) {
  const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (lock.schema !== 1 || !/^[a-f0-9]{40}$/.test(lock.core_commit || '')) {
    throw new Error('Invalid approved dependency snapshot');
  }
  validateRecipes(lock.recipe_commits);
  return lock;
}

function validatePlatform(platform, arch) {
  if (!Object.hasOwn(platforms, arch) || !platform ||
      platform.prefix !== platforms[arch].brew_prefix ||
      !Number.isInteger(platform.macos) || platform.macos < 11 ||
      !platform.packages || !Object.keys(platform.packages).length) {
    throw new Error(`Dependency bottles have not been prepared for ${arch}`);
  }
  const { validKey } = require('./source-bottle-cache.cjs');
  for (const [formula, entry] of Object.entries(platform.packages)) {
    if (!formulaPattern.test(formula) || !/^[A-Za-z0-9+_.-]+$/.test(entry.version || '') ||
        Boolean(entry.bottle) === Boolean(entry.source)) throw new Error(`Invalid approved dependency: ${formula}`);
    if (entry.bottle) {
      upstream.validate(entry.bottle);
      if (entry.bottle.formula !== formula || entry.bottle.version !== entry.version) {
        throw new Error(`Approved bottle identity differs: ${formula}`);
      }
    } else {
      const { key, inputs, sha256 } = entry.source;
      const env = inputs?.environment;
      if (!hex.test(sha256 || '') || !inputs || !validKey(inputs, key) ||
          inputs.formula !== formula || inputs.version !== entry.version ||
          env?.arch !== arch || String(env.macos) !== String(platform.macos) || env.prefix !== platform.prefix) {
        throw new Error(`Approved source bottle identity differs: ${formula}`);
      }
    }
  }
  return platform;
}

function protectedSourceKeys(file = defaultFile) {
  if (!fs.existsSync(file)) return new Set();
  const lock = readLock(file);
  const {keyFor, legacyKeyFor} = require('./source-bottle-cache.cjs');
  return new Set(Object.values(lock.platforms || {}).flatMap(platform =>
    Object.values(platform.packages || {}).flatMap(entry => {
      if (!entry.source) return [];
      const {key, inputs} = entry.source;
      // A legacy restore changes only the local key, preserving its original
      // inputs and remote asset. Protect both identities until promotion.
      return inputs ? [key, keyFor(inputs), legacyKeyFor(inputs)] : [key];
    })));
}

class ApprovedDependencies {
  constructor(lock, { download = upstream.transfer, retry = retryPolicy({ attempts: 3, budget: 8, delay: 1000 }),
    updates = [], bottleUpdates = [], allowNewBottles = false,
    recordInstalled = (item, sha256) => fs.writeFileSync(path.join(item.prefix, '.php-darwin-source-sha256'), sha256 + '\n') } = {}) {
    this.lock = lock;
    this.download = download;
    this.retry = retry;
    this.updates = new Set(updates);
    this.bottleUpdates = new Set(bottleUpdates);
    this.allowNewBottles = allowNewBottles;
    this.recordInstalled = recordInstalled;
  }

  versions(environment) {
    this.platform = validatePlatform(this.lock.platforms?.[environment.arch], environment.arch);
    if (environment.prefix !== this.platform.prefix || Number(environment.macos) < this.platform.macos) {
      throw new Error('Runner cannot use the approved dependency platform');
    }
    // Explicit rebuilds still need their build dependencies when the formula
    // version is unchanged; only actual restores may prune those tools.
    return Object.fromEntries(Object.entries(this.platform.packages)
      .filter(([name]) => !this.updates.has(name)).map(([name, entry]) => [name, entry.version]));
  }

  validatePlan(plan, environment, { targets = [] } = {}) {
    this.versions(environment);
    this.targets = new Set(targets.filter(name => name.includes('/')));
    for (const item of plan) {
      if (!this.targets.has(item.full_name) && /^shivammathur\/php\/php(?:@\d+\.\d+)?(?:-debug)?(?:-zts)?$/.test(item.full_name) && !item.installed) {
        throw new Error(`Published PHP build tool is not installed: ${item.full_name}; restore its verified PHP archive before building extensions`);
      }
      if (!this.has(item)) continue;
      const entry = this.platform.packages[item.full_name];
      if (!entry || entry.version !== item.version) {
        throw new Error(`Dependency ${item.full_name} ${item.version} is not in the approved snapshot; run update-dependencies.yml before changing dependencies`);
      }
      // A corrected source bottle can retain the formula's version/revision.
      // Version equality alone must not retain the old binary on shared runners.
      if (entry.source && item.installed && item.installed_source_sha256 !== entry.source.sha256) item.installed = false;
    }
  }

  has(item) {
    if (this.updates.has(item.full_name)) return false;
    if (item.bottled && (this.bottleUpdates.has(item.full_name) ||
        (this.allowNewBottles && !this.platform?.packages[item.full_name]))) return false;
    // Requested PHP/extensions remain independently buildable. An installed
    // PHP runtime used to build extensions comes from its published archive.
    // All other dependencies, including tap-owned build tools, are approved.
    return Boolean(this.platform?.packages[item.full_name]) ||
      (!this.targets?.has(item.full_name) && !/^shivammathur\/php\/php(?:@\d+\.\d+)?(?:-debug)?(?:-zts)?$/.test(item.full_name));
  }

  async prefetch(plan, { cache, cacheRoot }) {
    const bottles = new Map();
    const items = plan.filter(item => !item.installed && this.has(item));
    const started = Date.now();
    await upstream.pool(items, 8, async item => {
      bottles.set(item.full_name, await this.fetchBottle(item, { cache, cacheRoot }));
    });
    if (items.length) recordMetric({ kind: 'prefetch', result: 'approved', count: items.length,
      elapsedMs: Date.now() - started });
    return bottles;
  }

  upstreamFile(record, cacheRoot) {
    return path.join(cacheRoot, 'approved', record.sha256,
      `${record.formula.split('/').at(-1)}--${record.version}.${record.tag}.bottle.tar.gz`);
  }

  async fetchBottle(item, { cache, cacheRoot }) {
    const entry = this.platform.packages[item.full_name];
    let bottle;
    if (entry.source) {
      const { readBottle } = require('./source-bottle-cache.cjs');
      const { key, inputs, sha256 } = entry.source;
      const directory = path.join(cacheRoot, key);
      fs.mkdirSync(directory, { recursive: true });
      try {
        bottle = readBottle(directory, key);
        if (bottle && JSON.parse(fs.readFileSync(path.join(directory, 'metadata.json'))).sha256 !== sha256) bottle = undefined;
      } catch { bottle = undefined; }
      if (!bottle) {
        const restored = await cache.restoreCache([directory], key, [], inputs);
        if (restored !== key) throw new Error(`Approved dependency bottle is unavailable: ${item.full_name}; dependency compilation is restricted to update-dependencies.yml`);
        bottle = readBottle(directory, key);
      }
      const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'metadata.json')));
      if (!bottle || metadata.sha256 !== sha256) throw new Error(`Approved dependency checksum differs: ${item.full_name}`);
    } else {
      const record = entry.bottle;
      const directory = path.join(cacheRoot, 'approved', record.sha256);
      fs.mkdirSync(directory, { recursive: true });
      bottle = this.upstreamFile(record, cacheRoot);
      if (!await upstream.validFile(bottle, record.sha256)) {
        await this.retry(`Approved bottle ${item.full_name}`, async () => {
          let status;
          try { status = await this.download(upstream.publicURL(record), bottle); } catch { status = 0; }
          if (status !== 200 || !await upstream.validFile(bottle, record.sha256)) {
            status = await this.download(record.url, bottle, { upstream: true });
            if (process.env.PHP_DARWIN_BOTTLE_MISSES) {
              fs.appendFileSync(process.env.PHP_DARWIN_BOTTLE_MISSES, JSON.stringify(record) + '\n');
            }
          }
          if (status !== 200) throw httpError(status, `Approved bottle download failed: ${item.full_name}`);
          if (!await upstream.validFile(bottle, record.sha256)) throw new Error(`Approved bottle checksum differs: ${item.full_name}`);
        });
      }
    }
    return path.resolve(bottle);
  }

  restore(items, { bottles, run, flags }) {
    // Verify every replacement before changing the prefix. Keep dependency
    // order and Homebrew's linking, relocation, receipts and post-install work,
    // but pay its startup and formula-loading costs only once for the batch.
    for (const item of items) {
      if (!bottles.has(item.full_name)) throw new Error(`Missing verified bottle: ${item.full_name}`);
    }
    const replaced = items.filter(item => item.installed_versions?.length || item.missing_build_files?.length);
    if (replaced.length) {
      run('brew', ['uninstall', '--formula', '--force', '--ignore-dependencies', ...replaced.map(item => item.full_name)],
        { inherit: true });
    }
    run('brew', ['install', '--formula', ...flags, '--force-bottle', ...items.map(item => bottles.get(item.full_name))],
      { inherit: true, env: { HOMEBREW_DEVELOPER: '1' } });
    for (const item of items) {
      const source = this.platform.packages[item.full_name].source;
      if (source) this.recordInstalled(item, source.sha256);
    }
    for (const item of items) console.log(`Restored approved dependency: ${item.full_name} ${item.version}`);
    return items.filter(item => this.platform.packages[item.full_name].source).length;
  }
}

module.exports = { readLock, validatePlatform, protectedSourceKeys, ApprovedDependencies, defaultFile };
if (require.main === module) {
  try {
    const lock = readLock(process.argv[3]);
    if (process.argv[2] === 'core') console.log(lock.core_commit);
    else if (process.argv[2] === 'check') {
      for (const arch of ['arm64', 'x86_64']) validatePlatform(lock.platforms?.[arch], arch);
    } else throw new Error('Expected core or check');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
