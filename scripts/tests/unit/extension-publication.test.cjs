const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {digest, key} = require('../../installer/install-extensions.cjs');
const {publicationEntries} = require('../../release/extension-packs.cjs');
const {prepare, validatePlan, uploadReceipt, verifyReceipts} = require('../../release/extension-publication.cjs');

function fixture(t, groups, {flatten = false} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-publication-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const directory = path.join(root, 'downloads'), output = path.join(root, 'plan.json');
  fs.mkdirSync(directory);
  const entries = [], artifacts = groups.map((group, index) => ({id: 100 + index, name: group.artifact, expired: false}));
  for (const group of groups) for (const value of group.entries) {
    const entry = {schema: 1, name: 'swoole', php_version: '8.4', php_semver: '8.4.26', php_src_commit: '',
      php_api: '20240924', architecture: 'x86_64', build: 'release', thread_safety: 'nts',
      minimum_macos: 15, inputs_sha256: 'b'.repeat(64), ...value};
    const bytes = Buffer.from(key(entry));
    Object.assign(entry, {sha256: digest(bytes), bytes: bytes.length});
    entry.file = `${key(entry)}-${entry.sha256}.tar.zst`;
    const folder = path.join(directory, ...(flatten ? [] : [group.artifact]), `extension-${key(entry)}`);
    fs.mkdirSync(folder, {recursive: true});
    fs.writeFileSync(path.join(folder, entry.file), bytes);
    fs.writeFileSync(path.join(folder, 'metadata.json'), JSON.stringify(entry));
    fs.writeFileSync(path.join(folder, 'validation.txt'), JSON.stringify({name: entry.name, sha256: entry.sha256,
      bytes: entry.bytes, php_preserved: true, services_preserved: true}));
    entries.push(entry);
  }
  // Only producer payloads participate in the download pattern, not their indexes,
  // compatibility reports, publication plans, or expired earlier attempts.
  artifacts.push({id: 200, name: 'extension-index-built-8.4-x86_64-release-nts'},
    {id: 201, name: 'compatibility-8.4-macos-15-intel'},
    {id: 202, name: 'extension-publication-plan'},
    {id: 203, name: 'extension-built-8.4-arm64-release-nts', expired: true});
  for (const [name, value] of Object.entries({SOURCE_RUN: '123', GITHUB_RUN_ID: '456',
    EXTENSION_RECOVERY_KEYS: JSON.stringify(entries.map(key)), PHP_DARWIN_FAST_REFRESH: 'false',
    GITHUB_OUTPUT: path.join(root, 'outputs'), EXTENSION_PUBLISH_REPORT: path.join(root, 'report.json'),
    GITHUB_STEP_SUMMARY: path.join(root, 'summary'), CF_R2_AWS_ACCESS_KEY_ID: 'fixture',
    CF_R2_AWS_SECRET_ACCESS_KEY: 'fixture', CF_R2_AWS_S3_ENDPOINT: 'https://fixture.invalid'})) {
    const previous = process.env[name]; process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/php-8.4-manifest.json')) return Response.json({schema: 1, php_version: '8.4',
      php_semver: '8.4.26', assets: entries});
    assert.match(url, /^https:\/\/api.github.com\/repos\/shivammathur\/php-darwin\/releases\/tags\/extensions$/);
    return new Response('', {status: 200});
  });
  const run = async (program, args) => {
    if (program === 'aws' && args.includes('list-objects-v2')) return '{"Contents":[]}';
    assert.equal(program, 'gh'); assert.equal(args[0], 'api');
    if (args.includes('repos/shivammathur/php-darwin/actions/runs/123/artifacts?per_page=100')) {
      return JSON.stringify([{artifacts}]);
    }
    if (args.some(arg => arg.endsWith('/releases/tags/extensions'))) return '{"id":1}';
    assert.ok(args.includes('repos/shivammathur/php-darwin/releases/1/assets?per_page=100'));
    return '[[]]';
  };
  return {root, directory, output, artifacts, entries,
    prepare: () => prepare(directory, output, {run, retry: async (_label, fn) => fn()})};
}

