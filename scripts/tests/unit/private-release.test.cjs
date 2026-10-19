const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const {sourceName, selectSource, rewriteFormula, rewriteTap, validateSource} = require('../../private/source.cjs');
const {validatePlan, validateBuild, verifyReady, sign, names, variantKey, sha, requireUnquarantined} = require('../../private/release.cjs');
const {r2} = require('../../lib/r2.cjs');
const {fixture} = require('../helpers/r2-fixture.cjs');
const key = 'f'.repeat(64);
function approved() {
  const platforms = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../conf/platforms.json')));
  const builds = Object.entries(platforms).flatMap(([arch, p]) => ['debug', 'release'].flatMap(build => ['nts', 'zts'].map(ts => ({arch, build, ts, runner: p.build_runner}))));
  const tests = Object.entries(platforms).flatMap(([arch, p]) => p.test_runners.filter(r => r !== 'macos-latest').map(runner => ({arch, runner})));
  const plan = {schema: 1, id: '123-1', repository: 'shivammathur/php-darwin', revision: 'a'.repeat(40), ref: 'refs/heads/main',
    php_version: '8.4', source: {...sourceName('php-8.4.99.tar.xz'), sha256: 'b'.repeat(64), bytes: 100},
    base_tap_commit: 'c'.repeat(40), tap_commit: 'd'.repeat(40), extensions_commit: 'e'.repeat(40), core_commit: 'f'.repeat(40),
    tap_sha256: 'a'.repeat(64), builds, tests};
  const records = builds.map(b => ({variant: variantKey(b), arch: b.arch, status: 'success', plan_sha256: sha(plan),
    files: names(plan, b).map(name => ({name, bytes: 100, sha256: 'e'.repeat(64)}))}));
  const payload = {plan, builds: records, tests: tests.map(t => ({...t, status: 'success', plan_sha256: sha(plan),
    build_sha256: records.filter(b => b.arch === t.arch).map(sha).sort()}))};
  return {payload, signature: sign(payload, key)};
}
test('source names bind the full release to the requested minor and ambiguous uploads require a filename', () => {
  for (const ext of ['xz', 'gz']) assert.equal(sourceName(`php-8.4.99.tar.${ext}`, '8.4').version, '8.4.99');
  for (const name of ['../php-8.4.99.tar.xz', 'php-8.5.0.tar.xz', 'php-8.4.99RC1.tar.gz', 'php-8.4.099.tar.xz']) {
    assert.throws(() => sourceName(name, '8.4'));
  }
  assert.equal(selectSource(['uploads/', 'uploads/php-8.4.99.tar.gz', 'uploads/php-8.3.0.tar.xz'], '8.4').version, '8.4.99');
  assert.throws(() => selectSource(['uploads/php-8.4.98.tar.xz', 'uploads/php-8.4.99.tar.xz'], '8.4'), /Specify/);
});
test('generated formula removes stale bottles/revisions without changing dependencies or patches', () => {
  const source = {...sourceName('php-8.4.99.tar.gz'), sha256: 'a'.repeat(64)};
  const text = 'class Php < Formula\n  url "https://old"\n  mirror "https://old-mirror"\n  sha256 "old"\n  revision 3\n  bottle do\n    sha256 arm64: "old"\n  end\n  depends_on "icu4c"\n  patch do\n    url "https://patch"\n    sha256 "patch"\n  end\nend\n';
  const result = rewriteFormula(text, source);
  assert.ok(result.includes(source.url)); assert.ok(result.includes(source.sha256));
  assert.ok(!/bottle do|revision 3|mirror/.test(result));
  assert.ok(result.includes('  depends_on "icu4c"')); assert.ok(result.includes('    sha256 "patch"'));
  assert.throws(() => rewriteFormula('class Php\nend\n', source), /Unsupported/);
});
test('private tap rewrites versioned formulae and aliases for the current stable minor', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'private-tap-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const text = 'class Php < Formula\n  url "https://old"\n  sha256 "old"\nend\n';
  const source = {...sourceName('php-8.5.99.tar.xz'), sha256: 'a'.repeat(64)};
  for (const layout of ['versioned', 'alias', 'formula-link']) {
    const tap = path.join(directory, layout);
    fs.mkdirSync(path.join(tap, 'Formula'), {recursive: true});
    fs.mkdirSync(path.join(tap, 'Aliases'));
    fs.writeFileSync(path.join(tap, 'Formula/php@8.4.rb'), text);
    for (const suffix of ['', '-zts', '-debug', '-debug-zts']) {
      const name = `php@8.5${suffix}`;
      const target = (layout === 'versioned' ? name : `php${suffix}`) + '.rb';
      fs.writeFileSync(path.join(tap, 'Formula', target), text);
      if (layout === 'alias') fs.symlinkSync('../Formula/' + target, path.join(tap, 'Aliases', name));
      if (layout === 'formula-link') fs.symlinkSync(target, path.join(tap, 'Formula', name + '.rb'));
    }
    rewriteTap(tap, source);
    for (const suffix of ['', '-zts', '-debug', '-debug-zts']) {
      const name = (layout === 'versioned' ? `php@8.5${suffix}` : `php${suffix}`) + '.rb';
      assert.equal(fs.readFileSync(path.join(tap, 'Formula', name), 'utf8'), rewriteFormula(text, source));
    }
    assert.equal(fs.readFileSync(path.join(tap, 'Formula/php@8.4.rb'), 'utf8'), text);
    if (layout !== 'alias') continue;
    const alias = path.join(tap, 'Aliases/php@8.5-zts');
    fs.unlinkSync(alias);
    fs.symlinkSync('../Formula/php.rb', alias);
    assert.throws(() => rewriteTap(tap, source), /Invalid PHP formula aliases/);
    fs.unlinkSync(alias);
    fs.writeFileSync(path.join(tap, 'outside.rb'), text);
    fs.symlinkSync('../outside.rb', alias);
    assert.throws(() => rewriteTap(tap, source), /Invalid PHP formula aliases/);
    assert.equal(fs.readFileSync(path.join(tap, 'outside.rb'), 'utf8'), text);
  }
});
test('source archive validation checks its header and rejects misleading versions for both compressions', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'private-source-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const root = path.join(directory, 'php-8.4.99'); fs.mkdirSync(path.join(root, 'main'), {recursive: true});
  fs.writeFileSync(path.join(root, 'main/php_version.h'), '#define PHP_VERSION "8.4.99"\n');
  fs.writeFileSync(path.join(root, 'configure'), 'fixture');
  for (const ext of ['xz', 'gz']) {
    const file = path.join(directory, `php-8.4.99.tar.${ext}`);
    assert.equal(spawnSync('tar', [ext === 'xz' ? '-cJf' : '-czf', file, '-C', directory, 'php-8.4.99'], {env: {...process.env, COPYFILE_DISABLE: '1'}}).status, 0);
    const result = await validateSource(file, sourceName(path.basename(file), '8.4'));
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    await assert.rejects(validateSource(file, {...sourceName(path.basename(file)), sha256: 'f'.repeat(64)}), /checksum/);
  }
  fs.writeFileSync(path.join(root, 'main/php_version.h'), '#define PHP_VERSION "8.4.98"\n');
  const wrong = path.join(directory, 'wrong.tar.gz');
  spawnSync('tar', ['-czf', wrong, '-C', directory, 'php-8.4.99'], {env: {...process.env, COPYFILE_DISABLE: '1'}});
  await assert.rejects(validateSource(wrong, sourceName('php-8.4.99.tar.gz')), /Invalid PHP source archive/);
});
test('approval survives deletion of GitHub runs and binds the complete tested bytes', () => {
  const record = approved();
  assert.equal(verifyReady(record, '123-1', key).builds.length, 8);
  for (const mutate of [
    r => { r.payload.builds[0].files[0].sha256 = 'a'.repeat(64); },
    r => { r.payload.tests.pop(); },
    r => { r.payload.plan.source.sha256 = 'a'.repeat(64); },
  ]) {
    const altered = structuredClone(record); mutate(altered);
    assert.throws(() => verifyReady(altered, '123-1', key), /signature/);
  }
  for (const mutate of [
    r => { r.payload.tests[0].status = 'failure'; },
    r => { r.payload.builds[0].files[0].name = '../archive'; },
    r => { r.payload.plan.builds.pop(); },
    r => { r.payload.plan.ref = 'refs/heads/feature/test'; },
    r => { r.payload.tests[0].build_sha256 = []; },
  ]) {
    const altered = structuredClone(record); mutate(altered); altered.signature = sign(altered.payload, key);
    assert.throws(() => verifyReady(altered, '123-1', key));
  }
  assert.throws(() => verifyReady(record, '124-1', key));
  assert.throws(() => validatePlan({...record.payload.plan, php_version: "8.4'; exit 1; '"}, '123-1'));
});
test('private storage uses its own bucket, conditional writes and non-public cache headers', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'private-r2-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const file = path.join(directory, 'file'); fs.writeFileSync(file, 'candidate');
  const f = fixture(), store = r2({endpoint: 'https://fixture.invalid', bucket: 'php-darwin-private', privateObjects: true,
    run: f.run, env: {}, retry: async (_label, work) => work()});
  await store.ensure(file, 'builds/123-1/file', {replace: false});
  const put = f.calls.find(c => c.operation === 'put-object').args;
  for (const [option, value] of [['--bucket', 'php-darwin-private'], ['--cache-control', 'private, no-store'], ['--if-none-match', '*']]) {
    assert.equal(put[put.indexOf(option) + 1], value);
  }
  fs.writeFileSync(file, 'changed');
  await assert.rejects(store.ensure(file, 'builds/123-1/file', {replace: false}), /conflict/);
  assert.equal(f.calls.filter(c => c.operation === 'put-object').length, 1);
});


