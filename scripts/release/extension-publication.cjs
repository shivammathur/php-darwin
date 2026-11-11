const fs = require('node:fs');
const path = require('node:path');
const {digest, key, validateEntry} = require('../installer/install-extensions.cjs');
const {publish, publicationEntries} = require('./extension-packs.cjs');
const {githubJSON, command, retryPolicy} = require('./extension-transfers.cjs');
const {verifySelection} = require('./extension-recovery.cjs');
const {r2} = require('../lib/r2.cjs');

const repository = 'shivammathur/php-darwin';
const shardId = entry => [entry.php_version, entry.architecture, entry.build, entry.thread_safety].join('-');
const signature = entry => ({key: key(entry), metadata_sha256: digest(JSON.stringify(entry))});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function validatePlan(plan) {
  if (plan?.schema !== 1 || plan.repository !== repository || !/^[1-9][0-9]*$/.test(plan.source_run) ||
      !/^[1-9][0-9]*$/.test(plan.publication_run) || !Array.isArray(plan.entries) || !Array.isArray(plan.shards) ||
      typeof plan.fast !== 'boolean' || plan.shards.length > 256) throw new Error('Invalid extension publication plan');
  const expected = new Map();
  for (const entry of plan.entries) {
    validateEntry(entry);
    if (!expected.has(shardId(entry))) expected.set(shardId(entry), []);
    expected.get(shardId(entry)).push(key(entry));
  }
  if (new Set(plan.entries.map(key)).size !== plan.entries.length || expected.size !== plan.shards.length ||
      new Set(plan.shards.map(shard => shard.id)).size !== plan.shards.length) throw new Error('Duplicate publication selection');
  for (const shard of plan.shards) {
    if (!Array.isArray(shard.keys) || !same(shard.keys, expected.get(shard.id)) ||
        typeof shard.artifact_ids !== 'string' || !/^[1-9][0-9]*(,[1-9][0-9]*)*$/.test(shard.artifact_ids) ||
        new Set(shard.artifact_ids.split(',')).size !== shard.artifact_ids.split(',').length) {
      throw new Error('Invalid extension publication shard');
    }
  }
  return plan;
}

function loadPlan(file) {
  const bytes = fs.readFileSync(file);
  const id = digest(bytes), plan = validatePlan(JSON.parse(bytes));
  if (process.env.PUBLICATION_PLAN_ID !== id || process.env.GITHUB_RUN_ID !== plan.publication_run ||
      plan.fast !== (process.env.PHP_DARWIN_FAST_REFRESH === 'true')) {
    throw new Error('Publication plan belongs to a different run or selection');
  }
  return {plan, id};
}

function uploadReceipt(plan, id, shard, records) {
  return {schema: 1, plan_sha256: id, shard: shard.id,
    entries: plan.entries.filter(entry => shard.keys.includes(key(entry))).map(entry => ({...signature(entry),
      cloudflare_etag: records.find(record => key(record.entry) === key(entry)).delivery.etag}))};
}

function verifyReceipts(plan, id, directory) {
  const files = fs.readdirSync(directory).filter(file => file.endsWith('.json'));
  const expected = new Map(plan.shards.map(shard => [shard.id, shard]));
  const receipts = new Map();
  if (files.length !== expected.size) throw new Error('Missing extension upload receipts');
  for (const file of files) {
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, file)));
    const shard = expected.get(receipt.shard);
    if (receipt.schema !== 1 || receipt.plan_sha256 !== id || !shard || !Array.isArray(receipt.entries) ||
        !same(receipt.entries.map(({key, metadata_sha256}) => ({key, metadata_sha256})),
          plan.entries.filter(entry => shard.keys.includes(key(entry))).map(signature)) ||
        receipt.entries.some(entry => !/^"[a-f0-9]{32}(?:-\d+)?"$/.test(entry.cloudflare_etag || ''))) {
      throw new Error('Extension upload receipt does not match the publication plan');
    }
    for (const entry of receipt.entries) receipts.set(entry.key, entry);
    expected.delete(receipt.shard);
  }
  if (expected.size) throw new Error('Incomplete extension upload receipts');
  return receipts;
}

