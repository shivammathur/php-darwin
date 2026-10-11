const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

test('fresh PHP archives include exactly the declared installer without allowing unmanaged state', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-archive-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const file = path.join(directory, 'metadata.json'), contents = path.join(directory, 'contents');
  const controller = 'var/php-darwin/installer/install.sh';
  const run = (metadata, members) => {
    fs.writeFileSync(file, JSON.stringify(metadata));
    fs.writeFileSync(contents, members.join('\n') + '\n');
    return spawnSync('bash', ['scripts/build/verify-managed-paths.sh', file, contents], {encoding: 'utf8'});
  };
  for (const architecture of ['arm64', 'x86_64']) for (const build of ['release', 'debug']) for (const ts of ['nts', 'zts']) {
    const archive = `php_8.6-${ts}-${build}+darwin_${architecture}.tar.zst`;
    const metadata = {archive, installer: {schema: 1, path: controller}, pear_path: 'share/pear',
      packages: [{name: 'php@8.6'}], links: [{path: 'bin/php'}, {path: 'var/homebrew/linked/php@8.6'}],
      state_paths: ['etc/php/8.6/php.ini'], extensions: [{path: 'lib/php/pecl/20260925/xdebug.so'}]};
    const members = [`var/php-darwin/${archive.replace('.tar.zst', '.json')}`, controller,
      'Cellar/php@8.6/8.6.0/bin/php', 'opt/php@8.6', 'bin/php', 'var/homebrew/linked/php@8.6',
      'etc/php/8.6/php.ini', 'lib/php/pecl/20260925/xdebug.so', 'share/pear/pearcmd.php',
      'var/php-darwin/homebrew-php/Formula/php@8.6.rb'];
    assert.equal(run(metadata, members).status, 0, `${architecture}/${build}/${ts}`);
    for (const missing of [controller, 'opt/php@8.6', 'etc/php/8.6/php.ini']) {
      assert.match(run(metadata, members.filter(name => name !== missing)).stderr, /does not contain managed path/);
    }
    for (const extra of ['var/php-darwin/installer/extra.sh', 'var/unknown', 'etc/openssl@3/openssl.cnf']) {
      assert.match(run(metadata, [...members, extra]).stderr, /unmanaged path/);
    }
    for (const installer of [undefined, {schema: 2, path: controller}, {schema: 1, path: 'var/unknown'},
      {schema: 1, path: '../install.sh'}]) {
      assert.match(run({...metadata, installer}, members).stderr, /invalid packaged installer metadata/);
    }
  }
});
