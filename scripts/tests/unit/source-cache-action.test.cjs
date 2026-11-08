const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function invoke({stage = 'php', mode = 'approved', build = 'release', ts = 'nts', nightly = false, force = false} = {}) {
  const calls = [];
  const file = path.resolve(__dirname, '../../../.github/actions/source-cache/main.cjs');
  const env = {GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: '/unused', INPUT_STAGE: stage,
    INPUT_FORMULA: 'shivammathur/php/php@8.6', 'INPUT_DEPENDENCY-MODE': mode,
    INPUT_RELEASE: 'source-bottles-test-123', GITHUB_WORKFLOW_REF: 'repo/.github/workflows/test-source-cache.yml@main',
    'INPUT_FORCE-SOURCE': String(force), BUILD: build, TS: ts,
    ...(nightly ? {PHP_DARWIN_PHP_SRC_COMMIT: 'a'.repeat(40)} : {})};
  const argv = ['node', file, ...(stage === 'extensions' ?
    ['install-extensions', '/abstract.rb', '/opt/php', 'shivammathur/extensions/imagick@8.6'] : [])];
  const main = vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nmain', {
    process: {platform: 'darwin', env, argv}, __dirname: path.dirname(file), __filename: file,
    require(name) {
      if (name === 'node:fs') return {appendFileSync() {}};
      if (name === 'node:path') return path;
      if (name.endsWith('/source-bottle-cache.cjs')) return {
        async install(options) {calls.push(options); return {built: 0, restored: 1};},
        command() {assert.fail('Unexpected shell command');},
        extensionInputs: () => ({php: {api: '20260925'}, build, ts}),
      };
      if (name.endsWith('/source-bottle-releases.cjs')) return {ReleaseCache: class {}};
      if (name.endsWith('/approved-dependencies.cjs')) return {ApprovedDependencies: class {}, readLock: () => ({})};
      if (name.endsWith('/supervise-build.cjs')) return {supervise() {}};
      assert.fail(`Unexpected import: ${name}`);
    },
  });
  await main();
  assert.equal(calls.length, 1);
  return calls[0];
}

for (const stage of ['php', 'extensions']) {
  for (const build of ['release', 'debug']) for (const ts of ['nts', 'zts']) {
    test(`approved ${stage} ${build}/${ts} keep upstream selection except ABI-specific extensions`, async () => {
      const options = await invoke({stage, build, ts});
      assert.equal(options.forceSource, stage === 'extensions' && (build !== 'release' || ts !== 'nts'));
      assert.ok(options.approvedDependencies);
      if (stage === 'extensions') assert.equal(options.skipLink, true);
    });
  }
  test(`isolated ${stage} tests can still exercise native upstream selection`, async () => {
    const options = await invoke({stage, mode: 'update'});
    assert.equal(options.forceSource, false);
    assert.equal(options.approvedDependencies, undefined);
    assert.equal((await invoke({stage, mode: 'update', force: true})).forceSource, true);
  });
}
test('archive tools keep using the approved bottles directly', async () => {
  const options = await invoke({stage: 'tools'});
  assert.equal(options.formula, 'jq');
  assert.equal(Array.from(options.dependencyRoots).join(','), 'jq,zstd');
  assert.ok(options.approvedDependencies);
  assert.equal(options.forceSource, undefined);
});
test('nightly extensions retain their exact PHP source identity', async () => {
  const options = await invoke({stage: 'extensions', nightly: true});
  assert.equal(options.forceSource, false);
  assert.equal(options.context.php.source_commit, 'a'.repeat(40));
  for (const [build, ts] of [['release', 'zts'], ['debug', 'nts'], ['debug', 'zts']]) {
    assert.equal((await invoke({stage: 'extensions', nightly: true, build, ts})).forceSource, true);
  }
});
