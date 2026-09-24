const fs = require('node:fs');
const path = require('node:path');
const { key, validateContext, validateEntry } = require('../installer/install-extensions.cjs');
const { command, retryPolicy, githubJSON, workflowJobs } = require('./extension-transfers.cjs');
const { downloadArtifact, buildMatrix, testMatrix } = require('./extension-batches.cjs');
const os = require('node:os');

async function planRecovery(id, run = command, retry = retryPolicy(), { download = downloadArtifact } = {}) {
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
    entries.push({ ...entry, artifact_id: selected[0].id, artifact_digest: selected[0].digest, source_run: id });
  }
  // Grouped jobs checkpoint successful packs independently. A later pack may
  // fail, so inspect their small index rather than discarding the whole job.
  for (const artifact of artifacts) {
    const match = /^extension-index-(built|reused)-([0-9.]+)-(arm64|x86_64)$/.exec(artifact.name);
    if (!match || artifact.expired) continue;
    const [, kind, version, arch] = match;
    const payloads = artifacts.filter(item => item.name === `extension-${kind}-${version}-${arch}` && !item.expired);
    if (payloads.length !== 1) throw new Error('Missing or ambiguous grouped artifact');
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-index-'));
    try {
      download({ artifact_id: artifact.id, artifact_digest: artifact.digest }, temporary);
      const index = JSON.parse(fs.readFileSync(path.join(temporary, 'entries.json')));
      if (!Array.isArray(index)) throw new Error('Invalid grouped artifact index');
      for (const value of index) {
        const entry = validateEntry(value);
        if (entry.php_version !== version || entry.architecture !== arch) throw new Error('Grouped artifact context mismatch');
        entries.push({ name: entry.name, php_version: version, architecture: arch, build: entry.build,
          thread_safety: entry.thread_safety, artifact_id: payloads[0].id, artifact_digest: payloads[0].digest, source_run: id });
      }
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  if (!entries.length || new Set(entries.map(key)).size !== entries.length) throw new Error('No unique successful extension builds');
  const matrix = testMatrix(entries);
  if (matrix.include.length > 256) throw new Error('Recovery matrix exceeds Actions limit');
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
    const tests = result.matrix;
    console.log(JSON.stringify(result, null, 2));
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `matrix=${JSON.stringify(tests)}\nreuse=${JSON.stringify(buildMatrix(result.entries))}\n` +
      `artifact-ids=${result.entries.map(entry => entry.artifact_id).join(',')}\n` +
      `keys=${JSON.stringify(result.entries.map(key))}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `Recovering ${result.entries.length} successful archives from run ${result.source_run} (${result.source_sha}). ` +
      `${tests.include.length} grouped native compatibility jobs must pass before publication. Failed packs are excluded.\n`);
  } else if (process.argv[2] === 'verify') verifySelection(process.argv[3], JSON.parse(process.env.EXTENSION_RECOVERY_KEYS));
  else throw new Error('Usage: extension-recovery.cjs plan <run-id>|verify <directory>');
})().catch(error => { console.error(error); process.exitCode = 1; });
