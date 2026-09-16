const fs = require('node:fs');
const path = require('node:path');
const { command, digest } = require('../installer/install-extensions.cjs');
const { recipeInputs } = require('../lib/recipe-inputs.cjs');

function sourceRecords(formulae) {
  return formulae.map(formula => {
    const recipe = command('brew', ['formula', formula]);
    const tapName = formula.includes('/') ? formula.split('/').slice(0, 2).join('/') : 'homebrew/core';
    const tap = command('brew', ['--repository', tapName]);
    // Release/NTS can use an upstream bottle while other variants use source.
    // Preserve usable bottle changes, excluding only unrelated platform tags.
    const mode = 'platforms';
    const repository = tapName === 'homebrew/core' ? 'Homebrew/homebrew-core' : tapName.replace('/', '/homebrew-');
    return { formula, repository,
      path: path.relative(tap, recipe), sha256: digest(fs.readFileSync(recipe)),
      inputs_schema: 1, inputs_mode: mode, inputs_sha256: recipeInputs(recipe, mode) };
  });
}
module.exports = { sourceRecords };
