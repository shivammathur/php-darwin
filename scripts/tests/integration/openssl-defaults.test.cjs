const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {stage, runtimeStatePaths} = require('../../build/openssl-defaults.cjs');

test('OpenSSL defaults survive packaging on a warm host and preserve client configuration', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openssl-defaults-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const prefix = path.join(root, 'host'), defaults = path.join(root, 'defaults');
  const write = (base, name, value) => {
    const file = path.join(base, name);
    fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, value);
  };
  const packages = [
    {name: 'openssl@4', opt_target: '../Cellar/openssl@4/4.0.3'},
    {name: 'ca-certificates', opt_target: '../Cellar/ca-certificates/2026-09-25'},
  ];
  const config = 'etc/openssl@4/openssl.cnf', cert = 'etc/ca-certificates/cert.pem';
  write(prefix, 'Cellar/openssl@4/4.0.3/.bottle/' + config, 'public default configuration');
  write(prefix, 'Cellar/ca-certificates/2026-09-25/share/ca-certificates/cacert.pem', 'Mozilla certificates');
  write(prefix, config, 'private build host configuration');
  write(prefix, cert, 'private build host certificates');
  write(prefix, 'metadata', 'archive metadata');
  write(prefix, 'Cellar/php@8.6/8.6.0/bin/php', 'PHP runtime');
  fs.mkdirSync(path.join(prefix, 'bin'));
  fs.symlinkSync('../Cellar/php@8.6/8.6.0/bin/php', path.join(prefix, 'bin/php'));
  const result = stage(prefix, packages, defaults);
  assert.equal(fs.readFileSync(path.join(prefix, config), 'utf8'), 'private build host configuration');
  assert.deepEqual(result.paths, [cert, 'etc/openssl@4/cert.pem', config].sort());
  const archive = path.join(root, 'defaults.tar');
  const paths = path.join(root, 'default-paths'), prefixPaths = path.join(root, 'prefix-paths');
  fs.writeFileSync(paths, result.paths.join('\n') + '\n');
  const tar = process.env.PHP_DARWIN_TEST_TAR || 'tar';
  // Production packaging requires macOS/BSD tar. Keep the same archive-content
  // regression useful under GNU tar in the Linux validation job as well.
  const bsdTar = execFileSync(tar, ['--version'], {encoding: 'utf8'}).includes('bsdtar');
  const changeDirectory = bsdTar ? ['-C', defaults] : ['-C ' + defaults];
  fs.writeFileSync(prefixPaths, ['metadata', 'Cellar/php@8.6/8.6.0/bin/php', 'bin/php',
    ...changeDirectory, ...result.paths].join('\n') + '\n');
  execFileSync(tar, ['--no-recursion', '-cf', archive, '-C', prefix, '-T', prefixPaths]);
  for (const existing of [false, true]) {
    const client = path.join(root, 'client-' + existing); fs.mkdirSync(client);
    if (existing) {write(client, config, 'user configuration'); write(client, cert, 'user certificates');}
    const excludes = path.join(root, 'excludes'), kegs = path.join(root, 'kegs'), packagesFile = path.join(root, 'package-kegs');
    fs.writeFileSync(packagesFile, '');
    execFileSync('bash', [path.join(__dirname, '../../installer/existing-paths.sh'), client, excludes,
      path.join(__dirname, '../../../conf/archive-paths'), kegs, paths, packagesFile]);
    // Exercise the same extraction exclusions that protect installed user files.
    execFileSync(tar, ['-xf', archive, '-C', client, '-X', excludes]);
    assert.equal(fs.readFileSync(path.join(client, 'metadata'), 'utf8'), 'archive metadata');
    assert.equal(fs.readFileSync(path.join(client, 'bin/php'), 'utf8'), 'PHP runtime');
    assert.equal(fs.readFileSync(path.join(client, config), 'utf8'), existing ? 'user configuration' : 'public default configuration');
    assert.equal(fs.readFileSync(path.join(client, 'etc/openssl@4/cert.pem'), 'utf8'), existing ? 'user certificates' : 'Mozilla certificates');
  }
  fs.unlinkSync(path.join(prefix, 'Cellar/openssl@4/4.0.3/.bottle/' + config));
  assert.throws(() => stage(prefix, packages, path.join(root, 'missing')), /ENOENT/);
});


test('packaging excludes configuration belonging to OpenSSL outside the runtime closure', () => {
  const paths = ['etc/openssl@3/misc/tsget.default', 'etc/openssl@3/misc/tsget.pl.default',
    'etc/openssl@1.1/openssl.cnf', 'etc/openssl/openssl.cnf', 'etc/openssl@4/openssl.cnf',
    'etc/openssl-helper/config', 'etc/php/8.7/php.ini'];
  const selected = runtimeStatePaths(paths, [{name: 'openssl@4'}]);
  assert.deepEqual(selected, paths.slice(4));
  assert.equal(paths.length, 7);
  assert.deepEqual(runtimeStatePaths(paths, []), paths.slice(5));
});
