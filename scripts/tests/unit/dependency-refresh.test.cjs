const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {refreshAutomaticRun} = require('../../cache/dependency-gate.cjs');
const old = 'a'.repeat(40), latest = 'b'.repeat(40);
function fixture({head = latest, active = [], fail} = {}) {
  const calls = [];
  const run = args => {
    calls.push(args);
    if (fail) throw new Error(fail);
    if (args[0] === 'workflow') return '';
    if (args.at(-1).endsWith('/commits/main')) return JSON.stringify({sha: head});
    const status = new URL('https://api.github.com/' + args.at(-1)).searchParams.get('status');
    return JSON.stringify([{workflow_runs: active.filter(item => item.status === status)}]);
  };
  return {calls, run, automatic: true, revision: old, ref: 'main'};
}
test('current automatic runs retain one revision for plans, workers and promotion', () => {
  const f = fixture({head: old});
  assert.equal(refreshAutomaticRun(f), true);
  assert.equal(f.calls.length, 1);
});
test('stale queued automatic runs dispatch current main once and skip native work', () => {
  const f = fixture({active: [{head_sha: old, status: 'in_progress'}]});
  assert.equal(refreshAutomaticRun(f), false);
  assert.deepEqual(f.calls.at(-1), ['workflow', 'run', 'update-dependencies.yml', '--repo',
    'shivammathur/php-darwin', '--ref', 'main', '-f', 'automatic=true']);
  assert.equal(f.calls.filter(args => args[0] === 'workflow').length, 1);
});
test('fresh queued and pending runs are reused rather than replaced', () => {
  for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
    const f = fixture({active: [{head_sha: latest, status}]});
    assert.equal(refreshAutomaticRun(f), false);
    assert.ok(f.calls.every(args => args[0] !== 'workflow'));
  }
});
test('explicit refresh options survive requeueing', () => {
  const f = fixture();
  const inputs = {automatic: 'true', 'cache-only': 'true', 'retire-formulae': 'old-tool',
    'homebrew-core-commit': 'c'.repeat(40), publish: 'true'};
  assert.equal(refreshAutomaticRun({...f, inputs}), false);
  for (const [key, value] of Object.entries(inputs)) assert.ok(f.calls.at(-1).includes(`${key}=${value}`));
});
test('manual plans, previews, unpublished runs and other branches stay untouched', () => {
  for (const options of [{automatic: false}, {inputs: {'plan-only': 'true'}}, {inputs: {'plan-only': true}},
    {inputs: {publish: 'false'}}, {inputs: {publish: false}}, {ref: 'test'}]) {
    const f = fixture();
    assert.equal(refreshAutomaticRun({...f, ...options}), true);
    assert.deepEqual(f.calls, []);
  }
});
test('lookup and uncertain dispatch errors fail without blindly retrying', () => {
  const f = fixture({fail: 'network error'});
  assert.throws(() => refreshAutomaticRun(f), /network error/);
  assert.equal(f.calls.length, 1);
  const g = fixture();
  assert.throws(() => refreshAutomaticRun({...g, run: args => {
    const value = g.run(args);
    if (args[0] === 'workflow') throw new Error('uncertain dispatch');
    return value;
  }}), /uncertain dispatch/);
  assert.equal(g.calls.filter(args => args[0] === 'workflow').length, 1);
  assert.throws(() => refreshAutomaticRun(fixture({head: 'invalid'})), /Invalid dependency workflow revision/);
});
test('the queue refresh gates every planning step before artifact or worker creation', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../../../.github/workflows/update-dependencies.yml'), 'utf8');
  const plan = workflow.split('\n  plan:')[1].split('\n  discover:')[0];
  assert.match(plan, /permissions:\n      contents: read\n      actions: write/);
  const steps = plan.split('      - ').slice(1);
  assert.match(steps[1], /id: current/);
  assert.match(steps[1], /node scripts\/cache\/dependency-gate.cjs refresh/);
  for (const step of steps.slice(2)) {
    assert.match(step, /if: steps\.(?:current\.outputs\.current|change\.outputs\.required) == 'true'/);
  }
});
