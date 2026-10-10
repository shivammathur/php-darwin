const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {verifyOpenSslLinkage, verifyRuntimeLinkage} = require('../../cache/openssl-linkage.cjs');

test('dependency approval rejects the wrong OpenSSL ABI in a plugin', t => {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'openssl-linkage-'));
  t.after(() => fs.rmSync(prefix, {recursive: true, force: true}));
  const lib = path.join(prefix, 'lib', 'plugins');
  fs.mkdirSync(lib, {recursive: true});
  fs.writeFileSync(path.join(lib, 'ssl.so'), Buffer.from('cffaedfe00000000', 'hex'));
  fs.writeFileSync(path.join(lib, 'metadata.txt'), 'ordinary text');
  fs.symlinkSync(prefix, path.join(lib, 'loop'));
  const link = major => `plugin:\n\t/opt/homebrew/opt/openssl@${major}/lib/libcrypto.${major}.dylib (compatibility version 1.0.0)\n`;
  assert.equal(verifyOpenSslLinkage(prefix, '4', () => link(4)), 1);
  assert.throws(() => verifyOpenSslLinkage(prefix, '4', () => link(3)), /ssl.so links OpenSSL 3, expected 4/);
  assert.throws(() => verifyOpenSslLinkage(prefix, '3', () => link(4)), /expected 3/);
  assert.equal(verifyOpenSslLinkage(prefix, '4', () => 'plugin:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n'), 0);
  const framework = path.join(prefix, 'Frameworks/Python.framework/Versions/3.14/lib/python3.14/lib-dynload');
  fs.mkdirSync(framework, {recursive: true});
  fs.writeFileSync(path.join(framework, '_ssl.so'), Buffer.from('cffaedfe00000000', 'hex'));
  assert.throws(() => verifyOpenSslLinkage(prefix, '4', file => file.includes('/Frameworks/') ? link(3) : link(4)), /_ssl.so links OpenSSL 3/);
});

test('dependency approval rejects an optional library found only on the build runner', t => {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-linkage-'));
  t.after(() => fs.rmSync(prefix, {recursive: true, force: true}));
  fs.mkdirSync(path.join(prefix, 'lib'));
  fs.writeFileSync(path.join(prefix, 'lib/libnetsnmpagent.dylib'), Buffer.from('cffaedfe00000000', 'hex'));
  const inspect = () => 'libnetsnmpagent:\n' +
    '\t/opt/homebrew/opt/openssl@4/lib/libcrypto.4.dylib (compatibility version 4.0.0)\n' +
    '\t/opt/homebrew/opt/pcre/lib/libpcre.1.dylib (compatibility version 4.0.0)\n' +
    '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n';
  assert.throws(() => verifyRuntimeLinkage(prefix, '/opt/homebrew', ['net-snmp', 'openssl@4'], inspect),
    /libnetsnmpagent.dylib links undeclared runtime dependency pcre/);
  assert.doesNotThrow(() => verifyRuntimeLinkage(prefix, '/opt/homebrew', ['net-snmp', 'openssl@4', 'pcre'], inspect));
});