for (const flatten of [false, true]) {
  test(`single producer ${flatten ? 'flattened' : 'nested'} download preserves immutable shard ownership`, async t => {
    const f = fixture(t, [{artifact: 'extension-built-8.4-x86_64-release-nts', entries: [{}]}], {flatten});
    await f.prepare();
    const plan = validatePlan(JSON.parse(fs.readFileSync(f.output))), id = digest(fs.readFileSync(f.output));
    assert.equal(plan.source_run, '123'); assert.equal(plan.publication_run, '456');
    assert.deepEqual(plan.entries, f.entries);
    assert.deepEqual(plan.shards, [{id: '8.4-x86_64-release-nts', keys: f.entries.map(key), artifact_ids: '100'}]);
    // The upload worker may also receive a flattened single-ID download. Its
    // selected records and receipt must remain bound to the prepared metadata.
    const records = publicationEntries(f.directory, plan.shards[0].keys);
    assert.deepEqual(records.map(record => record.entry), plan.entries);
    const receipts = path.join(f.root, 'receipts'); fs.mkdirSync(receipts);
    records.forEach(record => { record.delivery = {etag: '"' + 'a'.repeat(32) + '"'}; });
    fs.writeFileSync(path.join(receipts, 'receipt.json'), JSON.stringify(uploadReceipt(plan, id, plan.shards[0], records)));
    assert.equal(verifyReceipts(plan, id, receipts).size, 1);
  });
}

test('one flattened reused artifact can serve multiple variant shards', async t => {
  const f = fixture(t, [{artifact: 'extension-reused-8.4-x86_64', entries: [{}, {build: 'debug'}]}], {flatten: true});
  await f.prepare();
  const plan = JSON.parse(fs.readFileSync(f.output));
  assert.equal(plan.shards.length, 2);
  assert.deepEqual(plan.shards.map(shard => shard.artifact_ids), ['100', '100']);
  for (const shard of plan.shards) assert.equal(publicationEntries(f.directory, shard.keys).length, 1);
});

test('multiple nested built and reused producers retain their exact artifact IDs', async t => {
  const f = fixture(t, [
    {artifact: 'extension-built-8.4-x86_64-release-nts', entries: [{}]},
    {artifact: 'extension-reused-8.4-x86_64', entries: [{name: 'redis'}, {build: 'debug'}]},
  ]);
  await f.prepare();
  const plan = JSON.parse(fs.readFileSync(f.output));
  assert.equal(plan.shards.find(shard => shard.id === '8.4-x86_64-release-nts').artifact_ids, '100,101');
  assert.equal(plan.shards.find(shard => shard.id === '8.4-x86_64-debug-nts').artifact_ids, '101');
});

for (const problem of ['missing', 'expired', 'ambiguous', 'duplicate', 'invalid ID', 'unexpected directory']) {
  test(`flattened download rejects ${problem} ownership`, async t => {
    const f = fixture(t, [{artifact: 'extension-built-8.4-x86_64-release-nts', entries: [{}]}], {flatten: true});
    if (problem === 'missing') f.artifacts.shift();
    if (problem === 'expired') f.artifacts[0].expired = true;
    if (problem === 'ambiguous') f.artifacts.push({id: 101, name: 'extension-reused-8.4-x86_64'});
    if (problem === 'duplicate') f.artifacts.push({...f.artifacts[0], id: 101});
    if (problem === 'invalid ID') f.artifacts[0].id = 0;
    if (problem === 'unexpected directory') fs.renameSync(path.join(f.directory, `extension-${key(f.entries[0])}`),
      path.join(f.directory, 'unexpected'));
    await assert.rejects(f.prepare(), /Missing or ambiguous source artifact/);
    assert.equal(fs.existsSync(f.output), false);
  });
}
