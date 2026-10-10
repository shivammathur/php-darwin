const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {capture, changed} = require('../../cache/dependency-inputs.cjs');
const {selectRecipes, resolvePlan} = require('../../cache/dependency-transition.cjs');
const {ready, fingerprint, title, workflow, orchestrate, validateWorker} = require('../../cache/dependency-workers.cjs');
const {gate} = require('../../cache/dependency-gate.cjs');
const {checker} = require('../../release/php-ready.cjs');
const hash = 'a'.repeat(40), latest = 'b'.repeat(40);
function graph(name, dependencies = [], extra = {}) {
  return {full_name: name, version: '1.0', requested: false, bottled: false, recipe_sha256: 'old',
    runtime_dependencies: dependencies.map(name => ({name, version: '1.0'})), runtime_formulae: dependencies,
    required_formulae: dependencies, ...extra};
}
test('tap dependency fingerprints ignore releases and bottle churn, identify only changed declarations and retain guards', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-dependency-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.mkdirSync(path.join(dir, 'Formula'));
  const file = path.join(dir, 'Formula/php.rb');
  const write = (ssl, version = '1.0', condition = 'Hardware::CPU.arm?') => fs.writeFileSync(file,
    `class PHP < Formula\n  url "https://example.invalid/php-${version}.tar.gz"\n  depends_on "cmake" => :build\n  depends_on "${ssl}" if ${condition}\n  bottle do\n    sha256 arm64_sonoma: "${version}"\n  end\nend\n`);
  write('openssl@3');
  execFileSync('git', ['-C', dir, 'init', '-q']); execFileSync('git', ['-C', dir, 'add', '.']);
  const before = capture({'homebrew-php': dir});
  write('openssl@3', '2.0');
  assert.equal(changed(before, capture({'homebrew-php': dir})).changed, false);
  write('openssl@4', '2.0');
  const after = capture({'homebrew-php': dir});
  assert.deepEqual(changed(before, after).formulae, ['openssl@3', 'openssl@4']);
  write('openssl@4', '2.0', 'Hardware::CPU.intel?');
  assert.equal(changed(after, capture({'homebrew-php': dir})).changed, true);
  fs.writeFileSync(file, 'invalid ruby = (');
  assert.throws(() => capture({'homebrew-php': dir}), /Cannot parse/);
});
test('selective OpenSSL transition follows consumers without advancing unrelated CMake', () => {
  const before = [graph('openssl@3'), graph('curl', ['openssl@3']), graph('python@3.14', ['openssl@3']), graph('cmake')];
  const after = [graph('openssl@4', [], {recipe_sha256: 'new'}), graph('curl', ['openssl@4'], {recipe_sha256: 'new'}),
    graph('python@3.14', ['openssl@4'], {recipe_sha256: 'new'}), graph('cmake', [], {version: '99', recipe_sha256: 'new'}),
    graph('shivammathur/php/php', ['curl', 'openssl@4'], {requested: true})];
  const lock = {core_commit: hash, platforms: {arm64: {packages: Object.fromEntries(before.map(item => [item.full_name, {}]))}}};
  const result = selectRecipes(lock, [{before, after}], {formulae: ['openssl@3', 'openssl@4']}, latest);
  assert.equal(result.core_commit, hash);
  assert.deepEqual(result.updates, ['curl', 'openssl@4', 'python@3.14']);
  assert.equal(result.recipe_commits.cmake, undefined);
});
test('native plan separates required tools from linked libraries and schedules only necessary parents', () => {
  const items = [graph('openssl@4'), graph('python@3.14', ['openssl@4']), graph('cmake'),
    graph('libvmaf', [], {required_formulae: ['python@3.14']}), graph('curl', ['openssl@4']),
    graph('shivammathur/php/php', ['openssl@4', 'curl', 'libvmaf'], {requested: true, required_formulae: ['cmake', 'curl', 'libvmaf']})];
  const result = resolvePlan(items, {cmake: {version: '1.0'}});
  assert.deepEqual(result.updates, ['curl', 'libvmaf', 'openssl@4', 'python@3.14']);
  assert.equal(result.workers.find(node => node.formula === 'python@3.14').kind, 'tool');
  assert.equal(workflow(result.workers.find(node => node.formula === 'curl')), 'prepare-dependency.yml');
  const state = {'openssl@4': {conclusion: 'success'}};
  assert.deepEqual(ready(result.workers, state).map(node => node.formula), ['python@3.14', 'curl']);
  state['python@3.14'] = {conclusion: 'failure'};
  assert.equal(ready(result.workers, state).some(node => node.formula === 'libvmaf'), false);
  assert.throws(() => resolvePlan([graph('a', ['b']), graph('b', ['a'])], {}), /cycle/);
});
test('orchestrator dispatches independent formulae and architectures before polling; resumes exact existing runs', async () => {
  const plans = ['arm64', 'x86_64'].map(arch => ({arch, revision: hash, workers: [
    {formula: 'python', kind: 'tool', needs: []}, {formula: 'curl', kind: 'runtime', needs: []}, {formula: 'vmaf', kind: 'runtime', needs: ['python']},
  ]}));
  const runs = [], calls = []; let time = 0, first = true;
  const run = args => {
    calls.push(args);
    if (args.at(-1).endsWith('/actions/runs/123')) return JSON.stringify({created_at: '2026-10-10T00:00:00Z'});
    if (args.at(-1).includes('/commits/')) return JSON.stringify({sha: hash});
    if (args[0] === 'api') return JSON.stringify([{workflow_runs: runs.filter(item => args.at(-1).includes(item.path.split('/').at(-1)))}]);
    const field = name => args.find(item => item.startsWith(`${name}=`)).split('=')[1];
    const plan = plans.find(item => item.arch === field('architecture'));
    const node = plan.workers.find(item => item.formula === field('formula'));
    runs.push({id: runs.length + 1, head_sha: hash, path: `.github/workflows/${args[2]}`,
      display_title: title(node, plan, '123'), status: 'in_progress', conclusion: null});
    return '';
  };
  const options = {id: '123', revision: hash, ref: 'main', run, save: () => {}, now: () => time, sleep: async ms => {
    if (first) { assert.equal(runs.length, 4, 'both architectures and both independent roots dispatched before waiting'); first = false; }
    time += ms;
    for (const run of runs) { run.status = 'completed'; run.conclusion = 'success'; }
  }};
  await orchestrate(plans, options);
  assert.equal(runs.length, 6);
  calls.length = 0;
  await orchestrate(plans, options);
  assert.equal(calls.filter(args => args[0] === 'workflow').length, 0);
});
test('worker rejects the wrong workflow class, source revision or unsatisfied prerequisite', () => {
  const plan = {arch: 'arm64', revision: hash, workers: [{formula: 'python', kind: 'tool', needs: []}, {formula: 'vmaf', kind: 'runtime', needs: ['python']}]};
  const context = {id: '123', key: fingerprint(plan), formula: 'vmaf', arch: 'arm64', kind: 'runtime', revision: hash,
    parent: {path: '.github/workflows/update-dependencies.yml', head_sha: hash, head_repository: {full_name: 'shivammathur/php-darwin'}}, runs: []};
  assert.throws(() => validateWorker(plan, context), /not succeeded/);
  context.runs.push({display_title: title(plan.workers[0], plan, '123'), head_sha: hash, path: '.github/workflows/prepare-build-tool.yml', status: 'completed', conclusion: 'success'});
  assert.equal(validateWorker(plan, context).formula, 'vmaf');
  assert.throws(() => validateWorker(plan, {...context, kind: 'tool'}), /assigned/);
  assert.throws(() => validateWorker(plan, {...context, revision: latest}), /Untrusted/);
});
test('dependency gate does not duplicate queued runs and unchanged declarations do not query Actions', () => {
  const inputs = {records: {a: {sha256: 'x', formulae: []}}}, calls = [];
  assert.equal(gate({lock: {tap_inputs: inputs}, inputs, dispatch: true, run: () => assert.fail('No query required')}), true);
  assert.equal(gate({lock: {}, inputs, dispatch: true, run: args => { calls.push(args); return JSON.stringify([{workflow_runs: [{status: 'queued'}]}]); }}), false);
  assert.ok(calls.every(args => args[0] === 'api'));
});
test('optional extensions defer for queued PHP jobs, failed validation and stale published inputs', () => {
  const success = {id: 1, display_title: 'Cache stable PHP 8.4', status: 'completed', conclusion: 'success'};
  const manifest = {};
  assert.equal(checker({runs: [{...success, status: 'queued'}], run: () => assert.fail('No freshness probe while running')})('8.4', manifest), false);
  assert.equal(checker({runs: [{...success, conclusion: 'failure'}], run: () => assert.fail('No probe after failure')})('8.4', manifest), false);
  for (const stale of [true, false]) assert.equal(checker({runs: [success], run: (_args, env) => fs.writeFileSync(env.GITHUB_OUTPUT, `build-required=${stale}\n`)})('8.4', manifest), !stale);
});

