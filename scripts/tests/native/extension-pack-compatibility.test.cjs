const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { key, validateContext } = require('../../installer/install-extensions.cjs');

assert.equal(process.env.GITHUB_ACTIONS, 'true');
const context = validateContext({ php_version: process.env.PHP_VERSION, build: process.env.BUILD,
  thread_safety: process.env.TS, architecture: process.env.ARCH });
const names = JSON.parse(process.env.EXTENSION_PACKS);
assert.ok(Array.isArray(names) && names.length > 0);
for (const name of names) {
  const output = path.resolve('builds/extensions', `extension-${key({ ...context, name })}`);
  assert.ok(fs.statSync(output).isDirectory());
  const result = spawnSync(process.execPath, [path.join(__dirname, 'extension-pack.test.cjs')], {
    stdio: 'inherit', env: { ...process.env, EXTENSION_PACK: name, EXTENSION_PACK_OUTPUT: output },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${name} compatibility failed`);
}
