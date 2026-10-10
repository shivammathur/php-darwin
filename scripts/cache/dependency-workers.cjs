const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const repository = 'shivammathur/php-darwin';
const fingerprint = plan => createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 16);
const workflow = node => node.kind === 'tool' ? 'prepare-build-tool.yml' : 'prepare-dependency.yml';
const title = (node, plan, id) => `Prepare ${node.formula} cache on ${plan.arch} (plan ${id}/${fingerprint(plan)})`;
function ready(nodes, state) {
  return nodes.filter(node => !state[node.formula] && node.needs.every(name => state[name]?.conclusion === 'success'));
}
async function orchestrate(plans, {id = process.env.GITHUB_RUN_ID, revision = process.env.GITHUB_SHA, ref = process.env.GITHUB_REF_NAME,
  run = args => execFileSync('gh', args, {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024}).trim(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now,
  save = value => fs.writeFileSync('dependency-workers.json', JSON.stringify(value, null, 2) + '\n')} = {}) {
  if (!/^\d+$/.test(id || '') || !ref || !/^[a-f0-9]{40}$/.test(revision || '')) throw new Error('Invalid worker workflow context');
  const states = Object.fromEntries(plans.map(plan => [plan.arch, {}]));
  const api = route => JSON.parse(run(['api', `repos/${repository}/${route}`]));
  const parent = api(`actions/runs/${id}`), started = now();
  for (const plan of plans) if (plan.revision !== revision) throw new Error('Worker plan revision differs');
  const inventory = () => ['prepare-dependency.yml', 'prepare-build-tool.yml'].flatMap(file =>
    JSON.parse(run(['api', '--paginate', '--slurp', `repos/${repository}/actions/workflows/${file}/runs?branch=${encodeURIComponent(ref)}&per_page=100&created=${encodeURIComponent('>=' + parent.created_at)}`]))
      .flatMap(page => page.workflow_runs));
  const find = (runs, node, plan) => {
    const matches = runs.filter(item => item.head_sha === revision && item.path === `.github/workflows/${workflow(node)}` && item.display_title === title(node, plan, id));
    if (matches.length > 1) throw new Error(`Duplicate dependency workers: ${title(node, plan, id)}`);
    return matches[0];
  };
  const pending = new Map();
  while (true) {
    const runs = inventory();
    for (const plan of plans) for (const node of plan.workers) {
      const existing = find(runs, node, plan);
      if (existing) { states[plan.arch][node.formula] = existing; pending.delete(title(node, plan, id)); }
    }
    save(states);
    for (const [name, time] of pending) if (now() - time > 120000) {
      throw new Error(`Unresolved dispatch for ${name}; inspect Actions before retrying, do not blindly redispatch`);
    }
    const allStates = Object.values(states).flatMap(Object.values);
    const failures = allStates.filter(item => item.status === 'completed' && item.conclusion !== 'success');
    if (!failures.length) for (const plan of plans) for (const node of ready(plan.workers, states[plan.arch])) {
      const name = title(node, plan, id);
      if (pending.has(name)) continue;
      if (api(`commits/${encodeURIComponent(ref)}`).sha !== revision) {
        throw new Error('Workflow branch advanced; start a fresh dependency plan. Existing verified bottles remain reusable.');
      }
      pending.set(name, now());
      // Submit every independent node before polling. Failed/uncertain responses
      // are resolved from exact run titles, never retried as a new dispatch.
      try {
        run(['workflow', 'run', workflow(node), '--repo', repository, '--ref', ref,
          '-f', `formula=${node.formula}`, '-f', `architecture=${plan.arch}`, '-f', `plan-run-id=${id}`, '-f', `plan-key=${fingerprint(plan)}`]);
      } catch (error) { console.error(`Resolving uncertain dispatch: ${name}: ${error.message}`); }
      console.log(name);
    }
    if (plans.every(plan => plan.workers.every(node => states[plan.arch][node.formula]?.conclusion === 'success'))) return states;
    if (failures.length && !pending.size && allStates.every(item => item.status === 'completed')) throw new Error(`Dependency workers failed: ${failures.map(item => item.id).join(', ')}`);
    if (now() - started > 5 * 60 * 60 * 1000) throw new Error('Dependency coordination timed out; reuse existing worker runs when retrying');
    await sleep(20000);
  }
}
function validateWorker(plan, {id, key, formula, arch, kind, revision, parent, runs}) {
  if (parent.path !== '.github/workflows/update-dependencies.yml' || parent.head_repository?.full_name !== repository ||
      parent.head_sha !== revision || plan.revision !== revision || plan.arch !== arch || fingerprint(plan) !== key) throw new Error('Untrusted dependency plan');
  const node = plan.workers.find(item => item.formula === formula && item.kind === kind);
  if (!node) throw new Error('Formula is not assigned to this worker workflow');
  for (const name of node.needs) {
    const dependency = plan.workers.find(item => item.formula === name);
    if (!dependency || !runs.some(run => run.display_title === title(dependency, plan, id) && run.head_sha === revision &&
        run.path === `.github/workflows/${workflow(dependency)}` && run.status === 'completed' && run.conclusion === 'success')) throw new Error(`Dependency worker has not succeeded: ${name}`);
  }
  return node;
}
module.exports = {ready, fingerprint, title, workflow, orchestrate, validateWorker};
if (require.main === module) {
  const mode = process.argv[2];
  if (mode === 'run') orchestrate(['arm64', 'x86_64'].map(arch => JSON.parse(fs.readFileSync(path.join(process.argv[3], `dependency-plan-${arch}.json`)))))
    .catch(error => { console.error(error); process.exitCode = 1; });
  else if (mode === 'worker') {
    const {FORMULA: formula, ARCH: arch, PLAN_RUN: id, PLAN_KEY: key, WORKER_KIND: kind, GITHUB_SHA: revision} = process.env;
    if (!/^\d+$/.test(id || '') || !['arm64', 'x86_64'].includes(arch)) throw new Error('Invalid plan selection');
    const api = route => JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${repository}/${route}`], {maxBuffer: 32 * 1024 * 1024}));
    const [parent] = api(`actions/runs/${id}`);
    const plan = JSON.parse(fs.readFileSync(`dependency-plan-${arch}.json`));
    const runs = ['prepare-dependency.yml', 'prepare-build-tool.yml'].flatMap(file => api(`actions/workflows/${file}/runs?branch=${encodeURIComponent(parent.head_branch)}&per_page=100&created=${encodeURIComponent('>=' + parent.created_at)}`).flatMap(page => page.workflow_runs));
    validateWorker(plan, {id, key, formula, arch, kind, revision, parent, runs});
    fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries({runner: require('../../conf/platforms.json')[arch].build_runner,
      core: plan.core, recipes: JSON.stringify(plan.recipes), updates: JSON.stringify(plan.updates), php: plan.php, extensions: plan.extensions})
      .map(([name, value]) => `${name}=${value}\n`).join(''));
  } else throw new Error('Expected run or worker');
}