test('automatic retirement removes only graphless entries and retains build-tool runtime provenance', () => {
  const {pruneUnusedDependencies} = require('../../cache/retired-dependencies.cjs');
  const packages = {
    curl: {source: {inputs: {dependencies: [{name: 'cmake', runtime_dependencies: [{full_name: 'python'}]}]}}},
    cmake: {version: '1'}, python: {source: {inputs: {dependencies: [{name: 'openssl@4'}]}}},
    'openssl@4': {version: '4'}, 'openssl@3': {version: '3'},
  };
  const retained = pruneUnusedDependencies(packages, [{full_name: 'curl'}, {full_name: 'openssl@4'}]);
  assert.deepEqual(Object.keys(retained), ['curl', 'cmake', 'python', 'openssl@4']);
});

test('a Python patch update retains the approved compiler recipe and compatible source-built tools', () => {
  const before = [graph('python@3.14'), graph('llvm', ['python@3.14'])];
  const after = [graph('python@3.14', [], {version: '1.1', recipe_sha256: 'new'}),
    graph('llvm', [], {version: '99', recipe_sha256: 'new', runtime_dependencies: [{name: 'python@3.14', version: '1.1'}]})];
  const lock = {core_commit: hash, platforms: {arm64: {packages: {llvm: {}, 'python@3.14': {}}}}};
  assert.deepEqual(selectRecipes(lock, [{before, after}], {formulae: ['python@3.14']}, latest).updates, ['python@3.14']);
  const compiler = graph('llvm', [], {runtime_dependencies: [{name: 'python@3.14', version: '1.1'}]});
  const source = {version: '1.0', source: {inputs: {recipe: 'old', dependencies: [{name: 'python@3.14', version: '1.0'}]}}};
  assert.deepEqual(resolvePlan([compiler], {llvm: source}).updates, []);
  compiler.runtime_dependencies[0].name = 'python@3.15';
  assert.deepEqual(resolvePlan([compiler], {llvm: source}).updates, ['llvm']);
});
