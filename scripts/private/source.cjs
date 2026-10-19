const fs = require('node:fs');
const path = require('node:path');
const {fingerprint} = require('../lib/r2.cjs');
const {command} = require('../cache/source-bottle-cache.cjs');

function sourceName(name, minor) {
  const match = /^php-((?:5\.6|7\.[0-4]|8\.[0-7])\.(?:0|[1-9]\d*))\.tar\.(xz|gz)$/.exec(name || '');
  if (!match || (minor && !match[1].startsWith(minor + '.'))) throw new Error('Source filename does not match PHP minor');
  return {name, version: match[1], minor: match[1].split('.').slice(0, 2).join('.'),
    url: `https://www.php.net/distributions/${name}`};
}
function selectSource(keys, minor, requested) {
  if (requested) return sourceName(requested, minor);
  const sources = keys.filter(key => key.startsWith('uploads/')).flatMap(key => {
    try { return [sourceName(key.slice(8), minor)]; } catch { return []; }
  });
  // Do not silently select a different upload when several candidates exist.
  if (sources.length !== 1) throw new Error('Specify source-file when uploads contains zero or multiple archives for this minor');
  return sources[0];
}
function rewriteFormula(text, source) {
  if ((text.match(/^  url /gm) || []).length !== 1 || (text.match(/^  sha256 /gm) || []).length !== 1) {
    throw new Error('Unsupported stable PHP formula');
  }
  return text.replace(/^  url .*$/m, `  url "${source.url}"`)
    .replace(/^  sha256 .*$/m, `  sha256 "${source.sha256}"`)
    .replace(/^  (?:mirror |version |revision ).*\n/gm, '')
    .replace(/^  bottle do\n[\s\S]*?^  end\n/m, '');
}
async function validateSource(file, source) {
  const actual = await fingerprint(file);
  if (actual.bytes > 256 * 1024 ** 2 || (source.sha256 && source.sha256 !== actual.sha256)) throw new Error('Source archive checksum/size mismatch');
  // Inspect without extracting or executing uploaded source code.
  const root = `php-${source.version}`;
  const members = command('tar', ['-tf', file]).trim().split('\n');
  if (!members.length || members.some(name => !name.startsWith(root + '/') || name.split('/').includes('..') || /[\x00-\x1f]/.test(name))) {
    throw new Error('Invalid source archive members');
  }
  const header = `${root}/main/php_version.h`;
  if (members.filter(name => name === header).length !== 1 || !members.includes(`${root}/configure`)) throw new Error('Not a PHP release tarball');
  const version = command('tar', ['-xOf', file, header]).match(/^#define PHP_VERSION "([^"]+)"$/m)?.[1];
  if (version !== source.version) throw new Error('Source header version differs from filename');
  return {...source, sha256: actual.sha256, bytes: actual.bytes};
}
function rewriteTap(directory, source) {
  directory = fs.realpathSync(directory);
  const formulaRoot = path.join(directory, 'Formula') + path.sep;
  const files = new Set();
  for (const suffix of ['', '-zts', '-debug', '-debug-zts']) {
    const name = `php@${source.minor}${suffix}`;
    const direct = path.join(directory, 'Formula', name + '.rb');
    const file = fs.realpathSync(fs.existsSync(direct) ? direct : path.join(directory, 'Aliases', name));
    if (!file.startsWith(formulaRoot) || !file.endsWith('.rb') || !fs.statSync(file).isFile() || files.has(file)) {
      throw new Error('Invalid PHP formula aliases');
    }
    files.add(file);
  }
  for (const file of files) fs.writeFileSync(file, rewriteFormula(fs.readFileSync(file, 'utf8'), source));
}
function prepareTap(directory, source, commit) {
  command('git', ['clone', '--no-checkout', '--depth=1', 'https://github.com/shivammathur/homebrew-php', directory]);
  directory = fs.realpathSync(directory);
  command('git', ['-C', directory, 'fetch', '--depth=1', 'origin', commit]);
  command('git', ['-C', directory, 'checkout', '--detach', commit]);
  rewriteTap(directory, source);
  const treeEnv = {...process.env, GIT_AUTHOR_NAME: 'PHP Darwin', GIT_AUTHOR_EMAIL: 'builds@setup-php.com',
    GIT_COMMITTER_NAME: 'PHP Darwin', GIT_COMMITTER_EMAIL: 'builds@setup-php.com',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z'};
  command('git', ['-C', directory, 'add', 'Formula']);
  command('git', ['-C', directory, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', `Prepare PHP ${source.version}`], {env: treeEnv});
  return command('git', ['-C', directory, 'rev-parse', 'HEAD']).trim();
}
function seedCache(file, source, beforeCopy = () => {}) {
  for (const suffix of ['', '-zts', '-debug', '-debug-zts']) {
    const formula = `shivammathur/php/php@${source.minor}${suffix}`;
    const destination = command('brew', ['--cache', '--build-from-source', formula]).trim();
    const root = command('brew', ['--cache']).trim();
    if (!destination.startsWith(root + path.sep) || destination.includes('\n')) throw new Error('Unexpected Homebrew source cache path');
    beforeCopy(destination);
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    fs.rmSync(destination, {force: true});
    fs.copyFileSync(file, destination);
  }
}
module.exports = {sourceName, selectSource, rewriteFormula, rewriteTap, validateSource, prepareTap, seedCache};
