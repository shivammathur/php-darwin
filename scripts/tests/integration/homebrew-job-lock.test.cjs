const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

test('runner job leases serialize shared Homebrew access, drain old jobs and recover stale owners', () => {
  const result = spawnSync('ruby', [path.join(__dirname, '../helpers/homebrew-job-lock-test.rb')], {
    encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
