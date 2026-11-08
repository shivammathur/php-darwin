const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {command, environment, brewSource} = require('../../cache/source-bottle-cache.cjs');
const {readLock, ApprovedDependencies} = require('../../cache/approved-dependencies.cjs');
const {roots} = require('../../cache/update-dependencies.cjs');

assert.equal(process.platform, 'darwin');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.PHP_DARWIN_CACHE_ONLY, 'true');
const lock = readLock(), platform = environment(), approved = new ApprovedDependencies(lock);
const requested = roots();
const graph = JSON.parse(brewSource('info', ['seed', JSON.stringify(requested), 'true', JSON.stringify(approved.versions(platform))]));
const targets = [...new Set([...requested, ...graph.filter(item => item.requested).map(item => item.full_name)])].filter(name => name.includes('/'));
approved.validatePlan(graph, platform, {targets});
const dependencies = graph.filter(item => !targets.includes(item.full_name));
for (const item of dependencies) assert.ok(lock.platforms[platform.arch].packages[item.full_name], `Unapproved dependency: ${item.full_name}`);
fs.writeFileSync(`dependencies-${platform.arch}.json`, JSON.stringify(lock, null, 2) + '\n');
// The existing native verifier empties the installed prefix, restores every
// approved package, checks linkage, and repeats the warm path with zero builds.
command(process.execPath, [path.join(__dirname, '../../cache/update-dependencies.cjs'), 'verify'], {inherit: true});
const result = JSON.parse(fs.readFileSync(`dependency-verification-${platform.arch}.json`));
assert.equal(result.cold_source_builds, 0);
assert.equal(result.hot_source_builds, 0);
fs.writeFileSync(`cache-coverage-${platform.arch}.json`, JSON.stringify({
  architecture: platform.arch, roots: requested, resolved_dependencies: dependencies.map(item => item.full_name),
  approved_dependencies: result.dependencies, cold_source_builds: 0, hot_source_builds: 0,
}, null, 2) + '\n');
