const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {storage, prefix, workdir, putJSON, getJSON, uploads, buildId} = require('./store.cjs');
const {selectSource, validateSource, prepareTap, seedCache, sourceName} = require('./source.cjs');
const {fingerprint} = require('../lib/r2.cjs');
const {command} = require('../cache/source-bottle-cache.cjs');
const {githubJSON, workflowJobs} = require('../release/extension-transfers.cjs');
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const variants = ['release-nts', 'release-zts', 'debug-nts', 'debug-zts'];
const repository = 'shivammathur/php-darwin';
const hex = /^[a-f0-9]{64}$/;
const permissionPolicy = 'public-readable-v1';
function validatePlan(plan, id) {
  buildId(id);
  const source = sourceName(plan.source?.name, plan.php_version);
  if (plan.schema !== 1 || plan.id !== id || plan.repository !== repository ||
      !/^[a-f0-9]{40}$/.test(plan.revision || '') || plan.php_version !== source.minor || plan.source.minor !== source.minor || plan.source.version !== source.version ||
      plan.source.url !== source.url || !hex.test(plan.source.sha256 || '') ||
      !Number.isSafeInteger(plan.source.bytes) || plan.source.bytes <= 0 || plan.source.bytes > 256 * 1024 ** 2 ||
      !['tap_commit', 'base_tap_commit', 'extensions_commit', 'core_commit'].every(key => /^[a-f0-9]{40}$/.test(plan[key] || '')) ||
      !hex.test(plan.tap_sha256 || '') || !Array.isArray(plan.builds) || plan.builds.length !== 8 || !Array.isArray(plan.tests) ||
      (plan.artifact_permissions !== undefined && plan.artifact_permissions !== permissionPolicy)) {
    throw new Error('Invalid private build plan');
  }
  const expected = ['arm64', 'x86_64'].flatMap(arch => variants.map(variant => `${arch}-${variant}`)).sort();
  if (JSON.stringify(plan.builds.map(b => `${b.arch}-${b.build}-${b.ts}`).sort()) !== JSON.stringify(expected) ||
      plan.tests.length < 2 || new Set(plan.tests.map(t => t.runner)).size !== plan.tests.length ||
      plan.tests.some(t => !['arm64', 'x86_64'].includes(t.arch) || !/^macos-[a-z0-9-]+$/.test(t.runner)) ||
      !['arm64', 'x86_64'].every(arch => plan.tests.some(t => t.arch === arch))) throw new Error('Incomplete private matrix');
  return plan;
}
function sign(payload, secret) {
  if (!/^[a-f0-9]{64}$/.test(secret || '')) throw new Error('Private release signing key is missing');
  return crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(JSON.stringify(payload)).digest('hex');
}
function verifyReady(record, id, secret, {allowBranch = false} = {}) {
  if (!record || !hex.test(record.signature || '') ||
      !crypto.timingSafeEqual(Buffer.from(record.signature, 'hex'), Buffer.from(sign(record.payload, secret), 'hex'))) {
    throw new Error('Private build approval signature mismatch');
  }
  const {plan, builds, tests} = record.payload;
  validatePlan(plan, id);
  if (!allowBranch && plan.ref !== 'refs/heads/main') throw new Error('Production publication requires a build from main');
  if (!Array.isArray(builds) || !Array.isArray(tests) || builds.length !== 8 || tests.length !== plan.tests.length) throw new Error('Incomplete approval');
  const planHash = sha(plan);
  for (const b of plan.builds) validateBuild(builds.find(r => r.variant === variantKey(b)), plan, b);
  for (const t of plan.tests) {
    const result = tests.find(r => r.runner === t.runner);
    const expectedBuilds = builds.filter(b => b.arch === t.arch).map(b => sha(b)).sort();
    if (!result || result.status !== 'success' || result.plan_sha256 !== planHash || result.arch !== t.arch ||
        JSON.stringify(result.build_sha256?.slice().sort()) !== JSON.stringify(expectedBuilds)) throw new Error('Unverified compatibility test');
  }
  return record.payload;
}
function variantKey(b) { return `${b.arch}-${b.build}-${b.ts}`; }
function names(plan, b) {
  const archive = `php_${plan.php_version}-${b.ts}-${b.build}+darwin_${b.arch}.tar.zst`;
  return [archive, archive + '.sha256', archive.slice(0, -8) + '.json'];
}
function validateBuild(record, plan, b) {
  const expected = names(plan, b);
  if (!record || record.variant !== variantKey(b) || record.arch !== b.arch || record.plan_sha256 !== sha(plan) ||
      record.status !== 'success' || (plan.artifact_permissions && record.artifact_permissions !== plan.artifact_permissions) ||
      !Array.isArray(record.files) || record.files.length !== expected.length ||
      JSON.stringify(record.files.map(f => f.name).sort()) !== JSON.stringify(expected.slice().sort()) ||
      record.files.some(f => !hex.test(f.sha256 || '') || !Number.isSafeInteger(f.bytes) || f.bytes <= 0 || f.bytes > 256 * 1024 ** 2)) {
    throw new Error('Invalid staged build record');
  }
  return record;
}
async function readPlan(store) { return validatePlan(await getJSON(store, `${prefix()}/plan.json`), process.env.PRIVATE_BUILD_ID); }
async function requireUnquarantined(store, id = process.env.PRIVATE_BUILD_ID) {
  if (await store.head(`${prefix(id)}/quarantine.json`)) throw new Error('Private build is quarantined');
}
function envFile(plan) {
  // Only validated values are written into the shell environment file.
  const env = {PHP_VERSION: plan.php_version, HOMEBREW_PHP_COMMIT: plan.tap_commit,
    HOMEBREW_EXTENSIONS_COMMIT: plan.extensions_commit, HOMEBREW_CORE_COMMIT: plan.core_commit,
    PHP_DARWIN_PRIVATE_SOURCE_SHA256: plan.source.sha256};
  const file = path.join(workdir(), 'build.env');
  fs.writeFileSync(file, Object.entries(env).map(([key, value]) => `export ${key}='${value}'`).join('\n') + '\n', {mode: 0o600});
}
async function planBuild(store) {
  const minor = process.env.PHP_VERSION;
  const inputs = process.env.GITHUB_EVENT_PATH ? JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH)).inputs || {} : {};
  process.env.SOURCE_FILE = inputs['source-file'] || process.env.SOURCE_FILE || '';
  process.env.SOURCE_SHA256 = inputs['source-sha256'] || process.env.SOURCE_SHA256 || '';
  command('bash', ['-c', '. scripts/lib/lib.sh; php_darwin_validate_channel "$PHP_VERSION" stable']);
  let source = selectSource(process.env.SOURCE_FILE ? [] : await uploads(), minor, process.env.SOURCE_FILE);
  const file = path.join(workdir(), source.name);
  await store.download(`uploads/${source.name}`, file);
  const expected = process.env.SOURCE_SHA256 || '';
  if (expected && !hex.test(expected)) throw new Error('Invalid expected source checksum');
  source = await validateSource(file, {...source, ...(expected ? {sha256: expected} : {})});
  const pin = kind => command('bash', ['scripts/build/source-commit.sh', kind], {env: {GITHUB_OUTPUT: ''}}).trim();
  const base = pin('php'), extensions = pin('extensions'), core = pin('core');
  const tap = path.join(workdir(), 'tap');
  const commit = prepareTap(tap, source, base);
  const snapshot = path.join(workdir(), 'snapshot');
  command('bash', ['scripts/build/create-tap-snapshot.sh', tap, commit, 'https://github.com/shivammathur/homebrew-php', 'main', snapshot]);
  const tar = path.join(workdir(), 'tap.tar.gz');
  command('tar', ['-czf', tar, '-C', snapshot, '.']);
  const platforms = JSON.parse(fs.readFileSync('conf/platforms.json'));
  const builds = Object.entries(platforms).flatMap(([arch, p]) => variants.map(v => {
    const [build, ts] = v.split('-'); return {arch, build, ts, runner: p.build_runner};
  }));
  const tests = Object.entries(platforms).flatMap(([arch, p]) => p.test_runners.filter(r => r !== 'macos-latest').map(runner => ({arch, runner})));
  const plan = {schema: 1, id: process.env.PRIVATE_BUILD_ID, repository, revision: process.env.GITHUB_SHA,
    ref: process.env.GITHUB_REF, php_version: minor, source, base_tap_commit: base, tap_commit: commit,
    extensions_commit: extensions, core_commit: core, tap_sha256: (await fingerprint(tar)).sha256, builds, tests,
    artifact_permissions: permissionPolicy};
  validatePlan(plan, plan.id);
  await store.ensure(file, `${prefix()}/inputs/${source.name}`, {replace: false});
  await store.ensure(tar, `${prefix()}/inputs/tap.tar.gz`, {replace: false});
  await putJSON(store, `${prefix()}/plan.json`, plan);
  const architectures = Object.entries(platforms).map(([arch, p]) => ({arch, runner: p.build_runner,
    test_runners: tests.filter(t => t.arch === arch).map(t => t.runner)}));
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `architectures=${JSON.stringify({include: architectures})}\n`);
}
async function prepare(store, mode) {
  const plan = await readPlan(store);
  envFile(plan);
  const tap = path.join(command('brew', ['--repository']).trim(), 'Library/Taps/shivammathur/homebrew-php');
  const state = {tap, hadTap: fs.existsSync(tap), cache: []};
  // Restore the CI runner's original tap even when compilation or testing fails.
  if (state.hadTap && !fs.lstatSync(tap).isDirectory()) throw new Error('Private staging requires a regular tap directory');
  if (state.hadTap) fs.cpSync(tap, path.join(workdir(), 'tap-before'), {recursive: true, verbatimSymlinks: true});
  fs.writeFileSync(path.join(workdir(), 'runner-state.json'), JSON.stringify(state));
  if (mode === 'build') {
    const file = path.join(workdir(), plan.source.name), tar = path.join(workdir(), 'tap.tar.gz');
    if (!await store.restore(`${prefix()}/inputs/${plan.source.name}`, file, plan.source.sha256) ||
        !await store.restore(`${prefix()}/inputs/tap.tar.gz`, tar, plan.tap_sha256)) throw new Error('Private inputs changed');
    await validateSource(file, plan.source);
    // The tar is produced by our pinned planning code and verified above.
    const snapshot = path.join(workdir(), 'tap');
    fs.mkdirSync(snapshot);
    command('tar', ['-xzf', tar, '-C', snapshot]);
  }
  return plan;
}
async function activateTap(store) {
  const plan = await readPlan(store);
  // pin-core updates Homebrew and its public taps. Import the private commit
  // only afterwards, so brew update never attempts to rebase candidate recipes.
  command('brew', ['tap', 'shivammathur/php']);
  const tap = command('brew', ['--repository', 'shivammathur/php']).trim();
  command('git', ['-C', tap, 'fetch', '--depth=1', path.join(workdir(), 'tap'), plan.tap_commit]);
  command('git', ['-C', tap, 'checkout', '--detach', '--force', plan.tap_commit]);
}
async function seed(store) {
  const plan = await readPlan(store);
  const file = path.join(workdir(), plan.source.name);
  await validateSource(file, plan.source);
  const stateFile = path.join(workdir(), 'runner-state.json');
  const state = JSON.parse(fs.readFileSync(stateFile));
  seedCache(file, plan.source, destination => {
    state.cache.push(destination);
    fs.writeFileSync(stateFile, JSON.stringify(state));
  });
}
function cleanLocal() {
  const stateFile = path.join(workdir(), 'runner-state.json');
  if (!fs.existsSync(stateFile)) return;
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Private cleanup requires an Actions runner');
  const state = JSON.parse(fs.readFileSync(stateFile));
  const tap = path.join(command('brew', ['--repository']).trim(), 'Library/Taps/shivammathur/homebrew-php');
  const cache = command('brew', ['--cache']).trim();
  if (state.tap !== tap || !Array.isArray(state.cache) || state.cache.some(file =>
    typeof file !== 'string' || !file.startsWith(cache + path.sep) || path.resolve(file) !== file)) throw new Error('Invalid private runner cleanup state');
  if (state.hadTap && !fs.existsSync(path.join(workdir(), 'tap-before'))) throw new Error('Original tap backup is missing; leaving the current tap intact');
  for (const file of state.cache) fs.rmSync(file, {force: true});
  // Native installers can make the tap root-owned. Restrict sudo to this exact
  // CI-owned tap, and replace it with the copy taken before private work began.
  command('sudo', ['-n', 'rm', '-rf', tap]);
  if (state.hadTap) command('sudo', ['-n', 'mv', path.join(workdir(), 'tap-before'), tap]);
  fs.rmSync(path.resolve('builds'), {recursive: true, force: true});
  fs.rmSync(stateFile);
}
async function saveBuild(store) {
  const plan = await readPlan(store), b = {arch: process.env.ARCH, build: process.env.BUILD, ts: process.env.TS};
  if (!plan.builds.some(v => variantKey(v) === variantKey(b))) throw new Error('Unexpected build');
  const files = [];
  const metadata = JSON.parse(fs.readFileSync(path.join('builds', names(plan, b)[2])));
  if (metadata.php_semver !== plan.source.version || metadata.homebrew_php_commit !== plan.tap_commit ||
      metadata.homebrew_extensions_commit !== plan.extensions_commit) throw new Error('Built PHP differs from staged source');
  command('python3', ['scripts/private/check-permissions.py', path.join('builds', names(plan, b)[0])]);
  for (const name of names(plan, b)) {
    const file = path.join('builds', name), digest = await fingerprint(file);
    await store.ensure(file, `${prefix()}/packages/${name}`, {replace: false});
    files.push({name, sha256: digest.sha256, bytes: digest.bytes});
  }
  const result = {status: 'success', plan_sha256: sha(plan), variant: variantKey(b), arch: b.arch, files,
    artifact_permissions: permissionPolicy};
  validateBuild(result, plan, b);
  await putJSON(store, `${prefix()}/results/build-${variantKey(b)}.json`, result);
}
async function fetchBuilds(store, plan, builds, directory) {
  fs.mkdirSync(directory, {recursive: true});
  // Independent transfers run together; every digest is checked before use.
  await Promise.all(builds.flatMap(record => record.files.map(async file => {
    const output = path.join(directory, file.name);
    if (!await store.restore(`${prefix()}/packages/${file.name}`, output, file.sha256) ||
        fs.statSync(output).size !== file.bytes) throw new Error('Staged package checksum mismatch');
  })));
}
async function testInputs(store) {
  const plan = await prepare(store, 'test');
  if (!plan.tests.some(t => t.arch === process.env.ARCH && t.runner === process.env.TEST_RUNNER)) throw new Error('Unexpected compatibility runner');
  const builds = [];
  for (const b of plan.builds.filter(b => b.arch === process.env.ARCH)) {
    builds.push(validateBuild(await getJSON(store, `${prefix()}/results/build-${variantKey(b)}.json`), plan, b));
  }
  await fetchBuilds(store, plan, builds, path.join(workdir(), 'packages'));
  fs.writeFileSync(path.join(workdir(), 'tested-builds.json'), JSON.stringify(builds));
}
async function testResult(store) {
  const plan = await readPlan(store), builds = JSON.parse(fs.readFileSync(path.join(workdir(), 'tested-builds.json')));
  await putJSON(store, `${prefix()}/results/test-${process.env.TEST_RUNNER}.json`, {status: 'success',
    plan_sha256: sha(plan), arch: process.env.ARCH, runner: process.env.TEST_RUNNER, build_sha256: builds.map(sha).sort()});
}
async function approve(store) {
  await requireUnquarantined(store);
  const plan = await readPlan(store), builds = [], tests = [];
  for (const b of plan.builds) builds.push(validateBuild(await getJSON(store, `${prefix()}/results/build-${variantKey(b)}.json`), plan, b));
  for (const t of plan.tests) tests.push(await getJSON(store, `${prefix()}/results/test-${t.runner}.json`));
  const payload = {plan, builds, tests};
  const record = {payload, signature: sign(payload, process.env.PRIVATE_RELEASE_SIGNING_KEY)};
  verifyReady(record, plan.id, process.env.PRIVATE_RELEASE_SIGNING_KEY, {allowBranch: true});
  await putJSON(store, `${prefix()}/ready.json`, record);
}
async function releaseInputs(store) {
  await requireUnquarantined(store);
  const record = await getJSON(store, `${prefix()}/ready.json`);
  const {plan, builds} = verifyReady(record, process.env.PRIVATE_BUILD_ID, process.env.PRIVATE_RELEASE_SIGNING_KEY);
  if (plan.php_version !== process.env.PHP_VERSION || plan.source.version !== process.env.RELEASE_VERSION ||
      plan.source.sha256 !== process.env.SOURCE_SHA256) throw new Error('Release inputs do not match approved source');
  // A public release must actually exist and contain the exact staged source.
  const file = path.join(workdir(), 'official-source');
  command('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https',
    '--retry', '2', '--retry-all-errors', '--connect-timeout', '15', '--max-time', '180', '--output', file, plan.source.url]);
  if ((await fingerprint(file)).sha256 !== plan.source.sha256) throw new Error('Official PHP source differs from approved build');
  await fetchBuilds(store, plan, builds, path.resolve('builds'));
}
async function archiveRun(store) {
  const id = process.env.PRIVATE_BUILD_ID;
  const runId = buildId(id).split('-')[0];
  const run = await githubJSON(`repos/${repository}/actions/runs/${runId}`);
  if (run.status !== 'completed' || run.path !== '.github/workflows/cache-private.yml' ||
      run.head_repository?.full_name !== repository || `${run.id}-${run.run_attempt}` !== id) throw new Error('Untrusted or unfinished private run');
  const jobs = await workflowJobs(`repos/${repository}/actions/runs/${runId}`, run.run_attempt);
  await putJSON(store, `${prefix()}/workflow.json`, {run, jobs});
  if (run.conclusion === 'success') {
    const record = await getJSON(store, `${prefix()}/ready.json`);
    const {plan} = verifyReady(record, id, process.env.PRIVATE_RELEASE_SIGNING_KEY, {allowBranch: true});
    if (plan.revision !== run.head_sha) throw new Error('Run revision differs from approval');
  }
  // Delete only after the private workflow record has been durably verified.
  command('gh', ['api', '--method', 'DELETE', `repos/${repository}/actions/runs/${runId}`]);
}
module.exports = {validatePlan, validateBuild, variantKey, names, sign, verifyReady, sha, requireUnquarantined};
if (require.main === module) {
  const operations = {plan: planBuild, prepare: store => prepare(store, 'build'), 'activate-tap': activateTap, seed,
    'save-build': saveBuild, 'test-inputs': testInputs, 'test-result': testResult, 'clean-local': cleanLocal,
    approve, release: releaseInputs, cleanup: archiveRun};
  Promise.resolve().then(() => {
    if (!operations[process.argv[2]]) throw new Error('Unknown private release operation');
    return operations[process.argv[2]](storage());
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
