const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { install, command, digest } = require('../../installer/install-extensions.cjs');

const output = process.env.EXTENSION_PACK_OUTPUT || 'builds/extensions';
const name = process.env.EXTENSION_PACK;
const files = fs.readdirSync(output).filter(file => file.endsWith('.json'));
assert.equal(files.length, 1);
const entry = JSON.parse(fs.readFileSync(path.join(output, files[0])));
assert.equal(entry.name, name);
assert.equal(digest(fs.readFileSync(path.join(output, entry.file))), entry.sha256);
const temporary = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'extension-pack-test-'));
const phpFormula = command('bash', ['-c', '. scripts/lib/lib.sh; php_darwin_formula "$PHP_VERSION" "$BUILD" "$TS"']);
const prefix = command('brew', ['--prefix']);
const php = path.join(prefix, 'opt', phpFormula, 'bin/php');
const phpConfig = path.join(prefix, 'opt', phpFormula, 'bin/php-config');
const phpHash = digest(fs.readFileSync(fs.realpathSync(php)));
const beforeKegs = command('brew', ['list', '--versions']).split('\n').filter(line => /^php(?:@| )/.test(line));
const beforeServices = command('brew', ['services', 'list', '--json']);
const extensionDirectory = command(phpConfig, ['--extension-dir']);
// Keep the modules produced during the build outside PHP's extension directory
// so this test proves the optional archive supplies them itself.
const previous = [];
try {
  fs.copyFileSync(path.join(output, entry.file), path.join(temporary, entry.file));
  fs.writeFileSync(path.join(temporary, `${name}.json`), JSON.stringify(entry));
  for (const module of entry.modules) {
    const target = path.join(extensionDirectory, `${module}.so`);
    if (fs.existsSync(target)) {
      const backup = path.join(temporary, `${module}.build`);
      fs.renameSync(target, backup);
      previous.push({ target, backup });
    }
  }
  const started = performance.now();
  const result = install(temporary, name, { php, phpConfig });
  const elapsed = (performance.now() - started) / 1000;
  assert.equal(fs.statSync(result.destination).mode & 0o777, 0o755, 'Runtime must be accessible to other PHP process users');
  assert.ok(elapsed < 10, `Optional ${name} installation took ${elapsed.toFixed(3)}s`);
  const load = result.modules.flatMap(module => ['-d', `extension=${extensionDirectory}/${module}.so`]);
  const checks = {
    imagick: '$i=new Imagick(); $i->newImage(16,16,"white"); foreach (["PNG","JPEG","WEBP"] as $f) { $i->setImageFormat($f); if (strlen($i->getImageBlob())<10) { exit(1); } } echo "PNG JPEG WEBP passed\\n";',
    mongodb: '$b=MongoDB\\BSON\\Document::fromPHP(["cache"=>42]); $r=$b->toPHP(); if ($r->cache!==42) { exit(1); } echo "BSON roundtrip passed\\n";',
    memcached: '$m=new Memcached(); foreach ([Memcached::SERIALIZER_PHP,Memcached::SERIALIZER_IGBINARY,Memcached::SERIALIZER_MSGPACK] as $s) { if (!$m->setOption(Memcached::OPT_SERIALIZER,$s)) { exit(1); } } echo "PHP igbinary msgpack serializers passed\\n";',
  };
  console.log(command(php, ['-n', ...load, '-r', checks[name]], { env: { ...process.env, ...result.environment } }));
  if (name === 'mongodb') {
    assert.ok(result.environment.SASL_PATH, 'MongoDB must use its private SASL plugins');
    const viewer = path.resolve(result.environment.SASL_PATH, '../../sbin/pluginviewer');
    assert.match(command(viewer, ['-c'], { env: { ...process.env, ...result.environment } }), /\bPLAIN\b/);
    console.log('Private SASL authentication plugins passed');
  }
  assert.equal(digest(fs.readFileSync(fs.realpathSync(php))), phpHash);
  assert.deepEqual(command('brew', ['list', '--versions']).split('\n').filter(line => /^php(?:@| )/.test(line)), beforeKegs);
  assert.equal(command('brew', ['services', 'list', '--json']), beforeServices);
  const report = { name, sha256: entry.sha256, install_seconds: elapsed, bytes: entry.bytes, php_preserved: true, services_preserved: true };
  fs.writeFileSync(path.join(output, 'validation.txt'), JSON.stringify(report) + '\n');
  console.log(JSON.stringify(report));
} finally {
  for (const module of entry.modules) fs.rmSync(path.join(extensionDirectory, `${module}.so`), { force: true });
  for (const item of previous) fs.renameSync(item.backup, item.target);
  fs.rmSync(temporary, { recursive: true, force: true });
}
