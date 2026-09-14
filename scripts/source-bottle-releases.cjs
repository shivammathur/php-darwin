const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawnSync } = require('node:child_process');
const { command, readBottle } = require('./source-bottle-cache.cjs');

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function family(inputs) {
  return sha256(JSON.stringify({
    formula: inputs.formula, arch: inputs.environment.arch, macos: inputs.environment.macos,
    prefix: inputs.environment.prefix, build: inputs.context?.build, ts: inputs.context?.ts,
  }));
}

function releaseAsset(metadata) {
  const { inputs, key } = metadata;
  const hash = key.match(/^php-darwin-source-v1-([0-9a-f]{64})$/)?.[1];
  const variant = inputs.context ? `.${inputs.context.build}-${inputs.context.ts}` : '';
  const stem = `${inputs.formula.split('/').at(-1)}--${inputs.version}` +
    `.macos-${inputs.environment.macos}.${inputs.environment.arch}${variant}`;
  if (!hash || !/^[A-Za-z0-9@+_.-]+$/.test(stem)) throw new Error('Invalid source bottle asset name');
  // Keep the full input key and cleanup family in the filename. GitHub displays
  // the shorter, readable label; neither hash needs to be recovered from it.
  return { name: `${stem}.source-v1-${family(inputs)}.${hash}.tar`, label: `${stem}.${hash.slice(0, 12)}.tar` };
}

function assetIdentity(asset) {
  const match = asset.name.match(/^[A-Za-z0-9@+_.-]+--([A-Za-z0-9+_.-]+)\.macos-[0-9]+\.[A-Za-z0-9_.-]+\.source-v1-([0-9a-f]{64})\.([0-9a-f]{64})\.tar$/);
  if (match) return { version: match[1], group: match[2], key: `php-darwin-source-v1-${match[3]}` };
  // Read caches created before readable filenames were introduced.
  if (/^php-darwin-source-v1-[0-9a-f]{64}\.tar$/.test(asset.name)) {
    const label = asset.label?.match(/^source-v1:([0-9a-f]{64}):(.+)$/);
    return { key: asset.name.slice(0, -4), group: label?.[1], version: label?.[2] };
  }
}

function olderVersions(versions) {
  return JSON.parse(command('brew', ['ruby', '--', path.join(__dirname, 'source-bottle-prune.rb'),
    JSON.stringify(versions)]));
}

function unpack(archive, directory, key) {
  const metadata = JSON.parse(command('tar', ['-xOf', archive, 'metadata.json']));
  if (metadata.key !== key || typeof metadata.file !== 'string' ||
    !/^[A-Za-z0-9@+_.-]+\.bottle(?:\.\d+)?\.tar\.gz$/.test(metadata.file)) {
    throw new Error('Invalid release bottle metadata');
  }
  fs.mkdirSync(directory, { recursive: true });
  // Extract only the two named files as byte streams. Archive paths and links
  // cannot write elsewhere on the runner.
  const output = fs.openSync(path.join(directory, metadata.file), 'w');
  try {
    const result = spawnSync('tar', ['-xOf', archive, metadata.file], { stdio: ['ignore', output, 'inherit'] });
    if (result.error || result.status !== 0) throw result.error || new Error('Could not extract source bottle');
  } finally { fs.closeSync(output); }
  fs.writeFileSync(path.join(directory, 'metadata.json'), JSON.stringify(metadata));
  readBottle(directory, key);
}

class ReleaseCache {
  constructor({ repository = process.env.GITHUB_REPOSITORY, token = process.env.GH_TOKEN,
    tag = 'cache', request = fetch, versionsToPrune = olderVersions } = {}) {
    if (!/^shivammathur\/[A-Za-z0-9_.-]+$/.test(repository || '') || !token) {
      throw new Error('Release source cache requires a shivammathur repository and GH_TOKEN');
    }
    this.repository = repository;
    this.token = token;
    this.tag = tag;
    this.request = request;
    this.versionsToPrune = versionsToPrune;
  }

