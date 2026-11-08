const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanupBuildDirectory } = require('../helpers/cleanup-build-directory.cjs');

test('source cleanup removes owned files, tolerates an absent build and does not follow symlinks', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), outside = path.join(root, 'preserved');
  fs.mkdirSync(source); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(source, 'config.log'), 'old build');
  fs.writeFileSync(path.join(outside, 'keep'), 'preserved');
  fs.symlinkSync(outside, path.join(source, 'linked-directory'));
  cleanupBuildDirectory(source);
  cleanupBuildDirectory(source);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'preserved');
  assert.throws(() => cleanupBuildDirectory('/'), /Invalid/);
});

test('source cleanup removes root-owned compiler outputs left inside a user-owned build', t => {
  if (process.getuid?.() === 0 || spawnSync('/usr/bin/sudo', ['-n', '/usr/bin/true']).status !== 0) {
    t.skip('Requires a non-root account with passwordless sudo, as provided by CI'); return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-fixture-root-'));
  t.after(() => cleanupBuildDirectory(root));
  fs.mkdirSync(path.join(root, '.libs'));
  fs.writeFileSync(path.join(root, '.libs', 'redis.o'), 'compiler output');
  fs.writeFileSync(path.join(root, 'config.log'), 'user-owned configure log');
  const owner = spawnSync('/usr/bin/sudo', ['-n', 'chown', '-R', '0', path.join(root, '.libs')]);
  assert.equal(owner.status, 0);
  assert.equal(fs.statSync(path.join(root, '.libs')).uid, 0);
  cleanupBuildDirectory(root);
  assert.equal(fs.existsSync(root), false);
});
