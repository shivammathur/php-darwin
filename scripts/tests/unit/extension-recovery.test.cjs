const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planRecovery, verifySelection } = require('../../release/extension-recovery.cjs');
const { key } = require('../../installer/install-extensions.cjs');
const { retryPolicy, httpError, workflowJobs } = require('../../release/extension-transfers.cjs');

test('recovery binds successful main builds to exact live artifact IDs and every compatibility platform', async () => {
  const source = { status: 'completed', conclusion: 'failure', head_branch: 'main', run_attempt: 1, head_sha: 'a'.repeat(40),
    head_repository: { full_name: 'shivammathur/php-darwin' }, path: '.github/workflows/cache-extensions.yml' };
  const jobs = ['mongodb', 'imagick'].map(name => ({ name: `${name} / PHP 8.2 / debug-zts / arm64`,
    status: 'completed', conclusion: name === 'mongodb' ? 'success' : 'failure' }));
  const artifacts = [{ id: 42, name: 'extension-mongodb-8.2-debug-zts-arm64', expired: false },
    { id: 43, name: 'extension-imagick-8.2-debug-zts-arm64', expired: false }];
  const run = (_program, args) => JSON.stringify(args.at(-1).includes('/jobs?') ? [{ jobs }] :
    args.at(-1).includes('/artifacts?') ? [{ artifacts }] : source);
  const result = await planRecovery('123', run);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].artifact_id, 42);
  assert.deepEqual(result.matrix.include.map(context => context.runner).sort(), ['macos-15', 'macos-26', 'macos-latest']);
  for (const context of result.matrix.include) {
    assert.deepEqual(context.packs, ['mongodb']);
    assert.equal(context.artifact_ids, '42');
  }
  for (const status of [502, 403]) {
    let attempts = 0;
    const flaky = (program, args) => {
      if (args.at(-1).includes('/jobs?') && ++attempts === 1) throw httpError(status, 'Read jobs');
      return run(program, args);
    };
    const operation = planRecovery('123', flaky, retryPolicy({ wait: async () => {} }));
    if (status === 502) {
      assert.deepEqual(await operation, result);
      assert.equal(attempts, 2);
    } else {
      await assert.rejects(operation, /403/);
      assert.equal(attempts, 1);
    }
  }
  artifacts[0].expired = true;
  await assert.rejects(planRecovery('123', run), /Missing or ambiguous/);
  artifacts[0].expired = false;
  artifacts.push(artifacts[0]);
  await assert.rejects(planRecovery('123', run), /Missing or ambiguous/);
  artifacts.pop();
  for (const field of ['head_branch', 'path', 'status']) {
    const previous = source[field]; source[field] = 'untrusted';
    await assert.rejects(planRecovery('123', run), /Untrusted/); source[field] = previous;
  }
  source.head_repository.full_name = 'other/php-darwin';
  await assert.rejects(planRecovery('123', run), /Untrusted/);
  await assert.rejects(planRecovery('../123', run), /Invalid/);
});

test('partial reruns retain passing jobs from earlier attempts and respect newer failures', async () => {
  const jobs = [[{ name: 'imagick', conclusion: 'success' }, { name: 'mongodb', conclusion: 'failure' }],
    [{ name: 'mongodb', conclusion: 'success' }], [{ name: 'imagick', conclusion: 'failure' }]];
  const run = (_program, args) => {
    const match = /\/attempts\/([1-3])\/jobs\?per_page=100$/.exec(args.at(-1));
    assert.ok(match, 'Jobs must come from a specific attempt');
    return JSON.stringify([{ jobs: jobs[Number(match[1]) - 1] }]);
  };
  assert.deepEqual(await workflowJobs('fixture', 2, { run }), [jobs[0][0], jobs[1][0]]);
  assert.deepEqual(await workflowJobs('fixture', 3, { run }), [jobs[2][0], jobs[1][0]]);
  await assert.rejects(workflowJobs('fixture', undefined, { run }), /Invalid source run attempt/);
});

test('publication rejects missing, extra or duplicated variants after recovery tests', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const entry = { schema: 1, name: 'mongodb', php_version: '8.2', build: 'debug', thread_safety: 'zts', architecture: 'arm64',
    sha256: 'a'.repeat(64), inputs_sha256: 'b'.repeat(64), php_api: '20220829', minimum_macos: 14, bytes: 100 };
  entry.file = `${key(entry)}-${entry.sha256}.tar.zst`;
  fs.writeFileSync(path.join(directory, 'entry.json'), JSON.stringify(entry));
  verifySelection(directory, [key(entry)]);
  assert.throws(() => verifySelection(directory, []), /differ/);
  assert.throws(() => verifySelection(directory, [key(entry), key({ ...entry, name: 'imagick' })]), /differ/);
  assert.throws(() => verifySelection(directory, [key(entry), key(entry)]), /differ/);
  fs.mkdirSync(path.join(directory, 'duplicate'));
  fs.writeFileSync(path.join(directory, 'duplicate/entry.json'), JSON.stringify(entry));
  assert.throws(() => verifySelection(directory, [key(entry)]), /differ/);
});
