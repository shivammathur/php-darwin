const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

test('bottle runtime requirements support legacy receipts without losing revisions', () => {
  const receipts = [
    {pkg_version: '4.1.0_2', version: '4.1.0', revision: 2},
    {pkg_version: '4.1.0_2'},
    {version: '1.0.18', revision: 2},
    {version: '1.0.18', revision: '2'},
    {version: '1.0.18', revision: 0},
    {version: '1.0.18'},
    {version: '1.0.18', revision: null},
  ];
  const result = run(receipts);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['4.1.0_2', '4.1.0_2', '1.0.18_2', '1.0.18_2',
    '1.0.18', '1.0.18', '1.0.18']);
});

test('missing or malformed bottle versions cannot silently approve an old dependency', () => {
  for (const receipt of [{}, {version: ''}, {pkg_version: ''}, {pkg_version: 4.1},
    {version: '1.0', revision: -1}, {version: '1.0', revision: 'bad'}, {version: '1.0', revision: 1.5}]) {
    const result = run([receipt]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /(?:Invalid|Missing) bottle runtime/);
  }
});

function run(receipts) {
  return spawnSync(process.env.PHP_DARWIN_RUBY || 'ruby', ['-rjson',
    '-r', path.join(__dirname, '../../cache/bottle-runtime-version.rb'), '-e',
    'puts JSON.generate(JSON.parse(STDIN.read).map { |dependency| BottleRuntimeVersion.package_version(dependency) })'],
  {input: JSON.stringify(receipts), encoding: 'utf8'});
}
