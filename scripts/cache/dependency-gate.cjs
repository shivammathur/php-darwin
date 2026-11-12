const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {capture, changed} = require('./dependency-inputs.cjs');
const repository = 'shivammathur/php-darwin';
function activeRuns(workflow, run = args => execFileSync('gh', args, {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024})) {
  return ['queued', 'in_progress', 'waiting', 'pending', 'requested'].flatMap(status =>
    JSON.parse(run(['api', '--paginate', '--slurp', `repos/${repository}/actions/workflows/${workflow}/runs?branch=main&status=${status}&per_page=100`]))
      .flatMap(page => page.workflow_runs));
}
function refreshAutomaticRun({automatic, inputs = {}, revision = process.env.GITHUB_SHA, ref = process.env.GITHUB_REF_NAME,
  run = args => execFileSync('gh', args, {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024})}) {
  // Queued runs keep their event SHA even after an earlier dependency run has
  // published. Start a new run rather than mixing a fresh lock with old worker
  // provenance or relaxing the promotion compare-and-swap check.
  if (!automatic || ref !== 'main' || String(inputs['plan-only']) === 'true' || String(inputs.publish) === 'false') return true;
  const latest = JSON.parse(run(['api', `repos/${repository}/commits/main`])).sha;
  if (!/^[a-f0-9]{40}$/.test(revision || '') || !/^[a-f0-9]{40}$/.test(latest || '')) throw new Error('Invalid dependency workflow revision');
  if (latest === revision) return true;
  if (activeRuns('update-dependencies.yml', run).some(item => item.head_sha === latest)) {
    console.log('A dependency run already targets current main; skipping the stale automatic run.');
  } else {
    run(['workflow', 'run', 'update-dependencies.yml', '--repo', repository, '--ref', 'main',
      ...Object.entries({...inputs, automatic: true}).flatMap(([name, value]) => ['-f', `${name}=${value}`])]);
    console.log('Requeued the stale automatic dependency run on current main.');
  }
  return false;
}
function gate({lock, inputs, dispatch = false, run = args => execFileSync('gh', args, {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024})}) {
  const diff = changed(lock.tap_inputs, inputs);
  if (!diff.changed) return true;
  console.log('Tap dependencies or bottles changed; waiting for verified dependency caches.');
  if (dispatch && !activeRuns('update-dependencies.yml', run).length) {
    run(['workflow', 'run', 'update-dependencies.yml', '--repo', repository, '--ref', 'main', '-f', 'automatic=true']);
    console.log('Dispatched the dependency planner; build tools run in prepare-build-tool.yml.');
  }
  return false;
}
module.exports = {activeRuns, refreshAutomaticRun, gate};
if (require.main === module && process.argv[2] === 'refresh') {
  if (process.env.GITHUB_REPOSITORY !== repository) throw new Error('Dependency refresh requires the php-darwin repository');
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH));
  const current = refreshAutomaticRun({automatic: process.env.AUTOMATIC === 'true', inputs: event.inputs || {}});
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `current=${current}\n`);
} else if (require.main === module) {
  const inputs = capture({'homebrew-php': path.resolve('homebrew-php'), 'homebrew-extensions': path.resolve('homebrew-extensions')});
  fs.writeFileSync('dependency-inputs.json', JSON.stringify(inputs, null, 2) + '\n');
  const ready = gate({lock: require('../../conf/dependencies.json'), inputs,
    dispatch: process.argv[2] === 'dispatch' && process.env.GITHUB_REF_NAME === 'main'});
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `ready=${ready}\n`);
  if (process.argv[2] === 'require' && !ready) throw new Error('Prepare and approve dependencies with update-dependencies.yml before building consumers');
}
