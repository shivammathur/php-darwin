// Bootstrap only missing archive tools from the approved binary snapshot.
// Current core recipes may require source-only dependencies on Intel even
// when the requested tool itself still has a compatible upstream bottle.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {command, environment, brewSource} = require('../cache/source-bottle-cache.cjs');
const {readLock, ApprovedDependencies} = require('../cache/approved-dependencies.cjs');
const {ReleaseCache} = require('../cache/source-bottle-releases.cjs');

async function restoreTools(tools, {lock = readLock(), platform = environment(), run = command,
  approved = new ApprovedDependencies(lock),
  cache = () => new ReleaseCache({repository: 'shivammathur/php-darwin', readOnly: true}),
  cacheRoot = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'php-darwin-archive-tools')} = {}) {
  if (!tools.length || tools.some(name => !['jq', 'zstd'].includes(name))) throw new Error('Invalid archive tool');
  approved.versions(platform);
  const packages = lock.platforms[platform.arch].packages;
  const visiting = new Set(), visited = new Set(), bottles = new Map(), items = [];
  let releaseCache;
  async function visit(name) {
    if (!/^[A-Za-z0-9@+_.-]+$/.test(name)) throw new Error('Invalid archive-tool dependency');
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error('Archive-tool dependency cycle');
    visiting.add(name);
    // Do not upgrade or replace libraries used by existing PHP installations.
    const selected = path.join(platform.prefix, 'opt', name);
    if (fs.existsSync(path.join(selected, 'INSTALL_RECEIPT.json'))) {
      visited.add(name); visiting.delete(name); return;
    }
    const entry = packages[name];
    if (!entry) throw new Error(`Archive-tool dependency is not approved: ${name}`);
    const item = {full_name: name, version: entry.version,
      prefix: path.join(platform.prefix, 'Cellar', name, entry.version)};
    if (entry.source && !releaseCache) releaseCache = cache();
    const bottle = await approved.fetchBottle(item, {cache: releaseCache, cacheRoot});
    // Upstream bottles omit INSTALL_RECEIPT.json. Both upstream and our cached
    // source bottles contain the exact .brew recipe used to produce them.
    const dependencies = JSON.parse(brewSource('tool-dependencies', [bottle, name, entry.version],
      {run, env: {HOMEBREW_DEVELOPER: '1'}}));
    if (!Array.isArray(dependencies)) throw new Error(`Missing runtime dependencies for ${name}`);
    for (const dep of dependencies) await visit(dep);
    bottles.set(name, bottle); items.push(item);
    visited.add(name); visiting.delete(name);
  }
  for (const name of tools) await visit(name);
  // Fetch and verify the complete runtime closure before modifying the prefix.
  // Explicit bottle paths plus --ignore-dependencies prevent Homebrew from
  // expanding today's recipes and compiling unrelated build dependencies.
  if (items.length) approved.restore(items, {bottles, run, flags: ['--verbose', '--ignore-dependencies']});
  for (const name of tools) {
    const binary = path.join(platform.prefix, 'bin', name);
    if (!fs.existsSync(binary)) run('brew', ['link', name], {inherit: true});
    run(binary, ['--version'], {inherit: true});
  }
  return items.map(item => item.full_name);
}

module.exports = {restoreTools};
if (require.main === module) restoreTools(process.argv.slice(2)).catch(error => {console.error(error); process.exitCode = 1;});
