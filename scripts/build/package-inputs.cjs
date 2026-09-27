const fs = require('node:fs');
const path = require('node:path');
const {command, digest} = require('../installer/install-extensions.cjs');
const {recipeCurrent} = require('../lib/recipe-inputs.cjs');
const {sourceRecords} = require('./extension-pack.cjs');
const root = path.resolve(__dirname, '../..');

function builderHash() {
  const files = ['scripts/build/build.sh', 'scripts/build/filter-archive.sh', 'scripts/build/select-packages.sh',
    'scripts/build/create-tap-snapshot.sh', 'scripts/build/build-extensions.sh', 'scripts/build/extension-formula.rb',
    'scripts/lib/recipe-inputs.cjs', 'scripts/build/formula-build-inputs.sh',
    'conf/archive-paths', 'conf/archive-policy.json', 'conf/postinstall-paths', 'conf/platforms.json', 'conf/variants'];
  return digest(JSON.stringify(files.map(file => [file, digest(fs.readFileSync(path.join(root, file)))])));
}

function current(manifest, repositories, expectedBuilder = builderHash()) {
  if (!Array.isArray(manifest.assets) || !manifest.assets.length) return false;
  return manifest.assets.every(asset => {
    const inputs = asset.build_inputs;
    return inputs?.schema === 1 && inputs.builder_sha256 === expectedBuilder &&
      Array.isArray(inputs.source_records) && inputs.source_records.length > 0 &&
      inputs.source_records.every(record => recipeCurrent(record, repositories[record.repository]));
  });
}

function capture(metadata) {
  const info = JSON.parse(command('brew', ['info', '--json=v2', '--formula', ...metadata.packages.map(item => item.name)]));
  const formulae = info.formulae.map(item => item.full_name);
  for (const extension of metadata.extensions) formulae.push(`shivammathur/extensions/${extension.name}@${metadata.php_version}`);
  return {schema: 1, builder_sha256: builderHash(), source_records: sourceRecords([...new Set(formulae)])};
}

module.exports = {builderHash, current, capture};
if (require.main === module) {
  try {
    const [mode, file] = process.argv.slice(2), metadata = JSON.parse(fs.readFileSync(file));
    if (mode === 'capture') {
      metadata.build_inputs = capture(metadata);
      fs.writeFileSync(file, JSON.stringify(metadata, null, 2) + '\n');
    } else if (mode === 'current') {
      console.log(current(metadata, {'Homebrew/homebrew-core': process.env.HOMEBREW_CORE_PATH,
        'shivammathur/homebrew-php': process.env.HOMEBREW_PHP_PATH,
        'shivammathur/homebrew-extensions': process.env.HOMEBREW_EXTENSIONS_PATH}));
    } else throw new Error('Usage: package-inputs.cjs capture|current <metadata>');
  } catch (error) { console.error(error); process.exitCode = 1; }
}