  async api(endpoint, { method = 'GET', body, binary = false, allow = [] } = {}) {
    const response = await this.request(`https://api.github.com/repos/${this.repository}/${endpoint}`, {
      method, headers: { Authorization: `Bearer ${this.token}`,
        Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (allow.includes(response.status)) return null;
    if (!response.ok) throw new Error(`Release cache ${method} ${endpoint}: HTTP ${response.status}`);
    if (binary) return response;
    return response.status === 204 ? null : response.json();
  }

  async release(create = false) {
    let release = await this.api(`releases/tags/${encodeURIComponent(this.tag)}`, { allow: [404] });
    if (!release && create) {
      release = await this.api('releases', { method: 'POST', allow: [422], body: {
        tag_name: this.tag, target_commitish: 'main', name: this.tag,
        body: 'Homebrew source bottles and build-input metadata used by PHP cache builds.',
        prerelease: this.tag.startsWith('source-bottles-test-'), make_latest: 'false',
      } });
      release ||= await this.api(`releases/tags/${encodeURIComponent(this.tag)}`);
    }
    return release;
  }

  async assets(release) {
    const assets = [];
    for (let page = 1; ; page++) {
      const batch = await this.api(`releases/${release.id}/assets?per_page=100&page=${page}`);
      assets.push(...batch);
      if (batch.length < 100) return assets;
    }
  }

  async download(asset, directory, key) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'source-bottle-download-'));
    try {
      const archive = path.join(temporary, 'bundle.tar');
      const response = await this.api(`releases/assets/${asset.id}`, { binary: true });
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(archive));
      if (asset.digest && asset.digest !== `sha256:${sha256(fs.readFileSync(archive))}`) {
        throw new Error('Release source cache archive checksum mismatch');
      }
      unpack(archive, directory, key);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }

  async restoreCache([directory], key) {
    const release = await this.release();
    if (!release) return;
    const asset = (await this.assets(release)).find(asset => assetIdentity(asset)?.key === key);
    if (!asset) return;
    await this.download(asset, directory, key);
    return key;
  }

  async saveCache([directory], key) {
    readBottle(directory, key);
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'metadata.json')));
    const group = family(metadata.inputs);
    const { name, label } = releaseAsset(metadata);
    const release = await this.release(true);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'source-bottle-upload-'));
    try {
      const archive = path.join(temporary, `${key}.tar`);
      command('tar', ['-cf', archive, '-C', path.resolve(directory), 'metadata.json', metadata.file]);
      // GitHub creates the whole bundle atomically. A concurrent upload may
      // win this exact key; never clobber it or expose a partial pair of files.
      const response = await this.request(
        `https://uploads.github.com/repos/${this.repository}/releases/${release.id}/assets?` +
        new URLSearchParams({ name, label }), {
          method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/x-tar',
            'Content-Length': String(fs.statSync(archive).size) },
          body: fs.createReadStream(archive), duplex: 'half',
        });
      if (!response.ok && response.status !== 422) throw new Error(`Source bottle upload: HTTP ${response.status}`);
      const assets = await this.assets(release);
      const saved = assets.find(asset => asset.name === name);
      if (!saved) throw new Error('Uploaded source bottle is missing');
      // Read back the actual remote bytes before removing superseded versions.
      await this.download(saved, path.join(temporary, 'verified'), key);
      const related = assets.map(asset => ({ asset, identity: assetIdentity(asset) }))
        .filter(entry => entry.identity?.group === group);
      const obsolete = this.versionsToPrune(related.map(entry => entry.identity.version));
      if (obsolete.includes(metadata.inputs.version)) {
        // An older job can finish after a newer upload. Verify that replacement
        // too; its own uploader may have failed before completing read-back.
        const newer = related.find(entry => !obsolete.includes(entry.identity.version));
        await this.download(newer.asset, path.join(temporary, 'replacement'), newer.identity.key);
      }
      for (const { asset, identity } of related) {
        if (obsolete.includes(identity.version)) {
          await this.api(`releases/assets/${asset.id}`, { method: 'DELETE', allow: [404] });
        }
      }
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
}

module.exports = { ReleaseCache, family, releaseAsset, assetIdentity, unpack };
