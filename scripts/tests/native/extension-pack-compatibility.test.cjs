const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { key, validateContext } = require('../../installer/install-extensions.cjs');

function archiveDirectories(root, context, names) {
  assert.ok(Array.isArray(names) && names.length > 0);
  return names.map(name => {
    const identity = key({ ...context, name });
    const nested = path.resolve(root, `extension-${identity}`);
    // download-artifact flattens a single pattern match even when merging is
    // disabled. Normalize that layout so validation reports also stay grouped.
    if (!fs.existsSync(nested) && names.length === 1 && fs.existsSync(path.join(root, `${identity}.json`))) {
      fs.mkdirSync(nested);
      for (const item of fs.readdirSync(root, { withFileTypes: true })) {
        if (item.isFile()) fs.renameSync(path.join(root, item.name), path.join(nested, item.name));
      }
    }
    assert.ok(fs.statSync(nested).isDirectory());
    return { name, output: nested };
  });
}
module.exports = { archiveDirectories };
if (require.main === module) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  const context = validateContext({ php_version: process.env.PHP_VERSION, build: process.env.BUILD,
    thread_safety: process.env.TS, architecture: process.env.ARCH });
  for (const { name, output } of archiveDirectories('builds/extensions', context, JSON.parse(process.env.EXTENSION_PACKS))) {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'extension-pack.test.cjs')], {
      stdio: 'inherit', env: { ...process.env, EXTENSION_PACK: name, EXTENSION_PACK_OUTPUT: output },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${name} compatibility failed`);
  }
}
