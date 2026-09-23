const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('preservation checks ignore empty racks, retain existing PHP, and detect changed services', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'php-preservation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prefix = path.join(root, 'brew'), services = path.join(root, 'LaunchAgents');
  const binary = path.join(prefix, 'Cellar/php@8.4/8.4.25/bin/php');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\n'); fs.chmodSync(binary, 0o755);
  fs.mkdirSync(path.join(prefix, 'Cellar/php@8.2'), { recursive: true });
  fs.mkdirSync(services);
  const service = path.join(services, 'homebrew.mxcl.php@8.4.plist');
  fs.writeFileSync(service, 'existing service');
  const run = mode => spawnSync('bash', [path.join(__dirname, 'check-preserved-homebrew.sh'),
    mode, prefix, path.join(root, 'state.json'), services], { encoding: 'utf8' });
  assert.equal(run('snapshot').status, 0);
  fs.rmdirSync(path.join(prefix, 'Cellar/php@8.2'));
  assert.equal(run('check').status, 0);
  fs.writeFileSync(service, 'changed service');
  assert.match(run('check').stderr, /service definitions changed/);
  fs.writeFileSync(service, 'existing service');
  fs.unlinkSync(binary);
  assert.match(run('check').stderr, /Removed existing PHP kegs/);
});
