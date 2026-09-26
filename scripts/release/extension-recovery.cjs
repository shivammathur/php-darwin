const fs = require('node:fs');
const path = require('node:path');
const { key, validateEntry } = require('../installer/install-extensions.cjs');
function verifySelection(directory, keys) {
  const visit = folder => fs.readdirSync(folder, { withFileTypes: true }).flatMap(item => {
    const file = path.join(folder, item.name);
    return item.isDirectory() ? visit(file) : file.endsWith('.json') ? [file] : [];
  });
  const actual = visit(directory).map(file => key(validateEntry(JSON.parse(fs.readFileSync(file))))).sort();
  if (!Array.isArray(keys) || !keys.length || new Set(keys).size !== keys.length ||
      JSON.stringify(actual) !== JSON.stringify([...keys].sort())) throw new Error('Recovery artifacts differ from the tested selection');
}

module.exports = { verifySelection };
if (require.main === module) verifySelection(process.argv[3], JSON.parse(process.env.EXTENSION_RECOVERY_KEYS));
