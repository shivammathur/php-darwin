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
function gate({lock, inputs, dispatch = false, run = args => execFileSync('gh', args, {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024})}) {
  const diff = changed(lock.tap_inputs, inputs);
  if (!diff.changed) return true;
  console.log('Tap dependency declarations changed; waiting for verified dependency caches.');
  if (dispatch && !activeRuns('update-dependencies.yml', run).length) {
    run(['workflow', 'run', 'update-dependencies.yml', '--repo', repository, '--ref', 'main', '-f', 'automatic=true']);
    console.log('Dispatched the dependency planner; build tools run in prepare-build-tool.yml.');
  }
  return false;
}
module.exports = {activeRuns, gate};
if (require.main === module) {
  const inputs = capture({'homebrew-php': path.resolve('homebrew-php'), 'homebrew-extensions': path.resolve('homebrew-extensions')});
  fs.writeFileSync('dependency-inputs.json', JSON.stringify(inputs, null, 2) + '\n');
  const ready = gate({lock: require('../../conf/dependencies.json'), inputs,
    dispatch: process.argv[2] === 'dispatch' && process.env.GITHUB_REF_NAME === 'main'});
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `ready=${ready}\n`);
  if (process.argv[2] === 'require' && !ready) throw new Error('Prepare and approve dependencies with update-dependencies.yml before building consumers');
}
