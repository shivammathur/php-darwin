const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

test('archive permissions preserve read-only payloads and reject restrictive runner masks', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'private-permissions-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const plain = path.join(directory, 'payload.tar'), archive = plain + '.zst';
  for (const [dir, file, executable, accepted] of [
    [0o755, 0o644, 0o755, true], [0o555, 0o444, 0o555, true],
    [0o700, 0o644, 0o755, false], [0o755, 0o600, 0o755, false],
    [0o755, 0o644, 0o500, false], [0o750, 0o640, 0o750, false],
  ]) {
    const created = spawnSync('python3', ['-c', `import io,sys,tarfile
with tarfile.open(sys.argv[1], 'w') as archive:
 for name,mode,kind in [('Cellar/example',int(sys.argv[2]),tarfile.DIRTYPE),('Cellar/example/formula.rb',int(sys.argv[3]),tarfile.REGTYPE),('Cellar/example/tool',int(sys.argv[4]),tarfile.REGTYPE)]:
  member=tarfile.TarInfo(name);member.mode=mode;member.type=kind
  member.size=0 if kind==tarfile.DIRTYPE else 7
  archive.addfile(member,io.BytesIO(b'payload') if member.size else None)
`, plain, String(dir), String(file), String(executable)], {encoding:'utf8'});
    assert.equal(created.status, 0, created.stderr);
    assert.equal(spawnSync('zstd', ['-qf', plain, '-o', archive]).status, 0);
    const result = spawnSync('python3', [path.resolve(__dirname, '../../private/check-permissions.py'), archive], {encoding:'utf8'});
    assert.equal(result.status === 0, accepted, result.stderr);
    if (accepted) assert.equal(JSON.parse(result.stdout).policy, 'public-readable-v1');
    else assert.match(result.stderr, /not accessible to installation users/);
  }
});
