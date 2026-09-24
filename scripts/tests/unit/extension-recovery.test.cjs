const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planRecovery, verifySelection } = require('../../release/extension-recovery.cjs');
const { key } = require('../../installer/install-extensions.cjs');

test('recovery binds successful main builds to exact live artifact IDs and every compatibility platform', () => {
  const source = { status: 'completed', conclusion: 'failure', head_branch: 'main', head_sha: 'a'.repeat(40),
    head_repository: { full_name: 'shivammathur/php-darwin' }, path: '.github/workflows/cache-extensions.yml' };
  const jobs = ['mongodb', 'imagick'].map(name => ({ name: `${name} / PHP 8.2 / debug-zts / arm64`,
    status: 'completed', conclusion: name === 'mongodb' ? 'success' : 'failure' }));
  const artifacts = [{ id: 42, name: 'extension-mongodb-8.2-debug-zts-arm64', expired: false },
    { id: 43, name: 'extension-imagick-8.2-debug-zts-arm64', expired: false }];
  const run = (_program, args) => JSON.stringify(args.at(-1).includes('/jobs?') ? [{ jobs }] :
    args.at(-1).includes('/artifacts?') ? [{ artifacts }] : source);
  const result = planRecovery('123', run);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].artifact_id, 42);
  assert.deepEqual(result.matrix.include.map(context => context.runner).sort(), ['macos-15', 'macos-26', 'macos-latest']);
  for (const context of result.matrix.include) {
    assert.deepEqual(context.packs, ['mongodb']);
    assert.equal(context.artifact_ids, '42');
  }
  artifacts[0].expired = true;
  assert.throws(() => planRecovery('123', run), /Missing or ambiguous/);
  artifacts[0].expired = false;
  artifacts.push(artifacts[0]);
  assert.throws(() => planRecovery('123', run), /Missing or ambiguous/);
  artifacts.pop();
  for (const field of ['head_branch', 'path', 'status']) {
    const previous = source[field]; source[field] = 'untrusted';
    assert.throws(() => planRecovery('123', run), /Untrusted/); source[field] = previous;
  }
  source.head_repository.full_name = 'other/php-darwin';
  assert.throws(() => planRecovery('123', run), /Untrusted/);
  assert.throws(() => planRecovery('../123', run), /Invalid/);
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
