// Build-time source bottles only. Runtime PHP installs keep their own origin policy.
const fs = require('node:fs');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { transfer, validFile, publish, readRecords } = require('./upstream-bottle-cache.cjs');
const { command } = require('./source-bottle-cache.cjs');
const { curlRequest } = require('../lib/release-http.cjs');
const repository = 'shivammathur/php-darwin';
const tag = 'cache';
const { productionRelease, legacyRelease, releaseForFormula } = require('./source-cache-layout.cjs');
const { jobMatrix, recordsFor } = require('./bottle-jobs.cjs');

function record(asset, repo = repository, release = tag) {
  if (repo !== repository || !(productionRelease(release) || legacyRelease(release))) return;
  const identity = require('./source-bottle-releases.cjs').assetIdentity(asset);
  if (!identity || !/^sha256:[0-9a-f]{64}$/.test(asset.digest || '') ||
      asset.state === 'starter' || !Number.isSafeInteger(asset.size) || asset.size <= 0) return;
  const stem = asset.name.split(`-${identity.version}.macos-`);
  if (stem.length !== 2 || !/^[A-Za-z0-9@+_.-]+$/.test(stem[0])) return;
  if (release !== tag && !legacyRelease(release) && release !== releaseForFormula(stem[0])) return;
  return portable({ formula: stem[0], version: identity.version, tag: 'source',
    name: asset.name, source_key: identity.key, bytes: asset.size,
    sha256: asset.digest.slice(7),
    url: `https://github.com/${repository}/releases/download/${release}/${encodeURIComponent(asset.name)}` });
}

function portable(value) {
  const release = typeof value?.url === 'string' ? value.url.split('/')[7] : '';
  if (!value || !/^[A-Za-z0-9@+_.-]+$/.test(value.formula || '') ||
      !/^[A-Za-z0-9+_.-]+$/.test(value.version || '') || value.tag !== 'source' ||
      !/^[0-9a-f]{64}$/.test(value.sha256 || '') ||
      !Number.isSafeInteger(value.bytes) || value.bytes <= 0 ||
      !/^[A-Za-z0-9@+_.-]+\.tar$/.test(value.name || '') ||
      !/^php-darwin-source-v1-[0-9a-f]{64}$/.test(value.source_key || '') ||
      !value.name.startsWith(`${value.formula}-${value.version}.macos-`) ||
      !(release === tag || legacyRelease(release) || release === releaseForFormula(value.formula)) ||
      value.url !== `https://github.com/${repository}/releases/download/${release}/${encodeURIComponent(value.name)}` ||
      require('./source-bottle-releases.cjs').assetIdentity(value)?.key !== value.source_key ||
      require('./source-bottle-releases.cjs').assetIdentity(value)?.version !== value.version) {
    throw new Error('Invalid mirrored source bottle identity');
  }
  const { formula, version, tag: kind, name, source_key, bytes, sha256, url } = value;
  return { formula, version, tag: kind, name, source_key, bytes, sha256, url };
}

function key(value) { return `homebrew/source-bottles/sha256/${portable(value).sha256}.tar`; }
function publicURL(value) { return `https://artifacts.php-darwin.setup-php.com/${key(value)}`; }
function queue(value, file = process.env.PHP_DARWIN_SOURCE_BOTTLE_MISSES) {
  if (file) fs.appendFileSync(file, JSON.stringify(portable(value)) + '\n');
}
function matrix(records, formula = '') {
  if (formula && !/^[A-Za-z0-9@+_.-]+$/.test(formula)) throw new Error('Invalid source dependency name');
  const groups = new Map();
  for (const input of records) {
    const value = portable(input);
    if (formula && value.formula !== formula) continue;
    if (!groups.has(value.formula)) groups.set(value.formula, new Map());
    groups.get(value.formula).set(value.sha256, value);
  }
  if (formula && !groups.size) throw new Error(`No cached source bottles for ${formula}`);
  return { include: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([formula, values]) => ({
    formula, bottles: [...values.values()],
  })) };
}
function sourceDownload(records, { run = command, request = curlRequest, download = transfer, env = process.env } = {}) {
  const sources = new Map(records.map(input => { const value = portable(input); return [value.url, value]; }));
  const releases = new Map();
  return async (url, file, options) => {
    const value = sources.get(url);
    if (!value) return download(url, file, options);
    // Public release links can fail while the authenticated asset API works.
    // Resolve the exact immutable asset, retaining the publisher's shared retry
    // budget and checksum gate. Do not authenticate public mirror requests.
    const release = value.url.split('/')[7];
    if (!releases.has(release)) {
      const { id } = JSON.parse(run('gh', ['api', `repos/${repository}/releases/tags/${release}`]));
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid source bottle release ID');
      const pages = JSON.parse(run('gh', ['api', '--paginate', '--slurp',
        `repos/${repository}/releases/${id}/assets?per_page=100`]));
      releases.set(release, pages.flat());
    }
    const matches = releases.get(release).filter(asset => asset.name === value.name);
    const asset = matches[0];
    if (matches.length !== 1 || !Number.isSafeInteger(asset.id) || asset.id <= 0 ||
        asset.state !== 'uploaded' || asset.size !== value.bytes || asset.digest !== `sha256:${value.sha256}`) {
      throw new Error(`Source bottle asset identity changed: ${value.formula}`);
    }
    const token = env.GH_TOKEN || env.GITHUB_TOKEN;
    if (!token) throw new Error('Missing GitHub token for source bottle publication');
    const response = await request(`https://api.github.com/repos/${repository}/releases/assets/${asset.id}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/octet-stream', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(180000),
    });
    try {
      if (response.status === 200) await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(file));
      return response.status;
    } finally { if (response.body && !response.bodyUsed) await response.body.cancel(); }
  };
}
async function main() {
  if (process.argv[2] === 'matrix') {
    let records;
    if (process.env.SEED === 'true') {
      const releases = JSON.parse(command('gh', ['api', '--paginate', '--slurp',
        `repos/${repository}/releases?per_page=100`])).flat().filter(item => productionRelease(item.tag_name));
      records = releases.flatMap(release => {
        const pages = JSON.parse(command('gh', ['api', '--paginate', '--slurp',
          `repos/${repository}/releases/${release.id}/assets?per_page=100`]));
        return pages.flat().map(asset => record(asset, repository, release.tag_name)).filter(Boolean);
      });
    } else records = readRecords(process.argv[3]);
    const result = matrix(records, process.env.FORMULA || '');
    fs.writeFileSync('source-bottle-matrix.json', JSON.stringify(result, null, 2));
    const jobs = jobMatrix(result);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(jobs)}\ncount=${jobs.include.length}\n`);
    console.log(`${result.include.length} source dependencies in ${jobs.include.length} jobs; ${result.include.reduce((n, item) => n + item.bottles.length, 0)} exact bottles`);
  } else if (process.argv[2] === 'publish') {
    const bottles = process.argv[3] ? recordsFor(JSON.parse(fs.readFileSync(process.argv[3])), process.argv[4]) : JSON.parse(process.env.BOTTLES);
    const results = await publish(bottles, {
      identity: portable, objectKey: key, contentType: 'application/x-tar', upstream: false,
      download: sourceDownload(bottles),
    });
    fs.writeFileSync('source-bottle-verification.json', JSON.stringify(results, null, 2));
  } else throw new Error('Expected matrix or publish');
}
module.exports = { record, portable, key, publicURL, queue, matrix, transfer, validFile, sourceDownload };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
