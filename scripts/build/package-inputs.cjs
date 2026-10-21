const fs = require('node:fs');
const {command, digest} = require('../installer/install-extensions.cjs');
const {recipeCurrent} = require('../lib/recipe-inputs.cjs');
const {sourceRecords} = require('./extension-pack.cjs');
const acceptedBaselines = require('../../conf/php-cache-baselines.json');

function baselineFor(manifest, baselines = acceptedBaselines) {
  const baseline = baselines.schema === 1 && baselines.releases?.[manifest.php_version];
  return baseline && !manifest.php_src_commit &&
    ['php_semver', 'homebrew_php_commit', 'source_hash'].every(field => manifest[field] === baseline[field]) ? baseline : null;
}

function comparisonRecord(manifest, record, baselines) {
  if (record.repository !== 'shivammathur/homebrew-php') return record;
  const accepted = baselineFor(manifest, baselines)?.records.find(item =>
    item.path === record.path && item.published_sha256 === record.sha256);
  // The baseline acknowledges an existing publication; it never rewrites the
  // archive's actual recipe provenance or applies to a different publication.
  return accepted ? {...record, ...accepted} : record;
}

function current(manifest, repositories, baselines = acceptedBaselines) {
  if (!Array.isArray(manifest.assets) || !manifest.assets.length) return false;
  return manifest.assets.every(asset => {
    const inputs = asset.build_inputs;
    return inputs?.schema === 1 &&
      Array.isArray(inputs.source_records) && inputs.source_records.length > 0 &&
      inputs.source_records.every(record => recipeCurrent(comparisonRecord(manifest, record, baselines), repositories[record.repository]));
  });
}

function phpCurrent(manifest, repository, formulae, baselines = acceptedBaselines) {
  const records = [];
  for (const formula of formulae) {
    const matches = (manifest.assets || []).flatMap(asset => asset.build_inputs?.schema === 1 &&
      Array.isArray(asset.build_inputs.source_records) ? asset.build_inputs.source_records : [])
      .filter(record => record.repository === 'shivammathur/homebrew-php' && record.path === `Formula/${formula}.rb`);
    // Older manifests need the Git comparison when variant provenance is absent.
    if (!matches.length) return null;
    const record = matches[0];
    if (!/^[a-f0-9]{64}$/.test(record.sha256 || '') || matches.some(other =>
      ['sha256', 'inputs_schema', 'inputs_mode', 'inputs_sha256'].some(field => other[field] !== record[field]))) return false;
    records.push(record);
  }
  if (!records.length) return null;
  // Bind the complete variant records to the published raw formula checksum,
  // using the same sorted TSV as source-hash.sh before trusting projections.
  const raw = formulae.map((formula, i) => `${formula}\t${records[i].sha256}\n`).sort().join('');
  if (digest(raw) !== manifest.source_hash) return false;
  return records.every(record => {
    const compared = comparisonRecord(manifest, record, baselines);
    return recipeCurrent({...compared,
      inputs_schema: compared.inputs_mode === 'platforms' ? compared.inputs_schema : undefined}, repository);
  });
}

function capture(metadata) {
  const info = JSON.parse(command('brew', ['info', '--json=v2', '--formula', ...metadata.packages.map(item => item.name)]));
  const formulae = info.formulae.map(item => item.full_name);
  for (const extension of metadata.extensions) formulae.push(`shivammathur/extensions/${extension.name}@${metadata.php_version}`);
  return {schema: 1, source_records: sourceRecords([...new Set(formulae)])};
}

module.exports = {current, phpCurrent, baselineFor, capture};
if (require.main === module) {
  try {
    const [mode, file, ...formulae] = process.argv.slice(2), metadata = JSON.parse(fs.readFileSync(file));
    if (mode === 'capture') {
      metadata.build_inputs = capture(metadata);
      fs.writeFileSync(file, JSON.stringify(metadata, null, 2) + '\n');
    } else if (mode === 'current') {
      console.log(current(metadata, {'Homebrew/homebrew-core': process.env.HOMEBREW_CORE_PATH,
        'shivammathur/homebrew-php': process.env.HOMEBREW_PHP_PATH,
        'shivammathur/homebrew-extensions': process.env.HOMEBREW_EXTENSIONS_PATH}));
    } else if (mode === 'php-current') {
      console.log(phpCurrent(metadata, process.env.HOMEBREW_PHP_PATH, formulae) ?? 'unknown');
    } else if (mode === 'tap-only') {
      console.log(baselineFor(metadata)?.tap_only_updates === true);
    } else if (mode === 'baseline') {
      console.log(Boolean(baselineFor(metadata)));
    } else throw new Error('Usage: package-inputs.cjs capture|current|php-current|tap-only|baseline <metadata> [formulae...]');
  } catch (error) { console.error(error); process.exitCode = 1; }
}
