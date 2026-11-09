// Stage immutable release files once; advertise them only after native tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {command, retryPolicy, githubJSON, workflowJobs, transfers, publicReader} = require('./extension-transfers.cjs');
const {r2, fingerprint} = require('../lib/r2.cjs');
const config = require('../../conf/package.json');
const {versions} = require('../../conf/extension-packs.json');
const root = path.resolve(__dirname, '../..');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hex = /^[a-f0-9]{64}$/;
const receiptPattern = /^repackage-[0-9]+-[0-9]+\.json$/;

function identity(version, name) {
  if (!versions.includes(version) || !receiptPattern.test(name)) throw new Error('Invalid staged release identity');
  const tag = `php-${version}`;
  return {tag, bases: [`https://github.com/${config.release_repository}/releases/download/${tag}`,
    `${config.artifact_mirror}/${tag}`]};
}
function validateReceipt(receipt, version) {
  assert.equal(receipt.schema, 1);
  assert.equal(receipt.manifest.php_version, version);
  assert.ok(hex.test(receipt.previous_manifest_sha256));
  assert.ok(hex.test(receipt.installer_sha256));
  assert.match(receipt.commit, /^[a-f0-9]{40}$/);
  assert.equal(receipt.manifest.assets.length, 8);
  assert.equal(new Set(receipt.manifest.assets.map(a => a.name)).size, 8);
  assert.deepEqual(Object.keys(receipt.files).sort(), receipt.manifest.assets.flatMap(a => [a.download, a.download + '.sha256']).sort());
  for (const a of receipt.manifest.assets) {
    assert.ok(['arm64', 'x86_64'].includes(a.architecture));
    assert.ok(['release', 'debug'].includes(a.build));
    assert.ok(['nts', 'zts'].includes(a.thread_safety));
    assert.equal(a.name, `php_${version}-${a.thread_safety}-${a.build}+darwin_${a.architecture}.tar.zst`);
    assert.ok(hex.test(a.sha256));
    assert.equal(a.download, a.name.replace('.tar.zst', `.${a.sha256}.tar.zst`));
    assert.ok(Number.isSafeInteger(a.bytes) && a.bytes > 0 && a.bytes <= require('../../conf/build.json').max_archive_bytes[version]);
    const actual = receipt.files[a.download];
    assert.equal(actual.sha256, a.sha256);
    assert.equal(actual.bytes, a.bytes);
    assert.match(actual.md5, /^[a-f0-9]{32}$/);
    if (actual.r2_etag !== undefined) assert.match(actual.r2_etag, /^"[a-f0-9]{32}(?:-\d+)?"$/);
    const checksum = `${a.sha256}  ${a.download}\n`;
    const sidecar = receipt.files[a.download + '.sha256'];
    assert.equal(sidecar.sha256, digest(checksum));
    assert.equal(sidecar.bytes, Buffer.byteLength(checksum));
    assert.equal(sidecar.md5, crypto.createHash('md5').update(checksum).digest('hex'));
    const proof = receipt.proofs[a.name];
    assert.equal(proof.archive, a.name);
    assert.equal(proof.sha256, a.sha256);
    assert.equal(proof.php_rebuilt, false);
    assert.ok(proof.payload_members_unchanged > 100);
  }
  return receipt;
}
async function recovery(version, sourceRun, runners, {run = command, retry = retryPolicy()} = {}) {
  assert.match(sourceRun, /^[0-9]+$/);
  const route = `repos/${config.release_repository}/actions/runs/${sourceRun}`;
  const source = await githubJSON(route, {run, retry});
  assert.equal(source.head_repository.full_name, config.release_repository);
  assert.equal(source.head_branch, 'main');
  assert.equal(source.path, '.github/workflows/mirror.yml');
  assert.match(source.head_sha, /^[a-f0-9]{40}$/);
  await run('git', ['fetch', '--no-tags', '--depth=1', 'origin', source.head_sha], {cwd: root});
  const changed = await run('git', ['diff', '--name-only', source.head_sha, 'HEAD', '--',
    'scripts/installer', 'scripts/lib', 'conf', 'templates'], {cwd: root});
  assert.equal(changed.trim(), '', 'Recovered archives must contain the current installer and configuration');
  const jobs = await workflowJobs(route, source.run_attempt, {run, retry});
  assert.equal(jobs.find(job => job.name === `repackage (${version}) / repackage`)?.conclusion, 'success');
  const selected = runners ? runners.split(' ') : [];
  const reused = [];
  for (const [arch, platform] of Object.entries(require('../../conf/platforms.json'))) {
    for (const runner of platform.test_runners) {
      if (!selected.length || selected.includes(runner)) continue;
      const job = jobs.find(job => job.name === `repackage (${version}) / test (${arch}, ${runner})`);
      assert.equal(job?.conclusion, 'success', `Untested recovered platform: ${arch}/${runner}`);
      reused.push({id: job.id, name: job.name, conclusion: job.conclusion});
    }
  }
  return {run: sourceRun, commit: source.head_sha, reused};
}
function selectVariant(receipt, {arch, build, ts}) {
  const entries = receipt.manifest.assets.filter(a => a.architecture === arch && a.build === build && a.thread_safety === ts);
  assert.equal(entries.length, 1, 'Exactly one PHP variant must be selected');
  return entries[0];
}
async function downloadSmall(url, output, run = command) {
  await run('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '2', '--max-time', '60',
    '--max-filesize', '2097152', '--output', output, url]);
}
async function getReceipt(version, name, sha256, directory, {run = command} = {}) {
  const {bases} = identity(version, name);
  assert.ok(hex.test(sha256), 'Missing staged receipt digest');
  fs.mkdirSync(directory, {recursive: true});
  const file = path.join(directory, name);
  await downloadSmall(`${bases[0]}/${name}`, file, run);
  assert.equal(digest(fs.readFileSync(file)), sha256, 'Staged receipt checksum mismatch');
  const receipt = validateReceipt(read(file), version);
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(receipt.manifest, null, 2) + '\n');
  await run('bash', ['-c', '. scripts/lib/lib.sh; php_darwin_validate_release_manifest "$1" "$2"',
    'validate-staged', path.join(directory, 'manifest.json'), version], {cwd: root});
  return receipt;
}
async function stage(version, builds, evidence, {run = command, env = process.env, retry = retryPolicy()} = {}) {
  const name = `repackage-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}.json`;
  const {tag} = identity(version, name);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'php-release-stage-'));
  try {
    const recovered = env.SOURCE_RUN_ID ? await recovery(version, env.SOURCE_RUN_ID, env.TEST_RUNNERS, {run, retry}) : undefined;
    assert.ok(recovered || !env.TEST_RUNNERS, 'A fresh repackage must test every configured platform');
    const prepared = path.join(directory, 'prepared');
    await run('bash', ['scripts/release/publish.sh', path.resolve(builds), 'prepare', prepared], {cwd: root, env});
    const manifest = read(path.join(prepared, `${tag}-manifest.json`));
    const original = fs.readFileSync(path.join(evidence, `${tag}-manifest.json`));
    const receipt = {schema: 1, commit: env.GITHUB_SHA, manifest,
      previous_manifest_sha256: digest(original), installer_sha256: digest(fs.readFileSync(path.join(prepared, 'install.sh'))),
      files: {}, proofs: {}, ...(recovered ? {recovered} : {})};
    const previous = JSON.parse(original);
    assert.deepEqual(Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'assets')),
      Object.fromEntries(Object.entries(previous).filter(([key]) => key !== 'assets')),
      'Repackaging must preserve PHP release provenance');
    const store = r2({endpoint: env.CF_R2_AWS_S3_ENDPOINT, env, run, retry});
    const transfer = transfers({directory, endpoint: env.CF_R2_AWS_S3_ENDPOINT, env, run, retry});
    for (const asset of manifest.assets) {
      receipt.proofs[asset.name] = read(path.join(evidence, asset.name + '.json'));
      assert.equal(receipt.proofs[asset.name].input_sha256, previous.assets.find(a => a.name === asset.name)?.sha256);
      for (const filename of [asset.download, asset.download + '.sha256']) {
        const file = path.join(prepared, filename);
        receipt.files[filename] = await fingerprint(file);
      }
    }
    validateReceipt(receipt, version);
    const {bases} = identity(version, name);
    for (const base of bases) {
      const file = path.join(directory, 'current-manifest.json');
      await downloadSmall(`${base}/${tag}-manifest.json?stage=${Date.now()}`, file, run);
      assert.equal(digest(fs.readFileSync(file)), receipt.previous_manifest_sha256,
        'Published PHP changed before staging');
    }
    // No mutable installer or manifest is written here. The workflow holds the
    // per-version publishing lock until these files have passed every test.
    for (const filename of Object.keys(receipt.files)) {
      const file = path.join(prepared, filename);
      await transfer.github(file, true, tag);
      await store.ensure(file, `${tag}/${filename}`, {immutable: true});
      // ensure authenticated existing multipart objects too. Pin that verified
      // object so activation needs only HEAD, never another archive download.
      receipt.files[filename].r2_etag = (await retry(`Pin staged R2 ${filename}`, () => store.head(`${tag}/${filename}`))).ETag;
    }
    const file = path.join(directory, name);
    fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n');
    await transfer.github(file, true, tag);
    await store.ensure(file, `${tag}/${name}`, {immutable: true, contentType: 'application/json'});
    const sha256 = digest(fs.readFileSync(file));
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `receipt=${name}\nreceipt-sha256=${sha256}\n`);
    console.log(`Staged ${manifest.assets.length} PHP archives; existing installers and manifests are unchanged`);
    return {name, sha256};
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
}
async function verifyRemote(receipt, tag, {run, retry, store}) {
  const release = await githubJSON(`repos/${config.release_repository}/releases/tags/${tag}`, {run, retry});
  const pages = await githubJSON(`repos/${config.release_repository}/releases/${release.id}/assets?per_page=100`, {run, retry, paginate: true});
  const assets = new Map(pages.flat().map(a => [a.name, a]));
  for (const [name, expected] of Object.entries(receipt.files)) {
    const asset = assets.get(name);
    assert.equal(asset?.state, 'uploaded', `Missing staged GitHub asset: ${name}`);
    assert.equal(asset.size, expected.bytes);
    assert.equal(asset.digest, `sha256:${expected.sha256}`);
    const object = await retry(`Verify staged R2 ${name}`, () => store.head(`${tag}/${name}`));
    assert.equal(object?.ContentLength, expected.bytes, `Missing staged R2 asset: ${name}`);
    assert.equal(object.ETag, expected.r2_etag || `"${expected.md5}"`);
    if (object.Metadata?.sha256) assert.equal(object.Metadata.sha256, expected.sha256);
  }
  return assets;
}
async function prune(assets, current, previous, receiptName, {run, retry}) {
  const retained = new Set([current, previous].flatMap(manifest => manifest.assets.flatMap(a => [a.download, a.download + '.sha256'])));
  const archives = /^php_[0-9]+\.[0-9]+-(nts|zts)-(debug|release)\+darwin_(arm64|x86_64)\.[a-f0-9]{64}\.tar\.zst(\.sha256)?$/;
  const receipts = [...assets.values()].filter(a => receiptPattern.test(a.name))
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  const keptReceipts = new Set([receiptName, ...receipts.slice(0, 10).map(a => a.name)]);
  for (const [name, asset] of assets) {
    if (!(archives.test(name) && !retained.has(name)) && !(receiptPattern.test(name) && !keptReceipts.has(name))) continue;
    // Retain every historical immutable Cloudflare URL for older installers.
    // GitHub keeps the current and immediately previous archive generations.
    await retry(`Retire GitHub asset ${name}`, () => run('gh', ['api', '--method', 'DELETE',
      `repos/${config.release_repository}/releases/assets/${asset.id}`]));
  }
}
async function commit(version, name, sha256, {run = command, env = process.env, retry = retryPolicy()} = {}) {
  const {tag, bases} = identity(version, name);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'php-release-commit-'));
  const store = r2({endpoint: env.CF_R2_AWS_S3_ENDPOINT, env, run, retry});
  const transfer = transfers({directory, endpoint: env.CF_R2_AWS_S3_ENDPOINT, env, run, retry});
  const verifyPublic = publicReader({directory, run});
  let changing = false;
  const backup = path.join(directory, 'previous');
  async function publish(file) {
    await store.ensure(file, `${tag}/${path.basename(file)}`, {immutable: false});
    await retry(`Verify published Cloudflare ${path.basename(file)}`, () => verifyPublic(file, bases[1]));
    await transfer.github(file, false, tag);
    await retry(`Verify published GitHub ${path.basename(file)}`, () => verifyPublic(file, bases[0]));
  }
  try {
    const receipt = await getReceipt(version, name, sha256, directory, {run});
    assert.equal(receipt.commit, env.GITHUB_SHA, 'Staged files were produced by a different source revision');
    const assets = await verifyRemote(receipt, tag, {run, retry, store});
    fs.mkdirSync(backup);
    for (const filename of ['install.sh', `${tag}-manifest.json`]) {
      const file = path.join(backup, filename);
      await downloadSmall(`${bases[0]}/${filename}?stage=${Date.now()}`, file, run);
      await retry(`Verify previous Cloudflare ${filename}`, () => verifyPublic(file, bases[1]));
    }
    assert.equal(digest(fs.readFileSync(path.join(backup, `${tag}-manifest.json`))), receipt.previous_manifest_sha256,
      'Published PHP changed while staged archives were being tested');
    const manifest = path.join(directory, `${tag}-manifest.json`);
    fs.copyFileSync(path.join(directory, 'manifest.json'), manifest);
    const installer = path.join(directory, 'install.sh');
    await run('bash', ['scripts/installer/generate-install.sh', installer],
      {cwd: root, env: {...env, PHP_DARWIN_RELEASE_MANIFEST: manifest}});
    assert.equal(digest(fs.readFileSync(installer)), receipt.installer_sha256, 'Generated installer changed after staging');
    changing = true;
    await publish(installer);
    await publish(manifest);
    changing = false;
    try {await prune(assets, receipt.manifest, read(path.join(backup, `${tag}-manifest.json`)), name, {run, retry});}
    catch (error) {console.warn(`Published release is valid; retention cleanup will be retried on the next publication: ${error.message}`);}
    console.log(`Published tested PHP ${version}; no archive downloads or uploads in the commit job`);
  } catch (error) {
    if (changing) {
      for (const filename of ['install.sh', `${tag}-manifest.json`]) {
        try {await publish(path.join(backup, filename));}
        catch (restore) {console.error(`Could not restore ${filename}: ${restore.message}`);}
      }
    }
    throw error;
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
}
module.exports = {validateReceipt, selectVariant, recovery, stage, getReceipt, verifyRemote, prune, commit};
if (require.main === module) (async () => {
  const [mode, version, ...args] = process.argv.slice(2);
  if (mode === 'stage') await stage(version, ...args);
  else if (mode === 'commit') await commit(version, ...args);
  else if (mode === 'receipt') await getReceipt(version, ...args);
  else throw new Error('Invalid staged release operation');
})().catch(error => {console.error(error); process.exitCode = 1;});
