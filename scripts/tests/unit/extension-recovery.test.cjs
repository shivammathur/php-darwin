const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planRecovery, verifySelection, reuseCompatibility } = require('../../release/extension-recovery.cjs');
const { key } = require('../../installer/install-extensions.cjs');
const { retryPolicy, httpError, workflowJobs } = require('../../release/extension-transfers.cjs');







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
