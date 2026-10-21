const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {current, phpCurrent, baselineFor} = require('../../build/package-inputs.cjs');
const {recipeInputs} = require('../../lib/recipe-inputs.cjs');
const {digest} = require('../../installer/install-extensions.cjs');

test('dependency changes invalidate packages; php-darwin revisions and unrelated bottles retain cache hits', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'package-inputs-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const file = path.join(root, 'formula.rb');
  const recipe = 'class Fixture < Formula\n  url "https://example.invalid/lib-1.tar.gz"\n  bottle do\n' +
    `    sha256 arm64_sonoma: "${'a'.repeat(64)}"\n    sha256 arm64_linux: "${'b'.repeat(64)}"\n  end\nend\n`;
  fs.writeFileSync(file, recipe);
  const record = {repository: 'Homebrew/homebrew-core', path: 'formula.rb', sha256: digest(recipe),
    inputs_schema: 1, inputs_mode: 'platforms', inputs_sha256: recipeInputs(file)};
  const inputs = {schema: 1, builder_sha256: 'a'.repeat(64), source_records: [record]};
  const manifest = {assets: [{build_inputs: inputs}]}, repositories = {'Homebrew/homebrew-core': root};
  assert.equal(current(manifest, repositories), true);
  fs.writeFileSync(file, recipe.replace('b'.repeat(64), 'c'.repeat(64)));
  assert.equal(current(manifest, repositories), true);
  fs.writeFileSync(file, recipe.replace('a'.repeat(64), 'd'.repeat(64)));
  assert.equal(current(manifest, repositories), false);
  fs.writeFileSync(file, recipe.replace('lib-1', 'lib-2'));
  assert.equal(current(manifest, repositories), false);
  fs.writeFileSync(file, recipe);
  inputs.builder_sha256 = 'f'.repeat(64);
  assert.equal(current(manifest, repositories), true);
  delete inputs.builder_sha256;
  assert.equal(current(manifest, repositories), true);
  assert.equal(current({assets: [{}]}, repositories), false);
  delete inputs.source_records;
  assert.equal(current(manifest, repositories), false);
});

test('accepted tap baselines retain provenance, expire with publication changes and detect future recipe edits', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'php-baseline-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, 'Formula'));
  const file = path.join(root, 'Formula/php.rb');
  const before = 'published source\n', accepted = 'accepted tap source\n';
  fs.writeFileSync(file, accepted);
  const record = {repository: 'shivammathur/homebrew-php', path: 'Formula/php.rb', sha256: digest(before)};
  const manifest = {php_version: '8.5', php_semver: '8.5.12', homebrew_php_commit: 'a'.repeat(40),
    source_hash: digest(`php\t${record.sha256}\n`), assets: [{build_inputs: {schema: 1, source_records: [record]}}]};
  const original = JSON.stringify(manifest);
  const baselines = {schema: 1, releases: {'8.5': {...manifest, tap_only_updates: false,
    records: [{path: record.path, published_sha256: record.sha256, sha256: digest(accepted),
      inputs_schema: 1, inputs_mode: 'platforms', inputs_sha256: recipeInputs(file)}]}}};
  const repositories = {'shivammathur/homebrew-php': root};
  assert.equal(phpCurrent(manifest, root, ['php'], baselines), true);
  assert.equal(current(manifest, repositories, baselines), true);
  assert.equal(JSON.stringify(manifest), original, 'published build provenance stays unchanged');
  for (const field of ['php_semver', 'homebrew_php_commit', 'source_hash']) {
    const changed = {...manifest, [field]: 'changed'};
    assert.equal(baselineFor(changed, baselines), null);
    assert.equal(current(changed, repositories, baselines), false);
  }
  assert.equal(baselineFor({...manifest, php_src_commit: 'b'.repeat(40)}, baselines), null);
  fs.appendFileSync(file, 'new tap change\n');
  assert.equal(phpCurrent(manifest, root, ['php'], baselines), false);
  assert.equal(current(manifest, repositories, baselines), false);
});

