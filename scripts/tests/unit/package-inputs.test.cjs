const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {current, phpCurrent} = require('../../build/package-inputs.cjs');
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
