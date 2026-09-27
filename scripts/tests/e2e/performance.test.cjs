const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { command, digest } = require('../../installer/install-extensions.cjs');

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'This fixture reinstalls PHP on a CI runner');
const version = process.env.PHP_VERSION;
assert.match(version, /^\d+\.\d+$/);
const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
const directory = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'php-install-performance-'));
try {
  const download = file => command('gh', ['release', 'download', `php-${version}`, '--repo', 'shivammathur/php-darwin',
    '--pattern', file, '--dir', directory]);
  download(`php-${version}-manifest.json`);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, `php-${version}-manifest.json`)));
  const asset = manifest.assets.find(a => a.architecture === architecture && a.build === 'release' && a.thread_safety === 'nts');
  assert.ok(asset && path.basename(asset.download) === asset.download && path.basename(asset.name) === asset.name);
  download(asset.download);
  const archive = path.join(directory, asset.name);
  fs.renameSync(path.join(directory, asset.download), archive);
  assert.equal(digest(fs.readFileSync(archive)), asset.sha256);
  const metadata = asset.name.replace(/\.tar\.zst$/, '.json');
  fs.writeFileSync(path.join(directory, metadata), command('tar', ['--zstd', '-xOf', archive, `var/php-darwin/${metadata}`]));
  fs.writeFileSync(archive + '.sha256', `${asset.sha256}  ${asset.name}\n`);
  const samples = { baseline: [], checkout: [] };
  // Warm both paths, then alternate their order on the same dependency state.
  // Archive transfer time is deliberately outside this installer comparison.
  for (let trial = 0; trial < 6; trial++) {
    for (const installer of trial % 2 ? ['checkout', 'baseline'] : ['baseline', 'checkout']) {
      const script = path.resolve(installer === 'baseline' ? '.baseline/scripts/install.sh' : 'scripts/install.sh');
      const started = performance.now();
      const result = spawnSync('bash', [script, version, 'release', 'nts', archive], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, BASH_ENV: '', INPUT_EXTENSIONS: '', PHP_DARWIN_EXTENSIONS: '' } });
      const seconds = (performance.now() - started) / 1000;
      assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
      if (trial === 0) continue;
      samples[installer].push(seconds);
      fs.appendFileSync(process.env.PHP_DARWIN_TEST_TIMINGS, JSON.stringify({ installer, phase: 'prefetched-reinstall',
        trial, seconds, architecture, php: version, status: result.status }) + '\n');
    }
  }
  const median = values => [...values].sort((a, b) => a - b)[2];
  console.log(JSON.stringify({ architecture, php: version, phase: 'prefetched-reinstall',
    baseline_median: median(samples.baseline), candidate_median: median(samples.checkout), samples }));
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
