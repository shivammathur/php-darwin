const fs = require('node:fs');
const path = require('node:path');
const { key, validateContext, validateEntry } = require('../installer/install-extensions.cjs');
const { command, retryPolicy, githubJSON, workflowJobs } = require('./extension-transfers.cjs');
const { compatibilityMatrix } = require('./extension-packs.cjs');

async function planRecovery(id, run = command, retry = retryPolicy()) {
  if (!/^[1-9][0-9]*$/.test(id || '')) throw new Error('Invalid source workflow run');
  const route = `repos/shivammathur/php-darwin/actions/runs/${id}`;
  const source = await githubJSON(route, { run, retry });
  if (source.status !== 'completed' || source.head_branch !== 'main' ||
      source.head_repository?.full_name !== 'shivammathur/php-darwin' ||
      source.path !== '.github/workflows/cache-extensions.yml') throw new Error('Untrusted or unfinished extension source run');
  const list = async kind => (await githubJSON(`${route}/${kind}?per_page=100`, { run, retry, paginate: true })).flatMap(page => page[kind]);
  const artifacts = await list('artifacts');
  const entries = [];
  for (const job of await workflowJobs(route, source.run_attempt, { run, retry })) {
    const match = /^(imagick|mongodb|memcached) \/ PHP ([0-9.]+) \/ (debug|release)-(nts|zts) \/ (arm64|x86_64)$/.exec(job.name);
    if (!match || job.status !== 'completed' || job.conclusion !== 'success') continue;
    const [, name, php_version, build, thread_safety, architecture] = match;
    const entry = { ...validateContext({ php_version, build, thread_safety, architecture }), name };
    const selected = artifacts.filter(artifact => artifact.name === `extension-${key(entry)}` && !artifact.expired);
    if (selected.length !== 1 || !Number.isSafeInteger(selected[0].id) || selected[0].id <= 0) {
      throw new Error(`Missing or ambiguous successful build artifact: ${key(entry)}`);
    }
    entries.push({ ...entry, artifact_id: selected[0].id });
  }
  if (!entries.length || new Set(entries.map(key)).size !== entries.length) throw new Error('No unique successful extension builds');
  const matrix = compatibilityMatrix(entries);
  if (matrix.include.length > 256) throw new Error('Recovery matrix exceeds Actions limit');
  for (const context of matrix.include) {
    context.artifact_ids = entries.filter(entry => context.packs.includes(entry.name) &&
      ['php_version', 'build', 'thread_safety', 'architecture'].every(field => entry[field] === context[field]))
      .map(entry => entry.artifact_id).join(',');
  }
  return { source_run: id, source_sha: source.head_sha, entries, matrix };
}

function verifySelection(directory, keys) {
  const visit = folder => fs.readdirSync(folder, { withFileTypes: true }).flatMap(item => {
    const file = path.join(folder, item.name);
    return item.isDirectory() ? visit(file) : file.endsWith('.json') ? [file] : [];
  });
  const actual = visit(directory).map(file => key(validateEntry(JSON.parse(fs.readFileSync(file))))).sort();
  if (!Array.isArray(keys) || !keys.length || new Set(keys).size !== keys.length ||
      JSON.stringify(actual) !== JSON.stringify([...keys].sort())) throw new Error('Recovery artifacts differ from the tested selection');
}

module.exports = { planRecovery, verifySelection };
if (require.main === module) (async () => {
  if (process.argv[2] === 'plan') {
    const result = await planRecovery(process.argv[3]);
    console.log(JSON.stringify(result, null, 2));
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `matrix=${JSON.stringify(result.matrix)}\nartifact-ids=${result.entries.map(entry => entry.artifact_id).join(',')}\n` +
      `keys=${JSON.stringify(result.entries.map(key))}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `Recovering ${result.entries.length} successful archives from run ${result.source_run} (${result.source_sha}). ` +
      `${result.matrix.include.length} native compatibility jobs must pass before publication. Failed builds are excluded.\n`);
  } else if (process.argv[2] === 'verify') verifySelection(process.argv[3], JSON.parse(process.env.EXTENSION_RECOVERY_KEYS));
  else throw new Error('Usage: extension-recovery.cjs plan <run-id>|verify <directory>');
})().catch(error => { console.error(error); process.exitCode = 1; });