test('private workflow handoffs never use GitHub artifacts, caches or publishers', () => {
  for (const name of ['cache-private.yml', 'build-private-architecture.yml', 'cleanup-private.yml']) {
    const workflow = fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows', name), 'utf8');
    assert.doesNotMatch(workflow, /actions\/(?:upload-artifact|download-artifact|cache)@|gh\s+(?:release|run download)|scripts\/release\.sh/);
    if (name !== 'cleanup-private.yml') {
      assert.doesNotMatch(workflow, /contents: write|secrets\.TOKEN/);
      assert.match(workflow, /scripts\/private\/run\.cjs/);
    }
  }
});

test('new plans require permission validation for every package', () => {
  const {plan, builds} = approved().payload;
  plan.artifact_permissions = 'public-readable-v1';
  validatePlan(plan, plan.id);
  const record = {...builds[0], plan_sha256: sha(plan)};
  assert.throws(() => validateBuild(record, plan, plan.builds[0]), /Invalid staged build/);
  record.artifact_permissions = plan.artifact_permissions;
  validateBuild(record, plan, plan.builds[0]);
  assert.throws(() => validatePlan({...plan, artifact_permissions: 'unknown'}, plan.id), /Invalid private build plan/);
});

test('quarantined builds cannot be signed or promoted, and storage errors fail closed', async () => {
  await requireUnquarantined({head: async key => {assert.equal(key, 'builds/123-1/quarantine.json'); return null;}}, '123-1');
  await assert.rejects(requireUnquarantined({head: async () => ({ContentLength: 1})}, '123-1'), /quarantined/);
  await assert.rejects(requireUnquarantined({head: async () => {throw new Error('storage unavailable');}}, '123-1'), /unavailable/);
});

test('bounded source reader rejects malformed Git exports and release archives', () => {
  const result = spawnSync('python3', [path.join(__dirname, 'private-source.test.py')], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
});