async function verifyRemoteEntries(plan, receipts, {run = command, retry = retryPolicy()} = {}) {
  const inventories = new Map();
  for (const release of new Set(plan.entries.map(entry => entry.release || 'extensions'))) {
    const record = await githubJSON(`repos/${repository}/releases/tags/${release}`, {run, retry});
    const assets = (await githubJSON(`repos/${repository}/releases/${record.id}/assets?per_page=100`,
      {run, retry, paginate: true})).flat();
    inventories.set(release, new Map(assets.map(asset => [asset.name, asset])));
  }
  const store = r2({endpoint: process.env.CF_R2_AWS_S3_ENDPOINT, env: process.env, run, retry});
  const pending = [...plan.entries];
  // Receipts can survive a failed attempt after the publication lock was
  // released. Check immutable object identities again in case retention ran
  // in between; do not redownload successfully delivered archives.
  const workers = Array.from({length: Math.min(8, pending.length)}, async () => {
    while (pending.length) {
      const entry = pending.shift(), release = entry.release || 'extensions';
      const asset = inventories.get(release).get(entry.file);
      if (!asset || asset.size !== entry.bytes || (asset.digest && asset.digest !== `sha256:${entry.sha256}`)) {
        throw new Error(`Uploaded GitHub archive is missing or changed: ${key(entry)}; restore uploads before committing`);
      }
      await retry(`Confirm uploaded ${key(entry)}`, async () => {
        const object = await store.head(`${release}/${entry.file}`);
        if (!object || object.ContentLength !== entry.bytes || object.ETag !== receipts.get(key(entry)).cloudflare_etag ||
            (object.Metadata?.sha256 && object.Metadata.sha256 !== entry.sha256)) {
          throw new Error(`Uploaded Cloudflare archive is missing or changed: ${key(entry)}; restore uploads before committing`);
        }
      });
    }
  });
  const results = await Promise.allSettled(workers);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
}

async function prepare(directory, output) {
  const sourceRun = process.env.SOURCE_RUN || process.env.GITHUB_RUN_ID;
  if (!/^[1-9][0-9]*$/.test(sourceRun || '')) throw new Error('Invalid publication source run');
  const keys = JSON.parse(process.env.EXTENSION_RECOVERY_KEYS);
  if (!Array.isArray(keys)) throw new Error('Missing exact publication selection');
  if (keys.length) verifySelection(directory, keys);
  else if (publicationEntries(directory).length) throw new Error('Unexpected archives in installer-only publication');
  const artifacts = keys.length ? (await githubJSON(`repos/${repository}/actions/runs/${sourceRun}/artifacts?per_page=100`,
    {paginate: true})).flatMap(page => page.artifacts).filter(artifact => !artifact.expired) : [];
  const records = await publish(directory, {stage: 'prepare'});
  const groups = new Map();
  for (const {entry, metadata} of records) {
    // The prepare download keeps the original artifact directories. Upload
    // workers fetch their exact immutable IDs rather than the entire matrix.
    const artifactName = path.relative(directory, metadata).split(path.sep)[0];
    const matches = artifacts.filter(artifact => artifact.name === artifactName);
    if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id) || matches[0].id < 1) {
      throw new Error(`Missing or ambiguous source artifact: ${artifactName}`);
    }
    const id = shardId(entry);
    if (!groups.has(id)) groups.set(id, {id, keys: [], artifacts: new Set()});
    groups.get(id).keys.push(key(entry));
    groups.get(id).artifacts.add(matches[0].id);
  }
  const plan = validatePlan({schema: 1, repository, source_run: sourceRun, publication_run: process.env.GITHUB_RUN_ID,
    fast: process.env.PHP_DARWIN_FAST_REFRESH === 'true',
    entries: records.map(record => record.entry), shards: [...groups.values()].map(group => ({
      id: group.id, keys: group.keys, artifact_ids: [...group.artifacts].sort((a, b) => a - b).join(','),
    }))});
  fs.writeFileSync(output, JSON.stringify(plan, null, 2) + '\n');
  const id = digest(fs.readFileSync(output));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,
    `plan-id=${id}\ncount=${plan.shards.length}\nsource-run=${sourceRun}\n` +
    `matrix=${JSON.stringify({include: plan.shards.map(({id, artifact_ids}) => ({id, artifact_ids}))})}\n`);
  console.log(`Prepared ${plan.entries.length} archives across ${plan.shards.length} parallel publication jobs`);
}

async function upload(directory, planFile, selectedShard, receiptFile) {
  const {plan, id} = loadPlan(planFile), shard = plan.shards.find(item => item.id === selectedShard);
  if (!shard) throw new Error('Unknown extension upload shard');
  const records = await publish(directory, {stage: 'upload', selectedKeys: shard.keys,
    expectedEntries: plan.entries.filter(entry => shard.keys.includes(key(entry)))});
  const receipt = uploadReceipt(plan, id, shard, records);
  // Only an entirely successful shard emits a receipt. Failed reruns reuse
  // immutable remote objects through the existing transfer reconciliation.
  fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
}

async function commit(planFile, receiptsDirectory) {
  const {plan, id} = loadPlan(planFile);
  const receipts = verifyReceipts(plan, id, receiptsDirectory);
  await verifyRemoteEntries(plan, receipts);
  // Archive hashes and delivery were checked by the upload jobs. Finalization
  // needs only their bound metadata; it never downloads the archive set again.
  await publish(undefined, {stage: 'commit', metadataEntries: plan.entries});
}

module.exports = {shardId, signature, validatePlan, uploadReceipt, verifyReceipts, verifyRemoteEntries, prepare, upload, commit};
if (require.main === module) (async () => {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'prepare') await prepare(...args);
  else if (mode === 'upload') await upload(...args);
  else if (mode === 'commit') await commit(...args);
  else throw new Error('Usage: extension-publication.cjs prepare|upload|commit');
})().catch(error => { console.error(error); process.exitCode = 1; });
