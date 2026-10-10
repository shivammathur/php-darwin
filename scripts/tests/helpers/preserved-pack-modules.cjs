const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const configuration = require('../../../conf/extension-packs.json');
const dependencies = new Set(Object.entries(configuration.packs).flatMap(([name, modules]) =>
  modules.filter(module => module.name !== name).map(module => `${module.name}.so`)));
function fingerprint(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('Invalid preinstalled pack dependency');
  return {sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    link: stat.isSymbolicLink() ? fs.readlinkSync(file) : null};
}
function snapshot(prefix, file) {
  const records = {};
  function walk(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(candidate);
      else if (dependencies.has(entry.name) && fs.existsSync(candidate)) records[candidate] = fingerprint(candidate);
    }
  }
  const shared = path.join(prefix, 'lib/php/pecl');
  if (fs.existsSync(shared)) walk(fs.realpathSync(shared));
  fs.writeFileSync(file, JSON.stringify(records, null, 2) + '\n');
}
function check(prefix, file, module) {
  if (!dependencies.has(path.basename(module))) {
    throw new Error('Module is not a preservable pack dependency');
  }
  // php-config can expose the keg's pecl directory alias. Resolve only its
  // parent: the module's own symlink must remain part of its fingerprint.
  module = path.join(fs.realpathSync(path.dirname(module)), path.basename(module));
  if (!module.startsWith(fs.realpathSync(path.join(prefix, 'lib/php/pecl')) + path.sep)) {
    throw new Error('Module is not a preservable pack dependency');
  }
  const before = JSON.parse(fs.readFileSync(file, 'utf8'))[module];
  if (!before || JSON.stringify(before) !== JSON.stringify(fingerprint(module))) throw new Error('Preinstalled pack dependency was not preserved');
}
module.exports = {snapshot, check};
if (require.main === module) {
  const [mode, prefix, file, module] = process.argv.slice(2);
  if (mode === 'snapshot') snapshot(prefix, file);
  else if (mode === 'check') check(prefix, file, module);
  else throw new Error('Expected snapshot or check');
}