test('checked-in baselines bind all four variants of the twelve accepted stable publications', () => {
  const baselines = require('../../../conf/php-cache-baselines.json');
  assert.match(baselines.tap_commit, /^[a-f0-9]{40}$/);
  assert.equal(Object.keys(baselines.releases).length, 12);
  for (const [version, baseline] of Object.entries(baselines.releases)) {
    const base = version === '8.5' ? 'php' : `php@${version}`;
    assert.deepEqual(baseline.records.map(record => record.path).sort(),
      ['', '-zts', '-debug', '-debug-zts'].map(suffix => `Formula/${base}${suffix}.rb`).sort());
    const raw = baseline.records.map(record => `${record.path.slice(8, -3)}\t${record.published_sha256}\n`).sort().join('');
    assert.equal(digest(raw), baseline.source_hash, version);
    assert.equal(baseline.tap_only_updates, Number(version) <= 8.1);
    for (const record of baseline.records) {
      assert.match(record.sha256, /^[a-f0-9]{64}$/);
      assert.match(record.inputs_sha256, /^[a-f0-9]{64}$/);
      assert.equal(record.inputs_mode, 'platforms');
    }
  }
});

test('published PHP variant records verify inaccessible commits without hiding recipe changes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'php-inputs-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, 'Formula'));
  const formulae = ['php', 'php-zts', 'php-debug', 'php-debug-zts'];
  const recipe = 'class Fixture < Formula\n  url "https://example.invalid/php-1.tar.gz"\n  bottle do\n' +
    `    sha256 arm64_sonoma: "${'a'.repeat(64)}"\n    sha256 arm64_linux: "${'b'.repeat(64)}"\n  end\nend\n`;
  const records = formulae.map(formula => {
    const relative = `Formula/${formula}.rb`, file = path.join(root, relative);
    fs.writeFileSync(file, recipe);
    return {repository: 'shivammathur/homebrew-php', path: relative, sha256: digest(recipe),
      inputs_schema: 1, inputs_mode: 'platforms', inputs_sha256: recipeInputs(file)};
  });
  const manifest = {homebrew_php_commit: 'f'.repeat(40),
    source_hash: digest(formulae.map((formula, i) => `${formula}\t${records[i].sha256}\n`).sort().join('')),
    assets: records.flatMap(record => ['arm64', 'x86_64'].map(architecture =>
      ({architecture, build_inputs: {schema: 1, source_records: [{...record}]}})))};
  assert.equal(phpCurrent(manifest, root, formulae), true);
  const file = path.join(root, 'Formula/php-debug-zts.rb');
  fs.writeFileSync(file, recipe.replace('b'.repeat(64), 'c'.repeat(64)));
  assert.equal(phpCurrent(manifest, root, formulae), true, 'unrelated bottles retain cache hits');
  fs.writeFileSync(file, recipe.replace('a'.repeat(64), 'd'.repeat(64)));
  assert.equal(phpCurrent(manifest, root, formulae), false, 'selected platform bottles invalidate inputs');
  fs.writeFileSync(file, recipe.replace('php-1', 'php-2'));
  assert.equal(phpCurrent(manifest, root, formulae), false, 'source changes invalidate inputs');
  fs.writeFileSync(file, recipe);
  assert.equal(phpCurrent({...manifest, source_hash: '0'.repeat(64)}, root, formulae), false);
  const conflict = structuredClone(manifest);
  conflict.assets[1].build_inputs.source_records[0].inputs_sha256 = '0'.repeat(64);
  assert.equal(phpCurrent(conflict, root, formulae), false, 'architecture records must agree');
  assert.equal(phpCurrent({assets: []}, root, formulae), null, 'legacy metadata falls back to Git');
  assert.equal(phpCurrent({...manifest, assets: manifest.assets.slice(2)}, root, formulae), null,
    'incomplete variant records cannot prove freshness');
  fs.writeFileSync(file, recipe.replace('a'.repeat(64), 'd'.repeat(64)));
  for (const asset of manifest.assets.slice(-2)) {
    const record = asset.build_inputs.source_records[0];
    record.inputs_mode = 'source';
    record.inputs_sha256 = recipeInputs(file, 'source');
  }
  assert.equal(phpCurrent(manifest, root, formulae), false, 'source-only projections cannot hide bottle changes');
});
