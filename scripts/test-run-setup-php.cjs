const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runSetupPhp } = require('./run-setup-php.cjs');

test('unchanged setup-php runs outside darwin parent paths and cleans up after success or failure', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'php-darwin-action-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'dist'));
  fs.mkdirSync(path.join(root, 'src/scripts'), { recursive: true });
  const script = "const fs = require('fs'); const path = require('path'); const source = path.join(__dirname, '../src/scripts/darwin.sh'); fs.writeFileSync(source.replace('darwin', 'run'), 'generated'); process.exit(Number(process.env.FIXTURE_EXIT || 0));";
  fs.writeFileSync(path.join(root, 'dist/index.js'), script);
  fs.writeFileSync(path.join(root, 'src/scripts/darwin.sh'), 'unchanged');
  assert.equal(runSetupPhp(root), 0);
  let copied;
  assert.equal(runSetupPhp(root, (node, [file], options) => {
    copied = path.dirname(path.dirname(file));
    assert.equal(copied.includes('darwin'), false);
    assert.equal(fs.readFileSync(file, 'utf8'), script);
    return require('node:child_process').spawnSync(node, [file], { ...options, env: { ...process.env, FIXTURE_EXIT: '7' } });
  }), 7);
  assert.equal(fs.existsSync(copied), false);
  assert.equal(fs.existsSync(path.join(root, 'src/scripts/run.sh')), false);
  assert.equal(fs.readFileSync(path.join(root, 'src/scripts/darwin.sh'), 'utf8'), 'unchanged');
});
