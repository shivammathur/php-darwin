const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { install, command, environment, brewSource } = require('../../cache/source-bottle-cache.cjs');
const { ApprovedDependencies } = require('../../cache/approved-dependencies.cjs');
const { ReleaseCache } = require('../../cache/source-bottle-releases.cjs');

async function main() {
  if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true') throw new Error('Native Actions runner required');
  const tap = 'php-darwin/source-cache-test', app = `${tap}/php-darwin-cache-app`;
  const library = `${tap}/php-darwin-cache-lib`, tool = `${tap}/php-darwin-cache-tool@1`;
  const platform = environment(), packages = {};
  for (const key of fs.readdirSync('.source-bottle-cache')) {
    const metadata = JSON.parse(fs.readFileSync(path.join('.source-bottle-cache', key, 'metadata.json')));
    if (![library, tool].includes(metadata.inputs.formula)) continue;
    packages[metadata.inputs.formula] = {version: metadata.inputs.version, source: {
      key, inputs: metadata.inputs, sha256: metadata.sha256,
    }};
  }
  assert.equal(Object.keys(packages).length, 2);
  const approved = new ApprovedDependencies({platforms: {
    [platform.arch]: {prefix: platform.prefix, macos: Number(platform.macos), packages},
  }});
  const cache = new ReleaseCache({tag: process.env.CACHE_RELEASE});
  const events = [], installs = [];
  const run = (program, args, options) => {
    if (args.includes('--build-bottle')) events.push(args.at(-1));
    if (args[0] === 'install') installs.push(args);
    return command(program, args, options);
  };
  const options = {formula: app, cache, approvedDependencies: approved, run,
    // SDK changes are provenance only: both approved dependencies and the
    // already-cached consumer must remain reusable on the next runner image.
    buildEnvironment: () => ({...platform, sdk: `${platform.sdk}-native-regression`})};
  command('brew', ['uninstall', '--force', '--ignore-dependencies', app, library, tool], {inherit: true});
  fs.rmSync('.source-bottle-cache', {recursive: true});
  const tapDirectory = command('brew', ['--repository', tap]).trim();
  const libraryRecipe = path.join(tapDirectory, 'Formula/php-darwin-cache-lib.rb');
  const originalLibrary = fs.readFileSync(libraryRecipe, 'utf8');
  // This deliberately unavailable tool would make source compilation fail.
  // Restoring the approved library must never resolve its build dependencies.
  fs.writeFileSync(libraryRecipe, originalLibrary.replace('  def install',
    `  depends_on "${tap}/unneeded-build-tool" => :build\n  def install`));
  try {
    const plan = JSON.parse(brewSource('info', ['plan', JSON.stringify([app]), 'true',
      JSON.stringify(approved.versions(platform))]));
    assert.deepEqual(plan.map(item => item.full_name).sort(), [app, library, tool].sort());
    assert.deepEqual(await install(options), {built: 0, restored: 3});
  } finally { fs.writeFileSync(libraryRecipe, originalLibrary); }
  assert.equal(installs.length, 2, 'the two approved dependencies must share one Homebrew invocation');
  assert.equal(installs[0].filter(arg => arg.endsWith('.tar.gz')).length, 2);
  assert.ok(installs[0].includes('--as-dependency'));
  assert.deepEqual(events, []);
  assert.equal(command(path.join(platform.prefix, 'bin/php-darwin-cache-app'), []).trim(), '42');
  assert.deepEqual(await install(options), {built: 0, restored: 0});
  const libraryPrefix = command('brew', ['--prefix', library]).trim();
  fs.writeFileSync(path.join(libraryPrefix, '.php-darwin-source-sha256'), '0'.repeat(64) + '\n');
  assert.deepEqual(await install(options), {built: 0, restored: 1});
  assert.equal(command(path.join(platform.prefix, 'bin/php-darwin-cache-app'), []).trim(), '42');
  assert.deepEqual(await install(options), {built: 0, restored: 0});

  const rebuild = new ApprovedDependencies(approved.lock, {updates: [library]});
  fs.writeFileSync(libraryRecipe, originalLibrary.replace('  def install', '  depends_on "m4" => :build\n  def install'));
  try {
    const plan = JSON.parse(brewSource('info', ['seed', JSON.stringify([app]), 'true',
      JSON.stringify(rebuild.versions(platform))]));
    assert.ok(plan.some(item => item.full_name === 'm4'), 'a same-version rebuild must restore its build tools');
  } finally { fs.writeFileSync(libraryRecipe, originalLibrary); }

  const formula = path.join(tapDirectory, 'Formula/php-darwin-cache-tool@1.rb');
  const original = fs.readFileSync(formula, 'utf8');
  command('brew', ['uninstall', '--force', '--ignore-dependencies', app], {inherit: true});
  try {
    fs.writeFileSync(formula, original.replace('version "1.0.0"', 'version "1.0.1"'));
    events.length = 0;
    await assert.rejects(install(options), /not in the approved snapshot/);
    assert.deepEqual(events, []);
  } finally { fs.writeFileSync(formula, original); }
  assert.deepEqual(await install(options), {built: 0, restored: 1});
  console.log('Native approved dependencies and consumer survive toolchain changes; unapproved tool patches never compile or install');
}
main().catch(error => {console.error(error); process.exitCode = 1;});
