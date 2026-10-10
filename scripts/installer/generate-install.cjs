#!/usr/bin/env node
// Generate readable shell. Only reachable shared-library functions are shipped.
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const json = file => JSON.parse(read(`conf/${file}`));
const functions = new Map([...read('scripts/lib/lib.sh').matchAll(/^(php_darwin_\w+)\(\) \{\n[\s\S]*?^\}/gm)].map(match => [match[1], match[0]]));
function library(source) {
  const selected = new Set();
  const defined = new Set([...source.matchAll(/^(php_darwin_\w+)\(\)/gm)].map(match => match[1]));
  function visit(text) {
    for (const name of text.match(/php_darwin_\w+/g) || []) if (functions.has(name) && !defined.has(name) && !selected.has(name) && name !== 'php_darwin_read_config') {
      selected.add(name); visit(functions.get(name));
    }
  }
  visit(source);
  return [...selected].map(name => functions.get(name)).join('\n\n');
}
function config(names, manifest) {
  return `php_darwin_read_config() {\n  case "$1" in\n${names.map(name => `    ${name}) cat <<'PHP_DARWIN_CONFIG'\n${read('conf/' + name)}PHP_DARWIN_CONFIG\n      ;;`).join('\n')}\n    release-manifest.json) cat <<'PHP_DARWIN_MANIFEST'\n${manifest || '{}\n'}PHP_DARWIN_MANIFEST\n      ;;\n    *) return 1 ;;\n  esac\n}\n`;
}
function embedded(name, data, destination = '') {
  const delimiter = 'PHP_DARWIN_' + name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  if (data.split('\n').includes(delimiter)) throw new Error('Unsafe heredoc delimiter');
  return `cat ${destination}<<'${delimiter}'\n${data.endsWith('\n') ? data : data + '\n'}${delimiter}\n`;
}
function normalize(source) {
  return source.replace(/^#!.*\n/, '').replace(/^script_dir=.*\n/gm, '').replace(/^# shellcheck source=.*\n/gm, '').replace(/^\. "\$script_dir\/(?:\.\.\/lib\/)?lib\.sh"\n/gm, '')
    .replace(/bash "\$script_dir\/(?:\.\.\/lib\/)?([a-z-]+)\.sh"/g, (_, name) => 'php_darwin_' + name.replaceAll('-', '_'));
}
function context(metadata, prefix, metadataSource) {
  const packageConfig = json('package.json');
  const v = metadata.php_version, formula = metadata.formula;
  const id = v + (metadata.build === 'debug' ? '-debug' : '') + (metadata.thread_safety === 'zts' ? '-zts' : '');
  const channel = read('conf/versions').split('\n').map(line => line.trim().split(/\s+/)).find(parts => parts.includes(v))?.[0];
  if (!['stable', 'nightly'].includes(channel)) throw new Error('Unknown PHP channel');
  const values = {arch: metadata.architecture, expected_prefix: metadata.brew_prefix, minimum_macos: metadata.minimum_macos,
    platform_key: metadata.platform_key, current_version: packageConfig.current_version, channel, formula, requested_formula: metadata.requested_formula,
    config_id: id, asset: metadata.archive, pear_path: metadata.pear_path, internal_metadata_path: `var/php-darwin/${metadata.archive.replace('.tar.zst', '.json')}`,
    tap: packageConfig.tap, tap_repository: packageConfig.tap_repository, tap_branch: packageConfig.tap_branch, tap_snapshot: metadata.tap_snapshot,
    metadata_homebrew_commit: metadata.homebrew_php_commit, cached_source_hash: metadata.source_hash,
    target_keg_relative: metadata.packages.find(item => item.name === formula).opt_target.replace(/^\.\.\//, ''),
    pecl_extension: metadata.pecl_extension, metadata_php_semver: metadata.php_semver};
  let output = `php_darwin_package_context() {\n  [ "$version/$build/$ts" = ${quote(`${v}/${metadata.build}/${metadata.thread_safety}`)} ] || php_darwin_die 'packaged installer does not match the request'\n`;
  output += Object.entries(values).map(([name, value]) => `  ${name}=${quote(value)}`).join('\n') + '\n}\n';
  output += `php_darwin_package_metadata() {\n${embedded('metadata', metadataSource)}}\n`;
  const dependencies = new Set();
  for (const item of metadata.packages) {
    const receipt = JSON.parse(fs.readFileSync(path.join(prefix, item.opt_target.replace(/^\.\.\//, ''), 'INSTALL_RECEIPT.json')));
    if (!Array.isArray(receipt.runtime_dependencies)) throw new Error(`Missing dependency receipts for ${item.name}`);
    for (const entry of receipt.runtime_dependencies) {
      const name = entry.full_name?.split('/').at(-1);
      if (!name || !/^[a-zA-Z0-9@+_.-]+$/.test(name) || ['.', '..'].includes(name)) throw new Error('Invalid dependency receipt');
      dependencies.add(name);
    }
  }
  const inventories = {
    'packages.tsv': metadata.packages.map(p => [p.name, p.opt_target, p.keg_only].join('\t')),
    'package-kegs.txt': metadata.packages.map(p => p.opt_target.replace(/^\.\.\//, '')),
    'links.tsv': metadata.links.map(p => [p.path, p.target].join('\t')),
    'managed-paths.txt': [...metadata.links.map(p => p.path), ...metadata.extensions.map(p => p.path), ...metadata.packages.map(p => 'opt/' + p.name), ...metadata.state_paths],
    'state-paths-inventory.txt': metadata.state_paths,
    'extension-paths-inventory.tsv': metadata.extensions.map(p => [p.name, p.type, p.path].join('\t')),
    'tap-formulae.txt': metadata.tap_formulae?.length ? metadata.tap_formulae : [formula],
    'runtime-dependencies.txt': [...dependencies].sort(),
  };
  output += 'php_darwin_package_inventory() {\n';
  for (const [name, lines] of Object.entries(inventories)) output += (lines.length ? embedded(name, lines.join('\n') + '\n', `> "$1/${name}" `) : `: > "$1/${name}"\n`) + '  [ "$?" -eq 0 ] || return 1\n';
  output += '}\n';
  const directories = json('installer.json').empty_directories.map(value => value.replaceAll('{pecl_extension}', metadata.pecl_extension).replaceAll('{pear_path}', metadata.pear_path));
  output += `php_darwin_package_empty_dirs() {\n${embedded('empty_dirs', directories.join('\n') + '\n')}}\n`;
  const candidates = execFileSync('bash', ['-c', '. scripts/lib/lib.sh; php_darwin_postinstall_paths "$@"', 'plan', v, formula, metadata.build, metadata.thread_safety], {cwd: root, encoding: 'utf8'});
  output += `php_darwin_package_postinstall() {\n${embedded('postinstall', candidates)}}\n`;
  return output;
}
function generate({output = path.join(root, 'scripts/install.sh'), metadata, prefix, manifest = process.env.PHP_DARWIN_RELEASE_MANIFEST} = {}) {
  let content, names;
  if (metadata) {
    const data = JSON.parse(fs.readFileSync(metadata));
    content = context(data, prefix, fs.readFileSync(metadata, 'utf8'));
    const files = read('conf/install-files').split('\n').filter(name => name.startsWith('scripts/') && !['scripts/installer/install-package.sh', 'scripts/lib/lib.sh', 'scripts/installer/install-extensions.cjs', 'scripts/installer/read-metadata.sh'].includes(name));
    content += `php_darwin_extension_installer() {\n${embedded('extension_installer', require('./install-extensions.cjs').standaloneSource())}}\n`;
    for (const file of files) content += `\n# Source: ${file}\nphp_darwin_${path.basename(file, '.sh').replaceAll('-', '_')}() (\n${normalize(read(file))}\n)\n`;
    content += '\n# Source: scripts/installer/install-package.sh\n' + normalize(read('scripts/installer/install-package.sh')).replace('"$extension_node" "$script_dir/install-extensions.cjs" standalone', 'php_darwin_extension_installer')
      .replace(/# This entry point[\s\S]*?\nfi\nphp_darwin_package_context/, 'php_darwin_package_context');
    names = ['archive-paths', 'package.json', 'platforms.json', 'postinstall-paths', 'variants', 'versions'];
  } else {
    content = normalize(read('scripts/installer/bootstrap.sh')).replace('# DOWNLOAD_FUNCTIONS', () => read('scripts/installer/download.sh').replace(/^#!.*\n/, ''));
    content = content.replace('# PREFETCH_SOURCE', () => embedded('prefetch', require('./install-extensions.cjs').prefetchSource(), '> "$extension_dir/prefetch.cjs" '));
    names = ['package.json', 'transfers.json', 'platforms.json', 'variants', 'versions'];
  }
  let selection;
  if (!metadata && manifest) {
    const release = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    // Provenance is published separately. The bootstrap needs only immutable
    // identities, compatibility bounds and checksums to select its download.
    const fields = ['name', 'download', 'architecture', 'build', 'thread_safety', 'minimum_macos', 'sha256', 'bytes'];
    selection = JSON.stringify({schema: release.schema, php_version: release.php_version,
      assets: release.assets.map(asset => Object.fromEntries(fields.map(field => [field, asset[field]])))}, null, 2) + '\n';
  }
  const result = '#!/usr/bin/env bash\n# Generated by scripts/installer/generate-install.cjs. Do not edit.\n\n' + config(names, selection) + '\n' + library(content) + '\n' + content;
  fs.mkdirSync(path.dirname(output), {recursive: true});
  fs.writeFileSync(output, result, {mode: 0o755});
  execFileSync('bash', ['-n', output]);
  return result;
}
module.exports = {generate, library};
if (require.main === module) generate({output: process.argv[2], metadata: process.argv[3], prefix: process.argv[4]});
