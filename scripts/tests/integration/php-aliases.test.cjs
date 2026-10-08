const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const scripts = path.resolve(__dirname, '../..');
function run(command, args) {
  const result = spawnSync(command, args, {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function fixture(t, formula = 'php', aliases = ['php@8.5'], version = '8.5.11') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'php-cache-aliases-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const prefix = path.join(root, 'prefix'), keg = `Cellar/${formula}/${version}`;
  fs.mkdirSync(path.join(prefix, keg, 'bin'), {recursive: true});
  fs.mkdirSync(path.join(prefix, 'opt'));
  for (const tool of ['php', 'phpize', 'php-config']) fs.writeFileSync(path.join(prefix, keg, 'bin', tool), `${formula} ${version} ${tool}\n`);
  const receipt = path.join(prefix, keg, 'INSTALL_RECEIPT.json');
  fs.writeFileSync(receipt, JSON.stringify({aliases}));
  const target = `../${keg}`;
  fs.symlinkSync(target, path.join(prefix, 'opt', formula));
  for (const alias of aliases || []) fs.symlinkSync(target, path.join(prefix, 'opt', alias));
  const collect = () => spawnSync(process.env.PHP_DARWIN_RUBY || 'ruby',
    [path.join(scripts, 'build/php-aliases.rb'), prefix, formula], {encoding: 'utf8'});
  return {root, prefix, keg, receipt, target, collect};
}

test('PHP receipt aliases survive archive filtering and extraction for every variant and a future minor', t => {
  for (const minor of ['8.5', '8.6']) for (const suffix of ['', '-zts', '-debug', '-debug-zts']) {
    const formula = `php${suffix}`, alias = `php@${minor}${suffix}`;
    const f = fixture(t, formula, [alias], `${minor}.11`);
    // Unrelated or stale opt links must not enter the new cache.
    fs.symlinkSync('../Cellar/other/1', path.join(f.prefix, 'opt/php@7.4'));
    const result = f.collect();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `opt/${alias}\t${f.target}\n`);
    const links = result.stdout.trim().split('\n').map(line => line.split('\t'));
    const members = ['INSTALL_RECEIPT.json', 'bin/php', 'bin/phpize', 'bin/php-config'].map(name => `${f.keg}/${name}`);
    members.push(`opt/${formula}`, ...links.map(([name]) => name));
    const paths = path.join(f.root, 'paths'), filtered = path.join(f.root, 'filtered');
    fs.writeFileSync(paths, members.join('\n') + '\n');
    run('bash', [path.join(scripts, 'build/filter-archive.sh'), f.prefix, paths, filtered]);
    assert.deepEqual(new Set(fs.readFileSync(filtered, 'utf8').trim().split('\n')), new Set(members));
    const archive = path.join(f.root, 'cache.tar'), extracted = path.join(f.root, 'extracted');
    run('tar', ['--no-recursion', '-cf', archive, '-C', f.prefix, '-T', filtered]);
    fs.mkdirSync(extracted);
    run('tar', ['-xf', archive, '-C', extracted]);
    for (const name of [formula, alias]) assert.equal(fs.readlinkSync(path.join(extracted, 'opt', name)), f.target);
    for (const tool of ['php', 'phpize', 'php-config']) {
      assert.deepEqual(fs.readFileSync(path.join(extracted, 'opt', alias, 'bin', tool)), fs.readFileSync(path.join(f.prefix, f.keg, 'bin', tool)));
    }
    assert.deepEqual(fs.readFileSync(path.join(extracted, f.keg, 'INSTALL_RECEIPT.json')), fs.readFileSync(f.receipt));
    assert.equal(fs.existsSync(path.join(extracted, 'opt/php@7.4')), false);
  }
});

test('canonical versioned PHP formulae without aliases remain valid', t => {
  for (const aliases of [[], null]) {
    const f = fixture(t, 'php@8.4-debug-zts', aliases, '8.4.26');
    const result = f.collect();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  }
});

test('invalid receipts and missing or conflicting PHP aliases fail packaging', t => {
  for (const aliases of [['../escape'], ['php@8.5', 'php@8.5'], [null], 'php@8.5', ['php']]) {
    const f = fixture(t);
    fs.writeFileSync(f.receipt, JSON.stringify({aliases}));
    assert.notEqual(f.collect().status, 0);
  }
  for (const conflict of ['missing', 'wrong-keg', 'regular-file']) {
    const f = fixture(t), alias = path.join(f.prefix, 'opt/php@8.5');
    fs.unlinkSync(alias);
    if (conflict === 'wrong-keg') fs.symlinkSync('../Cellar/php/8.5.10', alias);
    if (conflict === 'regular-file') fs.writeFileSync(alias, 'user file');
    assert.notEqual(f.collect().status, 0);
    if (conflict === 'regular-file') assert.equal(fs.readFileSync(alias, 'utf8'), 'user file');
  }
});
