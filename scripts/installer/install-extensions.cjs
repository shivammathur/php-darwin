#!/usr/bin/env node
// Standalone optional extension installer. No Homebrew operations or PHP installation.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const packs = { imagick: ['imagick'], mongodb: ['mongodb'], memcached: ['igbinary', 'msgpack', 'memcached'] };
const origins = ['https://github.com/shivammathur/php-darwin/releases/download/extensions',
  'https://artifacts.php-darwin.setup-php.com/extensions'];
const hex = /^[a-f0-9]{64}$/;
function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw result.error || new Error(`${program} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
function digest(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function safePath(value) {
  return typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f\\]/.test(value) &&
    !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..');
}
function validateContext(context) {
  if (!context || !/^(?:5\.6|7\.[0-4]|8\.[0-7])$/.test(context.php_version) ||
      !['arm64', 'x86_64'].includes(context.architecture) ||
      !['release', 'debug'].includes(context.build) || !['nts', 'zts'].includes(context.thread_safety)) {
    throw new Error('Unsupported extension cache configuration');
  }
  return context;
}
function key(entry) {
  validateContext(entry);
  if (!Object.hasOwn(packs, entry.name)) throw new Error('Unknown extension pack');
  return [entry.name, entry.php_version, entry.build, entry.thread_safety, entry.architecture].join('-');
}
function validateEntry(entry) {
  key(entry);
  if (entry.schema !== 1 || !hex.test(entry.sha256) || !hex.test(entry.inputs_sha256) ||
      !/^[0-9]{8}$/.test(entry.php_api) ||
      !Number.isInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > 180000000 ||
      !Number.isInteger(entry.minimum_macos) || entry.minimum_macos < 14 ||
      entry.file !== `${key(entry)}-${entry.sha256}.tar.zst`) throw new Error('Invalid extension cache metadata');
  return entry;
}
async function download(name, destination, { sha256, bytes, bases = origins } = {}) {
  if (!safePath(name) || name.includes('/')) throw new Error('Invalid download name');
  let lastError;
  for (const [index, base] of bases.entries()) {
    const temporary = `${destination}.partial`;
    try {
      // A stalled primary must not serialize minutes of retries before the mirror.
      const response = await fetch(`${base}/${name}`, { signal: AbortSignal.timeout(index === 0 ? 3000 : 20000) });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      let received = 0;
      const hash = crypto.createHash('sha256');
      const limit = bytes || 2000000;
      await pipeline(Readable.fromWeb(response.body), async function* (source) {
        for await (const chunk of source) {
          received += chunk.length;
          if (received > limit) throw new Error('Download exceeds expected size');
          hash.update(chunk);
          yield chunk;
        }
      }, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      if ((bytes && received !== bytes) || (sha256 && hash.digest('hex') !== sha256)) {
        throw new Error('Extension archive checksum/size mismatch');
      }
      await fsp.rename(temporary, destination);
      return;
    } catch (error) {
      lastError = error;
      await fsp.rm(temporary, { force: true });
    }
  }
  throw new Error(`Could not download ${name}: ${lastError.message}`);
}
async function prefetch(directory, context, requested, options = {}) {
  const started = performance.now();
  validateContext(context);
  const names = [...new Set(requested)];
  if (!names.length || names.some(name => !Object.hasOwn(packs, name))) throw new Error('Invalid requested extensions');
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(directory, 'manifest.json');
  await download(`extensions-${context.php_version}-manifest.json`, manifestPath, options);
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  if (manifest.schema !== 1 || !Array.isArray(manifest.assets)) throw new Error('Invalid extension manifest');
  const results = await Promise.allSettled(names.map(async name => {
    const candidates = manifest.assets.filter(entry => entry.name === name &&
      Object.entries(context).every(([field, value]) => entry[field] === value));
    if (candidates.length !== 1) throw new Error(`No unique compatible archive for ${name}`);
    const entry = validateEntry(candidates[0]);
    console.log(`Downloading ${name} cache (${entry.bytes} bytes)`);
    await download(entry.file, path.join(directory, entry.file), { ...options, sha256: entry.sha256, bytes: entry.bytes });
    await fsp.writeFile(path.join(directory, `${name}.json`), JSON.stringify(entry));
    return name;
  }));
  results.forEach((result, index) => {
    if (result.status === 'rejected') console.warn(`Extension cache ${names[index]}: ${result.reason.message}`);
  });
  console.log(`Extension cache downloads completed in ${((performance.now() - started) / 1000).toFixed(3)} seconds`);
  return results.filter(result => result.status === 'fulfilled').map(result => result.value);
}
function phpApi(phpConfig = 'php-config') {
  const include = command(phpConfig, ['--include-dir']);
  const header = fs.readFileSync(path.join(include, 'Zend/zend_modules.h'), 'utf8');
  const match = header.match(/^#define\s+ZEND_MODULE_API_NO\s+(\d{8})\b/m);
  if (!match) throw new Error('Missing PHP module API in installed headers');
  return match[1];
}
function runtimeContext(phpConfig = 'php-config', php = 'php') {
  const value = command(php, ['-n', '-r', 'echo PHP_MAJOR_VERSION,".",PHP_MINOR_VERSION," ",PHP_DEBUG," ",PHP_ZTS;']).split(' ');
  return { php_version: value[0], build: value[1] === '1' ? 'debug' : 'release',
    thread_safety: value[2] === '1' ? 'zts' : 'nts',
    architecture: process.arch === 'arm64' ? 'arm64' : 'x86_64',
    php_api: phpApi(phpConfig), extension_dir: command(phpConfig, ['--extension-dir']) };
}
function inspectTree(root) {
  function walk(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isSymbolicLink()) {
        const target = fs.readlinkSync(file);
        if (path.isAbsolute(target) || !path.resolve(path.dirname(file), target).startsWith(root + path.sep) ||
            !fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep)) throw new Error('Unsafe pack symlink');
      } else if (item.isDirectory()) walk(file);
      else if (!item.isFile()) throw new Error('Unsupported pack member');
    }
  }
  walk(root);
}
function packEnvironment(metadata, destination) {
  const environment = {};
  for (const [name, values] of Object.entries(metadata.environment || {})) {
    if (!['MAGICK_CONFIGURE_PATH', 'MAGICK_CODER_MODULE_PATH', 'MAGICK_FILTER_MODULE_PATH', 'SASL_PATH'].includes(name) ||
        !Array.isArray(values) || !values.every(safePath)) throw new Error('Invalid pack environment');
    environment[name] = values.map(value => path.join(destination, value)).join(path.delimiter);
  }
  return environment;
}
function relocateResources(metadata, stage, destination) {
  if (!Array.isArray(metadata.relocations)) throw new Error('Missing resource relocation metadata');
  for (const relative of metadata.relocations) {
    if (!safePath(relative) || !relative.endsWith('.la')) throw new Error('Unsafe resource relocation');
    const file = path.join(stage, relative);
    if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 1000000) throw new Error('Invalid resource descriptor');
    const content = fs.readFileSync(file, 'utf8');
    if (!content.includes('@PHP_DARWIN_EXTENSION_ROOT@')) throw new Error('Missing resource relocation marker');
    fs.writeFileSync(file, content.replaceAll('@PHP_DARWIN_EXTENSION_ROOT@', destination));
  }
}
function install(directory, name, { phpConfig = 'php-config', php = 'php' } = {}) {
  const started = performance.now();
  if (!Object.hasOwn(packs, name)) throw new Error('Unknown extension pack');
  const entry = validateEntry(JSON.parse(fs.readFileSync(path.join(directory, `${name}.json`), 'utf8')));
  const actual = runtimeContext(phpConfig, php);
  if (entry.name !== name || !['php_version', 'build', 'thread_safety', 'architecture', 'php_api'].every(field => actual[field] === entry[field])) {
    throw new Error('Extension cache does not match installed PHP');
  }
  if (Number(command('sw_vers', ['-productVersion']).split('.')[0]) < entry.minimum_macos) throw new Error('Extension cache requires newer macOS');
  const prefix = actual.architecture === 'arm64' ? '/opt/homebrew' : '/usr/local';
  if (!actual.extension_dir.startsWith(prefix + '/') || !fs.statSync(actual.extension_dir).isDirectory()) throw new Error('Invalid PHP extension directory');
  const archive = path.join(directory, entry.file);
  const data = fs.readFileSync(archive);
  if (data.length !== entry.bytes || digest(data) !== entry.sha256) throw new Error('Extension archive changed after download');
  const store = path.join(prefix, 'var/php-darwin/extensions');
  fs.mkdirSync(store, { recursive: true });
  if (fs.realpathSync(store) !== store) throw new Error('Extension store traverses a symlink');
  const destination = path.join(store, entry.sha256);
  const stage = fs.mkdtempSync(path.join(store, '.install-'));
  const previous = [];
  let committed = false;
  try {
    const listing = command('tar', ['--zstd', '-tf', archive]).split('\n');
    if (!listing.every(member => safePath(member.replace(/\/$/, '')))) throw new Error('Unsafe extension archive path');
    command('tar', ['--zstd', '--no-same-owner', '-xf', archive, '-C', stage]);
    inspectTree(stage);
    const metadata = JSON.parse(fs.readFileSync(path.join(stage, 'metadata.json'), 'utf8'));
    if (metadata.schema !== 1 || key(metadata) !== key(entry) || metadata.php_api !== entry.php_api ||
        metadata.inputs_sha256 !== entry.inputs_sha256 || JSON.stringify(metadata.modules) !== JSON.stringify(packs[name])) {
      throw new Error('Extension archive metadata mismatch');
    }
    for (const module of metadata.modules) {
      if (!fs.lstatSync(path.join(stage, 'modules', `${module}.so`)).isFile()) throw new Error('Missing extension module');
    }
    relocateResources(metadata, stage, destination);
    if (!fs.existsSync(destination)) fs.renameSync(stage, destination);
    else {
      if (fs.realpathSync(destination) !== destination ||
          fs.readFileSync(path.join(destination, 'metadata.json'), 'utf8') !== fs.readFileSync(path.join(stage, 'metadata.json'), 'utf8')) {
        throw new Error('Installed private extension cache is inconsistent');
      }
      inspectTree(destination);
    }
    // mkdtemp creates a private staging directory. Installed runtime files must
    // also be readable by PHP processes running under another account.
    fs.chmodSync(destination, 0o755);
    const environment = packEnvironment(metadata, destination);
    const args = metadata.modules.flatMap(module => ['-d', `extension=${path.join(destination, 'modules', `${module}.so`)}`]);
    command(php, ['-n', ...args, '-r', `exit(extension_loaded('${name}') ? 0 : 1);`], { env: { ...process.env, ...environment } });
    // Only install modules after the entire private pack loads successfully.
    for (const module of metadata.modules) {
      const target = path.join(actual.extension_dir, `${module}.so`);
      // Serializer modules can already be supplied by the PHP cache or user.
      if (module !== name && fs.existsSync(target)) continue;
      const backup = path.join(directory, `${module}.previous`);
      let hadPrevious = false;
      try { fs.lstatSync(target); fs.renameSync(target, backup); hadPrevious = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      previous.push({ target, backup, hadPrevious });
      fs.symlinkSync(path.join(destination, 'modules', `${module}.so`), target);
    }
    const installedArgs = metadata.modules.flatMap(module => ['-d', `extension=${path.join(actual.extension_dir, `${module}.so`)}`]);
    command(php, ['-n', ...installedArgs, '-r', `exit(extension_loaded('${name}') ? 0 : 1);`], { env: { ...process.env, ...environment } });
    fs.writeFileSync(path.join(directory, `${name}.env`), Object.entries(environment).map(([variable, value]) => `${variable}=${value}\n`).join(''));
    fs.writeFileSync(path.join(directory, `${name}.modules`), metadata.modules.join('\n') + '\n');
    committed = true;
    console.log(`Installed ${name} from its separate extension cache in ${((performance.now() - started) / 1000).toFixed(3)} seconds`);
    return { modules: metadata.modules, environment, destination };
  } finally {
    if (!committed) for (const item of previous.reverse()) {
      fs.rmSync(item.target, { force: true });
      if (item.hadPrevious) fs.renameSync(item.backup, item.target);
    }
    else for (const item of previous) if (item.hadPrevious) fs.rmSync(item.backup, { force: true });
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
module.exports = { packs, origins, command, digest, safePath, key, validateContext, validateEntry, phpApi,
  download, prefetch, runtimeContext, inspectTree, packEnvironment, relocateResources, install };
if (require.main === module) (async () => {
  const [mode, directory, ...args] = process.argv.slice(2);
  if (!directory) throw new Error('Extension staging directory required');
  if (mode === 'prefetch') {
    const [php_version, build, thread_safety, architecture, ...names] = args;
    await prefetch(directory, { php_version, build, thread_safety, architecture }, names);
  } else if (mode === 'install' && args.length === 1) install(directory, args[0]);
  else throw new Error('Usage: install-extensions.cjs prefetch|install DIRECTORY ...');
})().catch(error => { console.error(`php-darwin extensions: ${error.message}`); process.exitCode = 1; });
