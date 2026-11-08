#!/usr/bin/env bash
set -euo pipefail
[ "${GITHUB_ACTIONS:-}" = true ] || exit 1
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_FROM_API=1
export HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1
node=${PHP_DARWIN_NODE:-node}
formula=icu4c@78
HOMEBREW_CORE_COMMIT=$("$node" scripts/cache/approved-dependencies.cjs core)
export HOMEBREW_CORE_COMMIT
bash scripts/build/pin-core.sh
"$node" <<'JS'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {install, brewSource, command, environment} = require('./scripts/cache/source-bottle-cache.cjs');
const {readLock, ApprovedDependencies} = require('./scripts/cache/approved-dependencies.cjs');
const {ReleaseCache} = require('./scripts/cache/source-bottle-releases.cjs');
(async () => {
  const formula = 'icu4c@78', platform = environment();
  const approved = new ApprovedDependencies(readLock());
  const options = {formula, approvedDependencies: approved,
    // Read the production dependency snapshot, independently of the isolated
    // release used by the source-compilation fixtures later in this job.
    cache: new ReleaseCache({readOnly: true}), cacheOnly: true,
    cacheRoot: path.join(process.env.RUNNER_TEMP, 'icu-repair-cache'),
    run(program, args, settings) {
      assert.ok(!args.includes('--build-bottle'), 'ICU repair must never compile');
      return command(program, args, settings);
    }};
  for (const dependency of ['pkgconf', formula]) {
    assert.equal((await install({...options, formula: dependency})).built, 0);
  }
  const info = () => JSON.parse(brewSource('info', ['plan', JSON.stringify([formula]), 'false',
    JSON.stringify(approved.versions(platform))])).find(item => item.full_name === formula);
  const metadata = path.join(command('brew', ['--prefix', formula]).trim(), 'lib/pkgconfig/icu-uc.pc');
  const original = fs.readFileSync(metadata);
  // Simulate a current keg and receipt with missing development metadata.
  // Intel ICU may have only an approved source bottle, with no upstream bottle.
  fs.unlinkSync(metadata);
  try {
    const record = info();
    assert.equal(record.installed, false);
    assert.ok(record.missing_build_files.includes('lib/pkgconfig/icu-uc.pc'));
    assert.equal((await install(options)).built, 0);
    const healthy = info();
    assert.equal(healthy.installed, true);
    assert.deepEqual(healthy.missing_build_files, []);
    await install({...options, run() { throw new Error('Healthy ICU was reinstalled'); }});
  } finally {
    if (!fs.existsSync(metadata)) fs.writeFileSync(metadata, original);
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
JS
icu=$(brew --prefix "$formula")
PKG_CONFIG_PATH="$icu/lib/pkgconfig" pkg-config --exists 'icu-uc >= 57.1' icu-i18n
printf 'Incomplete ICU restored from a bottle; healthy ICU retained\n'
