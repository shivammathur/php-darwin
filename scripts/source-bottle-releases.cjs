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
        prerelease: true, make_latest: 'false',
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
    const asset = (await this.assets(release)).find(asset => asset.name === `${key}.tar`);
    if (!asset) return;
    await this.download(asset, directory, key);
    return key;
  }

  async saveCache([directory], key) {
    readBottle(directory, key);
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'metadata.json')));
    const group = family(metadata.inputs);
    const label = `source-v1:${group}:${metadata.inputs.version}`;
    const release = await this.release(true);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'source-bottle-upload-'));
    try {
      const archive = path.join(temporary, `${key}.tar`);
      command('tar', ['-cf', archive, '-C', path.resolve(directory), 'metadata.json', metadata.file]);
      // GitHub creates the whole bundle atomically. A concurrent upload may
      // win this exact key; never clobber it or expose a partial pair of files.
      const response = await this.request(
        `https://uploads.github.com/repos/${this.repository}/releases/${release.id}/assets?` +
        new URLSearchParams({ name: `${key}.tar`, label }), {
          method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/x-tar',
            'Content-Length': String(fs.statSync(archive).size) },
          body: fs.createReadStream(archive), duplex: 'half',
        });
      if (!response.ok && response.status !== 422) throw new Error(`Source bottle upload: HTTP ${response.status}`);
      const assets = await this.assets(release);
      const saved = assets.find(asset => asset.name === `${key}.tar`);
      if (!saved) throw new Error('Uploaded source bottle is missing');
      // Read back the actual remote bytes before removing superseded versions.
      await this.download(saved, path.join(temporary, 'verified'), key);
      const related = assets.filter(asset => asset.label?.startsWith(`source-v1:${group}:`));
      const obsolete = this.versionsToPrune(related.map(asset => asset.label.split(':').slice(2).join(':')));
      if (obsolete.includes(metadata.inputs.version)) {
        // An older job can finish after a newer upload. Verify that replacement
        // too; its own uploader may have failed before completing read-back.
        const newer = related.find(asset => !obsolete.includes(asset.label.split(':').slice(2).join(':')));
        if (!/^php-darwin-source-v1-[0-9a-f]{64}\.tar$/.test(newer?.name || '')) {
          throw new Error('Invalid replacement source bottle');
        }
        await this.download(newer, path.join(temporary, 'replacement'), newer.name.slice(0, -4));
      }
      for (const asset of related) {
        if (obsolete.includes(asset.label.split(':').slice(2).join(':'))) {
          await this.api(`releases/assets/${asset.id}`, { method: 'DELETE', allow: [404] });
        }
      }
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
}

module.exports = { ReleaseCache, family, unpack };
