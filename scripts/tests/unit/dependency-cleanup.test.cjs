const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {removeFrameworkPythonLinks} = require('../../cache/update-dependencies.cjs');

function fixture(t) {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-cleanup-'));
  t.after(() => fs.rmSync(prefix, {recursive: true, force: true}));
  fs.mkdirSync(path.join(prefix, 'bin'));
  return prefix;
}

test('dependency cleanup removes all framework Python command links and is repeatable', t => {
  const prefix = fixture(t), bin = path.join(prefix, 'bin');
  const commands = ['idle3', 'pip3', 'pydoc3', 'python3', 'python3-config', 'python3.13'];
  for (const [index, name] of commands.entries()) {
    const target = `/Library/Frameworks/Python.framework/Versions/3.13/bin/${name}`;
    fs.symlinkSync(index % 2 ? path.relative(bin, target) : target, path.join(bin, name));
  }
  removeFrameworkPythonLinks(prefix);
  assert.deepEqual(fs.readdirSync(bin), []);
  // Both an already cleaned prefix and an empty prefix remain valid.
  removeFrameworkPythonLinks(prefix);
  fs.rmdirSync(bin);
  removeFrameworkPythonLinks(prefix);
});

test('dependency cleanup preserves files, directories and links outside framework Python commands', t => {
  const prefix = fixture(t), bin = path.join(prefix, 'bin');
  fs.writeFileSync(path.join(bin, 'python3'), 'local Python wrapper');
  fs.mkdirSync(path.join(bin, 'idle3'));
  const links = {
    pip3: '../Cellar/python@3.14/3.14.8_1/bin/pip3',
    pydoc3: '../opt/python@3.14/bin/pydoc3',
    'python3-config': '/usr/bin/python3-config',
    'other-framework': '/Library/Frameworks/Other.framework/Versions/3.13/bin/python3',
    'framework-library': '/Library/Frameworks/Python.framework/Versions/3.13/lib/python3.13',
    'framework-directory': '/Library/Frameworks/Python.framework/Versions/3.13/bin',
    'similar-framework': '/Library/Frameworks/Python.framework.backup/Versions/3.13/bin/python3',
  };
  for (const [name, target] of Object.entries(links)) fs.symlinkSync(target, path.join(bin, name));
  removeFrameworkPythonLinks(prefix);
  assert.equal(fs.readFileSync(path.join(bin, 'python3'), 'utf8'), 'local Python wrapper');
  assert.ok(fs.statSync(path.join(bin, 'idle3')).isDirectory());
  for (const [name, target] of Object.entries(links)) assert.equal(fs.readlinkSync(path.join(bin, name)), target);
});
