const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { r2, fingerprint, credentials } = require('./scripts/lib/r2.cjs');
const { command, retryPolicy, publicReader } = require('./scripts/release/extension-transfers.cjs');
(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-live-'));
  const prefix = `validation/r2-publication-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
  const keys = new Set(), proof = { prefix, source: {}, cases: [], cleanup: [] };
  const endpoint = process.env.CF_R2_AWS_S3_ENDPOINT;
  const config = path.join(directory, 'aws-config');
  fs.writeFileSync(config, '[default]\ns3 =\n  multipart_threshold = 8MB\n  multipart_chunksize = 8MB\n');
  const env = credentials({ ...process.env, AWS_CONFIG_FILE: config, AWS_PROFILE: 'default' });
  const retry = retryPolicy({ budget: 24 });
  const raw = args => command('aws', ['--endpoint-url', endpoint, ...args], { env });
  const counts = new Map();
  const run = async (program, args, options) => {
    if (args.includes('put-object')) {
      const key = args[args.indexOf('--key') + 1]; counts.set(key, (counts.get(key) || 0) + 1);
    }
    return command(program, args, options);
  };
  const store = r2({ endpoint, env, run, retry });
  const read = publicReader({ directory });
  const track = name => { const key = `${prefix}/${name}`; keys.add(key); return key; };
  let failure;
  try {
    await command('gh', ['release', 'download', 'php-8.7', '--repo', 'shivammathur/php-darwin', '--pattern', 'php-8.7-manifest.json', '--dir', directory]);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'php-8.7-manifest.json')));
    const entry = manifest.assets.find(e => e.architecture === 'arm64' && e.build === 'release' && e.thread_safety === 'zts');
    assert.ok(entry);
    const name = entry.download || entry.name, file = path.join(directory, name);
    await command('gh', ['release', 'download', 'php-8.7', '--repo', 'shivammathur/php-darwin', '--pattern', name, '--dir', directory]);
    const expected = await fingerprint(file);
    assert.equal(expected.sha256, entry.sha256); assert.equal(expected.bytes, entry.bytes);
    proof.source = { name, sha256: expected.sha256, bytes: expected.bytes };
    const key = track(name);
    await store.ensure(file, key, { contentType: 'application/zstd' });
    assert.equal(counts.get(key), 1);
    await retry('Verify live public archive', () => read(file, `https://artifacts.php-darwin.setup-php.com/${prefix}`, { fresh: true, resume: true }));
    assert.equal((await store.ensure(file, key)).uploaded, false);
    assert.equal(counts.get(key), 1);
    proof.cases.push({ name: 'real_archive_upload_public_sha256_and_reuse', puts: 1, passed: true });

    const small = path.join(directory, 'small.txt'); fs.writeFileSync(small, 'verified R2 upload recovery\n');
    const smallInfo = await fingerprint(small);
    for (const mode of ['lost-response', 'uncommitted']) {
      const target = track(`${mode}.txt`); let puts = 0;
      const injected = r2({ endpoint, env, retry, run: async (program, args, options) => {
        if (args.includes('put-object')) {
          puts++;
          if (mode === 'uncommitted' && puts === 1) return JSON.stringify({ ETag: `"${smallInfo.md5}"` });
          const result = await command(program, args, options);
          if (mode === 'lost-response') throw new Error('Simulated lost successful reply');
          return result;
        }
        return command(program, args, options);
      } });
      await injected.ensure(small, target);
      assert.equal(puts, mode === 'lost-response' ? 1 : 2);
      proof.cases.push({ name: mode, puts, passed: true });
    }
    const legacy = track('legacy-multipart.tar.zst');
    await raw(['s3', 'cp', file, `s3://php-darwin/${legacy}`, '--only-show-errors']);
    const legacyHead = await store.head(legacy);
    assert.match(legacyHead.ETag, /-\d+"$/);
    assert.equal((await store.ensure(file, legacy)).uploaded, false);
    assert.equal(counts.get(legacy), undefined);
    proof.cases.push({ name: 'legacy_multipart_sha256_reuse', etag: legacyHead.ETag, puts: 0, passed: true });

    const invalid = track('bad-checksum.txt');
    await assert.rejects(raw(['s3api', 'put-object', '--bucket', 'php-darwin', '--key', invalid, '--body', small,
      '--content-md5', Buffer.alloc(16).toString('base64')]), /BadDigest|InvalidDigest|Content-MD5/i);
    assert.equal(await store.head(invalid), null);
    proof.cases.push({ name: 'server_rejects_invalid_content_md5', passed: true });
  } catch (error) { failure = error; }
  finally {
    for (const key of keys) {
      try {
        await retry('Clean validation object', () => raw(['s3api', 'delete-object', '--bucket', 'php-darwin', '--key', key]));
        assert.equal(await store.head(key), null);
        proof.cleanup.push({ key, removed: true });
      } catch (error) { failure ||= error; proof.cleanup.push({ key, removed: false }); }
    }
    proof.success = !failure;
    fs.writeFileSync('r2-validation.json', JSON.stringify(proof, null, 2) + '\n');
    fs.rmSync(directory, { recursive: true, force: true });
  }
  if (failure) throw failure;
  console.log(JSON.stringify(proof, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
