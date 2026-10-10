const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {activeRuns} = require('../cache/dependency-gate.cjs');
function pendingVersions(runs) {
  return new Set(runs.filter(run => run.status !== 'completed').flatMap(run => {
    const match = run.display_title?.match(/^Cache (?:stable|nightly) PHP (\d+\.\d+)$/);
    return match ? [match[1]] : [];
  }));
}
function recentRuns() {
  return ['cache-stable.yml', 'cache-nightly.yml'].flatMap(file => JSON.parse(execFileSync('gh',
    ['api', `repos/shivammathur/php-darwin/actions/workflows/${file}/runs?branch=main&per_page=100`], {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024})).workflow_runs);
}
function checker({runs = [...activeRuns('cache-stable.yml'), ...activeRuns('cache-nightly.yml'), ...recentRuns()],
  run = (args, env) => execFileSync('bash', args, {env: {...process.env, ...env}, stdio: 'inherit'})} = {}) {
  const pending = pendingVersions(runs);
  return (version, manifest) => {
    if (pending.has(version)) return false;
    const latest = runs.filter(item => item.display_title === `Cache stable PHP ${version}` || item.display_title === `Cache nightly PHP ${version}`)
      .sort((a, b) => b.id - a.id)[0];
    // Legacy PHP can outlive Actions history. Current published inputs remain
    // usable when no recent run exists; a known failed run still blocks updates.
    if (latest && latest.conclusion !== 'success') return false;
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'php-darwin-ready-'));
    try {
      const file = path.join(temporary, 'manifest.json'), output = path.join(temporary, 'output');
      fs.writeFileSync(file, JSON.stringify(manifest));
      run([path.join(__dirname, '../build/check-build-freshness.sh')], {PHP_VERSION: version,
        CHANNEL: manifest.php_src_commit ? 'nightly' : 'stable', FORCE: 'false', PUBLISH: 'true',
        PHP_DARWIN_MANIFEST_PATH: file, GITHUB_OUTPUT: output});
      return fs.readFileSync(output, 'utf8').split('\n').includes('build-required=false');
    } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
  };
}
module.exports = {checker, pendingVersions};
