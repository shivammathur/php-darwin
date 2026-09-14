const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function command(program, args, { inherit = false, cwd, env } = {}) {
  const result = spawnSync(program, args, {
    cwd, env: { ...process.env, ...env }, encoding: 'utf8',
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'inherit'], maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} failed (${result.status})`);
  return result.stdout || '';
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function brewSource(mode, args) {
  return command('brew', ['php-darwin-source', mode, ...args], {
    env: { PATH: `${__dirname}${path.delimiter}${process.env.PATH}` },
  });
}

function keyFor(inputs) {
  return `php-darwin-source-v1-${digest(JSON.stringify(inputs))}`;
}

function inspect(mode, formulae, forceSource = false) {
  return JSON.parse(brewSource('info', [mode, JSON.stringify(formulae), String(forceSource)]));
}

function recipeHash(recipe) {
  return digest(command('bash', [path.join(__dirname, 'formula-build-inputs.sh'), recipe, 'source']));
}

function buildInputs(formula, environment) {
  const [info] = inspect('inputs', [formula.full_name]);
  return {
    environment, formula: info.full_name, version: info.version, recipe: recipeHash(info.recipe),
    dependencies: info.dependencies.map(dep => ({ ...dep, recipe: recipeHash(dep.recipe) })),
  };
}

function environment() {
  const buildEnv = {};
  for (const name of ['CC', 'CXX', 'CFLAGS', 'CXXFLAGS', 'CPPFLAGS', 'LDFLAGS',
    'MACOSX_DEPLOYMENT_TARGET', 'SDKROOT', 'HOMEBREW_CC', 'HOMEBREW_CXX', 'HOMEBREW_ARCH']) {
    buildEnv[name] = process.env[name] || '';
  }
  return {
    arch: command('uname', ['-m']).trim(),
    macos: command('sw_vers', ['-productVersion']).trim().split('.')[0],
    prefix: command('brew', ['--prefix']).trim(),
    homebrew: command('brew', ['--version']).trim().split('\n')[0].split('.')[0],
    compiler: command('xcrun', ['clang', '--version']).trim(),
    sdk: command('xcrun', ['--sdk', 'macosx', '--show-sdk-version']).trim(),
    buildEnv,
  };
}

function readBottle(directory, key) {
  const metadataPath = path.join(directory, 'metadata.json');
  if (!fs.existsSync(metadataPath)) return null;
  if (!fs.lstatSync(metadataPath).isFile()) throw new Error('Invalid bottle cache metadata');
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  if (metadata.key !== key || metadata.schema !== 1 ||
    typeof metadata.file !== 'string' || path.basename(metadata.file) !== metadata.file ||
    !/^[A-Za-z0-9@+_.-]+\.bottle(?:\.\d+)?\.tar\.gz$/.test(metadata.file) ||
    !/^[0-9a-f]{64}$/.test(metadata.sha256)) throw new Error('Invalid bottle cache identity');
  const bottle = path.join(directory, metadata.file);
  if (!fs.lstatSync(bottle).isFile() || digest(fs.readFileSync(bottle)) !== metadata.sha256) {
    throw new Error('Cached source bottle checksum mismatch');
  }
  return bottle;
}

async function install({ formula, cache, cacheRoot = '.source-bottle-cache',
  forceSource = false, skipLink = false, context,
  run = command, query = inspect, inputs = buildInputs, buildEnvironment = environment,
  log = console.log, warn = console.warn }) {
  if (!/^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/)?[A-Za-z0-9@+_.-]+$/.test(formula)) {
    throw new Error(`Invalid source cache formula: ${formula}`);
  }
  // Match the environment used by build.sh, including its preservation of
  // pinned, preinstalled dependencies. Do not cache or restore the whole Cellar.
  for (const option of ['NO_AUTO_UPDATE', 'NO_AUTOREMOVE', 'NO_ENV_HINTS',
    'NO_INSTALL_CLEANUP', 'NO_INSTALLED_DEPENDENTS_CHECK', 'NO_INSTALL_FROM_API']) {
    process.env[`HOMEBREW_${option}`] = '1';
  }
  const plan = query('plan', [formula], forceSource);
  const platform = buildEnvironment();
  const result = { built: 0, restored: 0 };
  for (const item of plan) {
    const target = item === plan.at(-1);
    const flags = target && skipLink ? ['--skip-link'] : [];
    if (item.installed) continue;
    if (item.bottled && !(target && forceSource)) {
      run('brew', ['install', '--formula', ...flags, item.full_name], { inherit: true });
      continue;
    }
    const build = inputs(item, platform);
    if (target && context) build.context = context;
    const key = keyFor(build);
    const directory = path.join(cacheRoot, key);
    fs.mkdirSync(directory, { recursive: true });
    let bottle;
    try {
      bottle = readBottle(directory, key);
      if (!bottle) {
        // Never use a partial/prefix match for compiled packages.
        const restoredKey = await cache.restoreCache([directory], key, []);
        if (restoredKey === key) bottle = readBottle(directory, key);
      }
    } catch (error) {
      warn(`Source cache unavailable for ${item.full_name}: ${error.message}`);
    }
    if (bottle) {
      log(`Restoring source bottle: ${item.full_name} ${item.version}`);
      run('brew', ['install', '--formula', ...flags, path.resolve(bottle)], { inherit: true });
      result.restored++;
      continue;
    }
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
    log(`Building source bottle: ${item.full_name} ${item.version}`);
    run('brew', ['install', '--formula', '--build-bottle', ...flags, item.full_name], { inherit: true });
    run('brew', ['bottle', '--json', '--no-rebuild', item.full_name], {
      inherit: true, cwd: path.resolve(directory),
    });
    const files = fs.readdirSync(directory).filter(file => file.endsWith('.tar.gz'));
    if (files.length !== 1) throw new Error(`Expected one bottle for ${item.full_name}`);
    const file = files[0];
    const sha256 = digest(fs.readFileSync(path.join(directory, file)));
    fs.writeFileSync(path.join(directory, 'metadata.json'), JSON.stringify({ schema: 1, key, file, sha256, inputs: build }));
    readBottle(directory, key);
    // --build-bottle skips post_install. Run it after bottling so first builds
    // and restored bottles both recreate PHP/PEAR and dependency configuration.
    if (item.post_install) run('brew', ['postinstall', item.full_name], { inherit: true });
    result.built++;
    try {
      await cache.saveCache([directory], key);
    } catch (error) {
      warn(`Could not save source bottle for ${item.full_name}: ${error.message}`);
    }
  }
  log(`Source bottles: ${result.restored} restored, ${result.built} built`);
  return result;
}

function extensionInputs(abstract, phpPrefix, build, ts, run = command) {
  const include = run(path.join(phpPrefix, 'bin/php-config'), ['--include-dir']).trim();
  const api = {};
  for (const [header, name] of [['main/php.h', 'PHP_API_VERSION'],
    ['Zend/zend_modules.h', 'ZEND_MODULE_API_NO'], ['Zend/zend_extensions.h', 'ZEND_EXTENSION_API_NO']]) {
    const match = fs.readFileSync(path.join(include, header), 'utf8').match(new RegExp(`^#define\\s+${name}\\s+(\\d+)`, 'm'));
    if (!match) throw new Error(`Missing ${name} in installed PHP headers`);
    api[name] = match[1];
  }
  return {
    build, ts, abstract: digest(fs.readFileSync(abstract)),
    php: {
      version: run(path.join(phpPrefix, 'bin/php'), ['-n', '-r', 'echo PHP_VERSION;']).trim(),
      api,
      configure: run(path.join(phpPrefix, 'bin/php-config'), ['--configure-options']).trim(),
      extensionDirectory: run(path.join(phpPrefix, 'bin/php-config'), ['--extension-dir']).trim(),
    },
  };
}

module.exports = { command, brewSource, keyFor, readBottle, install, extensionInputs };
