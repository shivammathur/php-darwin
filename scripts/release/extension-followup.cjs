const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {githubJSON, workflowJobs} = require('./extension-transfers.cjs');
const {downloadArtifact} = require('./extension-batches.cjs');
const {versions} = require('../../conf/extension-packs.json');

async function selection(event, {read = githubJSON, jobsFor = workflowJobs, download = downloadArtifact} = {}) {
  if (!event.workflow_run) return {ready: true, versions: event.inputs?.['php-versions'] || '', fast: event.inputs?.fast === true || event.inputs?.fast === 'true'};
  const source = event.workflow_run;
  if (source.status !== 'completed' || source.conclusion !== 'success' || source.head_branch !== 'main' ||
      source.head_repository?.full_name !== 'shivammathur/php-darwin' ||
      !['.github/workflows/cache-stable.yml', '.github/workflows/cache-nightly.yml'].includes(source.path) ||
      !Number.isSafeInteger(source.id) || source.id < 1) throw new Error('Invalid PHP follow-up source');
  const route = `repos/shivammathur/php-darwin/actions/runs/${source.id}`;
  const artifacts = (await read(`${route}/artifacts?per_page=100`, {paginate: true})).flatMap(page => page.artifacts);
  const plans = artifacts.filter(item => !item.expired && /^build-plan-[0-9.]+$/.test(item.name));
  // A freshness no-op has no plan or successful publication and wakes no packs.
  if (!plans.length) return {ready: false, versions: '', fast: false};
  if (plans.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(plans[0].digest || '')) throw new Error('Ambiguous PHP follow-up plan');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'php-extension-followup-'));
  let plan;
  try {
    download({artifact_id: plans[0].id, artifact_digest: plans[0].digest}, temporary);
    plan = JSON.parse(fs.readFileSync(path.join(temporary, 'build-plan.json')));
  } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
  if (plan.schema !== 1 || !versions.includes(plan.php_version) || plan.revision !== source.head_sha ||
      plans[0].name !== `build-plan-${plan.php_version}` ||
      (plan.fast !== undefined && typeof plan.fast !== 'boolean')) throw new Error('Mismatched PHP follow-up plan');
  const jobs = await jobsFor(route, source.run_attempt);
  const name = `Publish PHP ${plan.php_version} release assets`;
  const published = jobs.filter(job => job.name === name || job.name.endsWith(' / ' + name));
  const ready = plan.publish !== false && published.length === 1 && published[0].status === 'completed' && published[0].conclusion === 'success';
  return {ready, versions: plan.php_version, fast: plan.fast === true};
}

module.exports = {selection};
if (require.main === module) selection(JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH))).then(result => {
  // Manual inputs are also validated before they become workflow outputs.
  if (result.versions && result.versions.trim().split(/\s+/).some(version => !versions.includes(version))) throw new Error('Invalid PHP follow-up versions');
  const selected = result.versions.trim().split(/\s+/).filter(Boolean).join(' ');
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `ready=${result.ready}\nphp-versions=${selected}\nfast=${result.fast}\n`);
  console.log(result.ready ? `Check extensions for ${selected || 'all configured PHP versions'}; fast=${result.fast}` : 'PHP did not publish; no extension follow-up');
}).catch(error => {console.error(error); process.exitCode = 1;});
