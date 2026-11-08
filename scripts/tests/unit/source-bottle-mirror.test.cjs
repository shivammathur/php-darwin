const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const mirror = require('../../cache/source-bottle-mirror.cjs');
const {releaseAsset} = require('../../cache/source-bottle-releases.cjs');
const {keyFor} = require('../../cache/source-bottle-cache.cjs');
const {publish} = require('../../cache/upstream-bottle-cache.cjs');
const {retryPolicy} = require('../../release/extension-transfers.cjs');
const {fixture: r2Fixture} = require('../helpers/r2-fixture.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'source-mirror-api-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const bytes = Buffer.from('verified source bottle bundle');
  const inputs = {formula: 'openssl@4', version: '4.1.0',
    environment: {arch: 'x86_64', macos: '15', prefix: '/usr/local'}};
  const asset = {...releaseAsset({key: keyFor(inputs), inputs}), id: 123, state: 'uploaded',
    digest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`, size: bytes.length};
  const record = mirror.record(asset), calls = [];
  const run = (program, args) => {
    assert.equal(program, 'gh'); calls.push(args);
    if (args.at(-1) === 'repos/shivammathur/php-darwin/releases/tags/cache') return JSON.stringify({id: 456});
    assert.deepEqual(args, ['api', '--paginate', '--slurp', 'repos/shivammathur/php-darwin/releases/456/assets?per_page=100']);
    return JSON.stringify([[], [asset]]);
  };
  const env = {GH_TOKEN: 'fixture-token', CF_R2_AWS_S3_ENDPOINT: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`,
    CF_R2_AWS_ACCESS_KEY_ID: 'fixture', CF_R2_AWS_SECRET_ACCESS_KEY: 'fixture'};
  return {directory, bytes, asset, record, calls, run, env};
}

test('source mirror uses exact authenticated assets when public GitHub downloads fail', async t => {
  const f = fixture(t), origin = r2Fixture(); let apiReads = 0;
  const download = mirror.sourceDownload([f.record], {...f,
    request: async (url, options) => {
      assert.equal(url, 'https://api.github.com/repos/shivammathur/php-darwin/releases/assets/123');
      assert.equal(options.headers.Authorization, 'Bearer fixture-token');
      assert.equal(options.headers.Accept, 'application/octet-stream');
      apiReads++;
      return new Response(f.bytes);
    },
    download: async (url, file, options) => {
      assert.ok(url.startsWith(mirror.publicURL(f.record)), 'public GitHub must not be requested');
      assert.equal(options, undefined, 'no GitHub credentials on public mirror reads');
      fs.writeFileSync(file, origin.objects.get(mirror.key(f.record))); return 200;
    },
  });
  const options = {identity: mirror.portable, objectKey: mirror.key, upstream: false,
    env: f.env, run: origin.run, download};
  assert.equal((await publish([f.record], options))[0].result, 'uploaded');
  assert.equal((await publish([f.record], options))[0].result, 'existing');
  assert.equal(apiReads, 1);
  assert.equal(f.calls.length, 2);
  assert.equal(origin.calls.filter(call => call.operation === 'put-object').length, 1);
});

test('source mirror rejects changed asset identity before downloading or uploading', async t => {
  for (const change of [{id: 0}, {size: 1}, {digest: `sha256:${'0'.repeat(64)}`}, {state: 'starter'}, {name: 'other.tar'}]) {
    const f = fixture(t);
    Object.assign(f.asset, change);
    const download = mirror.sourceDownload([f.record], {...f, request: async () => assert.fail('invalid asset read')});
    await assert.rejects(download(f.record.url, path.join(f.directory, 'bundle')), /asset identity changed/);
    assert.equal(fs.existsSync(path.join(f.directory, 'bundle')), false);
  }
});

test('API outages and corrupt source bytes retain the shared three-attempt limit', async t => {
  for (const corrupt of [false, true]) {
    const f = fixture(t), origin = r2Fixture(); let reads = 0;
    const download = mirror.sourceDownload([f.record], {...f, request: async () => {
      reads++;
      return new Response('incorrect bytes', {status: corrupt ? 200 : 504});
    }});
    await assert.rejects(publish([f.record], {identity: mirror.portable, objectKey: mirror.key, upstream: false,
      env: f.env, run: origin.run, download, retry: retryPolicy({wait: async () => {}})}),
    corrupt ? /Invalid upstream bottle/ : /HTTP 504/);
    assert.equal(reads, 3);
    assert.equal(f.calls.length, 2);
    assert.equal(origin.calls.some(call => call.operation === 'put-object'), false);
  }
});
