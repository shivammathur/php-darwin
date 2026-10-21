const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {digest} = require('../../installer/install-extensions.cjs');
const {recipeInputs} = require('../../lib/recipe-inputs.cjs');
const {versions} = require('../../../conf/extension-packs.json');

test('all PHP versions compare published recipes without fetching private staging commits', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'published-php-inputs-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const scripts = path.resolve(__dirname, '../..');
  fs.mkdirSync(path.join(root, 'Formula'));
  const env = {...process.env, HOMEBREW_PHP_PATH: root};
  const run = (script, args = []) => execFileSync('bash', [path.join(scripts, script), ...args], {env, encoding: 'utf8'}).trim();
  for (const version of versions) {
    const formulae = execFileSync('bash', ['-c', '. "$1"; while read -r build ts; do php_darwin_formula "$2" "$build" "$ts"; done < <(php_darwin_configured_variants)',
      'fixture', path.join(scripts, 'lib/lib.sh'), version], {encoding: 'utf8'}).trim().split('\n');
    const recipe = 'class Fixture < Formula\n  url "https://example.invalid/php.tar.gz"\n  bottle do\n' +
      `    sha256 arm64_linux: "${'a'.repeat(64)}"\n  end\nend\n`;
    const records = formulae.map(formula => {
      const relative = `Formula/${formula}.rb`, file = path.join(root, relative);
      fs.writeFileSync(file, recipe);
      return {repository: 'shivammathur/homebrew-php', path: relative, sha256: digest(recipe),
        inputs_schema: 1, inputs_mode: 'platforms', inputs_sha256: recipeInputs(file)};
    });
    const published = run('lib/source-hash.sh', [version]);
    const manifest = path.join(root, 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({homebrew_php_commit: 'f'.repeat(40), source_hash: published,
      assets: records.map(record => ({build_inputs: {schema: 1, source_records: [record]}}))}));
    // This fixture is deliberately not a Git checkout: any fallback fetch fails.
    const changed = path.join(root, `Formula/${formulae[3]}.rb`);
    fs.writeFileSync(changed, recipe.replace('a'.repeat(64), 'b'.repeat(64)));
    let current = run('lib/source-hash.sh', [version]);
    assert.notEqual(current, published);
    assert.equal(run('build/build-inputs-current.sh', [manifest, version, 'php', current, published]), 'true', version);
    fs.appendFileSync(changed, '  depends_on "new-library"\n');
    current = run('lib/source-hash.sh', [version]);
    assert.throws(() => run('build/build-inputs-current.sh', [manifest, version, 'php', current, published]),
      /could not fetch the published php source commit/, 'an unknown private publication must not trigger replacement');
  }
});
