const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {stage, commit, validateReceipt, selectVariant, recovery, prune} = require('../../release/repackage-release.cjs');
const {fixture: r2Fixture} = require('../helpers/r2-fixture.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'repackage-delivery-test-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const prepared = path.join(directory, 'prepared'), evidence = path.join(directory, 'evidence');
  fs.mkdirSync(prepared); fs.mkdirSync(evidence);
  const version = '8.5', tag = 'php-8.5', manifest = {schema: 1, php_version: version, assets: []};
  const previous = structuredClone(manifest), github = new Map(), cloudflare = r2Fixture();
  const installer = Buffer.from('new release installer\n'), oldInstaller = Buffer.from('previous installer\n');
  for (const build of ['debug', 'release']) for (const ts of ['nts', 'zts']) for (const arch of ['arm64', 'x86_64']) {
    const name = `php_${version}-${ts}-${build}+darwin_${arch}.tar.zst`;
    const bytes = Buffer.from(`new ${name}`), sha256 = hash(bytes), old = hash(`old ${name}`);
    const asset = {name, architecture: arch, build, thread_safety: ts, sha256, bytes: bytes.length,
      download: name.replace('.tar.zst', `.${sha256}.tar.zst`)};
    manifest.assets.push(asset);
    previous.assets.push({...asset, sha256: old, download: name.replace('.tar.zst', `.${old}.tar.zst`)});
    fs.writeFileSync(path.join(prepared, asset.download), bytes);
    fs.writeFileSync(path.join(prepared, asset.download + '.sha256'), `${sha256}  ${asset.download}\n`);
    fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify({archive: name, input_sha256: old,
      sha256, php_rebuilt: false, payload_members_unchanged: 700}));
  }
  const previousBytes = Buffer.from(JSON.stringify(previous, null, 2) + '\n');
  fs.writeFileSync(path.join(evidence, `${tag}-manifest.json`), previousBytes);
  fs.writeFileSync(path.join(prepared, `${tag}-manifest.json`), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(prepared, 'install.sh'), installer);
  for (const [name, bytes] of [[`${tag}-manifest.json`, previousBytes], ['install.sh', oldInstaller]]) {
    github.set(name, bytes); cloudflare.objects.set(`${tag}/${name}`, bytes);
  }
  const calls = [], state = {failManifest: false, tamperGithub: false};
  const run = async (program, args, options) => {
    calls.push({program, args});
    if (program === 'aws') return cloudflare.run(program, args, options);
    if (program === 'bash') {
      if (args[0] === 'scripts/release/publish.sh') {fs.cpSync(prepared, args[3], {recursive: true}); return '';}
      if (args[0] === 'scripts/installer/generate-install.sh') {fs.writeFileSync(args[1], installer); return '';}
      assert.equal(args[0], '-c'); return '';
    }
    if (program === 'gh') {
      if (args[0] === 'api') {
        if (args.at(-1).includes('/tags/')) return JSON.stringify({id: 1});
        const assets = [...github].map(([name, bytes]) => ({id: 1, name, size: bytes.length, state: 'uploaded',
          digest: `sha256:${state.tamperGithub && name.endsWith('.tar.zst') ? 'f'.repeat(64) : hash(bytes)}`}));
        return JSON.stringify([assets]);
      }
      assert.equal(args[1], 'upload');
      const file = args[3], name = path.basename(file);
      if (state.failManifest && name === `${tag}-manifest.json`) {state.failManifest = false; throw new Error('Manifest upload failed');}
      github.set(name, fs.readFileSync(file)); return '';
    }
    assert.equal(program, 'curl');
    const url = new URL(args.at(-1)), name = path.basename(url.pathname);
    assert.ok(!name.endsWith('.tar.zst'), 'Commit and staging must not download whole archives again');
    const bytes = url.hostname === 'github.com' ? github.get(name) : cloudflare.objects.get(`${tag}/${name}`);
    assert.ok(bytes, `Missing fixture download: ${url}`);
    fs.writeFileSync(args[args.indexOf('--output') + 1], bytes);
    if (args.includes('--dump-header')) fs.writeFileSync(args[args.indexOf('--dump-header') + 1], 'HTTP/2 200\n');
    return `200\n0 0 0 0 0 ${bytes.length} 2 127.0.0.1`;
  };
  const env = {GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'a'.repeat(40),
    CF_R2_AWS_S3_ENDPOINT: 'https://fixture.invalid'};
  const options = {run, env, retry: async (_label, work) => work()};
  return {version, tag, directory, evidence, github, cloudflare, calls, state, options, installer, oldInstaller, previousBytes, manifest};
}

test('staging uploads archives once without advertising them; commit changes only the installer and manifest', async t => {
  const f = fixture(t);
  const staged = await stage(f.version, 'builds', f.evidence, f.options);
  assert.deepEqual(f.github.get(`${f.tag}-manifest.json`), f.previousBytes);
  assert.deepEqual(f.cloudflare.objects.get(`${f.tag}/install.sh`), f.oldInstaller);
  assert.equal(f.cloudflare.calls.filter(c => c.operation === 'put-object' && c.key.endsWith('.tar.zst')).length, 8);
  const receipt = validateReceipt(JSON.parse(f.github.get(staged.name)), f.version);
  assert.equal(selectVariant(receipt, {arch: 'arm64', build: 'debug', ts: 'zts'}).name,
    'php_8.5-zts-debug+darwin_arm64.tar.zst');
  const before = f.calls.length;
  await commit(f.version, staged.name, staged.sha256, f.options);
  for (const origin of [f.github, new Map([...f.cloudflare.objects].map(([key, value]) => [path.basename(key), value]))]) {
    assert.deepEqual(JSON.parse(origin.get(`${f.tag}-manifest.json`)), f.manifest);
    assert.deepEqual(origin.get('install.sh'), f.installer);
  }
  const writes = f.calls.slice(before).filter(c => c.program === 'gh' && c.args[1] === 'upload');
  assert.deepEqual(writes.map(c => path.basename(c.args[3])), ['install.sh', `${f.tag}-manifest.json`]);
  assert.equal(f.cloudflare.calls.filter(c => c.operation === 'put-object' && c.key.endsWith('.tar.zst')).length, 8);
});

test('source release drift and damaged staged archives cannot change public installers', async t => {
  for (const issue of ['manifest', 'github', 'r2', 'receipt']) {
    const f = fixture(t), staged = await stage(f.version, 'builds', f.evidence, f.options);
    if (issue === 'manifest') {
      const changed = Buffer.from(JSON.stringify({...JSON.parse(f.previousBytes), php_semver: '8.5.99'}));
      f.github.set(`${f.tag}-manifest.json`, changed); f.cloudflare.objects.set(`${f.tag}/${f.tag}-manifest.json`, changed);
    } else if (issue === 'github') f.state.tamperGithub = true;
    else if (issue === 'r2') f.cloudflare.objects.set(`${f.tag}/${f.manifest.assets[0].download}`, Buffer.from('damaged'));
    else f.github.set(staged.name, Buffer.from('{}'));
    const writes = f.cloudflare.calls.filter(c => c.operation === 'put-object').length;
    await assert.rejects(commit(f.version, staged.name, staged.sha256, f.options));
    assert.equal(f.cloudflare.calls.filter(c => c.operation === 'put-object').length, writes);
    assert.deepEqual(f.github.get('install.sh'), f.oldInstaller);
  }
});

test('a partial manifest commit restores both origins and keeps immutable archives', async t => {
  const f = fixture(t), staged = await stage(f.version, 'builds', f.evidence, f.options);
  f.state.failManifest = true;
  await assert.rejects(commit(f.version, staged.name, staged.sha256, f.options), /Manifest upload failed/);
  assert.deepEqual(f.github.get(`${f.tag}-manifest.json`), f.previousBytes);
  assert.deepEqual(f.github.get('install.sh'), f.oldInstaller);
  assert.deepEqual(f.cloudflare.objects.get(`${f.tag}/${f.tag}-manifest.json`), f.previousBytes);
  assert.deepEqual(f.cloudflare.objects.get(`${f.tag}/install.sh`), f.oldInstaller);
  assert.ok(f.github.has(f.manifest.assets[0].download));
});

test('a receipt cannot add arbitrary files or select an ambiguous/missing variant', async t => {
  const f = fixture(t), staged = await stage(f.version, 'builds', f.evidence, f.options);
  const receipt = JSON.parse(f.github.get(staged.name));
  assert.throws(() => selectVariant(receipt, {arch: 'arm64', build: 'debug release', ts: 'nts'}));
  receipt.files['../../install.sh'] = {};
  assert.throws(() => validateReceipt(receipt, f.version));
});

test('recovery requires successful checks for every omitted platform and unchanged packaged sources', async () => {
  const platforms = require('../../../conf/platforms.json');
  const jobs = [{id: 1, name: 'repackage (8.5) / repackage', conclusion: 'success'},
    ...Object.entries(platforms).flatMap(([arch, p]) => p.test_runners.map(runner =>
      ({id: `${arch}/${runner}`, name: `repackage (8.5) / test (${arch}, ${runner})`, conclusion: 'success'})))];
  let changed = '', source = {head_repository: {full_name: 'shivammathur/php-darwin'}, head_branch: 'main',
    path: '.github/workflows/mirror.yml', head_sha: 'a'.repeat(40), run_attempt: 1};
  const options = {retry: async (_label, work) => work(), run: async (program, args) => {
    if (program === 'git') return args[0] === 'diff' ? changed : '';
    assert.equal(program, 'gh');
    return JSON.stringify(args.at(-1).includes('/jobs?') ? [{jobs}] : source);
  }};
  jobs.at(-2).conclusion = 'failure'; // macos-15-intel must be retested
  const result = await recovery('8.5', '42', 'macos-15-intel', options);
  assert.equal(result.reused.length, 3);
  await assert.rejects(recovery('8.5', '42', 'macos-26-intel', options), /Untested recovered platform/);
  changed = 'scripts/installer/install.sh';
  await assert.rejects(recovery('8.5', '42', 'macos-15-intel', options), /current installer/);
  changed = ''; source.head_branch = 'unreviewed';
  await assert.rejects(recovery('8.5', '42', 'macos-15-intel', options));
});

test('retention preserves both public generations and all Cloudflare history', async t => {
  const f = fixture(t), previous = JSON.parse(f.previousBytes);
  const older = previous.assets[0].download.replace(previous.assets[0].sha256, 'f'.repeat(64));
  const files = [...f.manifest.assets, ...previous.assets].flatMap(a => [a.download, a.download + '.sha256']);
  files.push(older, older + '.sha256', 'install.sh', 'unrelated.txt', 'repackage-42-1.json');
  const assets = new Map(files.map((name, id) => [name, {name, id}]));
  const removed = [];
  await prune(assets, f.manifest, previous, 'repackage-42-1.json', {retry: f.options.retry,
    run: async (program, args) => {assert.equal(program, 'gh'); assert.equal(args[2], 'DELETE'); removed.push(Number(args.at(-1).split('/').at(-1)));}});
  assert.deepEqual(removed, [assets.get(older).id, assets.get(older + '.sha256').id]);
  await prune(assets, f.manifest, f.manifest, 'repackage-42-1.json', {retry: f.options.retry,
    run: async () => {assert.fail('An unchanged archive generation must retain its earlier GitHub fallback');}});
});
