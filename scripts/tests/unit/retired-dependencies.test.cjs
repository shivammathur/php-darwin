const {test} = require('node:test');
const assert = require('node:assert/strict');
const {retireDependencies} = require('../../cache/retired-dependencies.cjs');

test('retirement requires a resolved graph and cached source provenance without the old dependency', () => {
  const packages = {old: {bottle: {}}, tool: {source: {inputs: {dependencies: []}}}};
  assert.deepEqual(retireDependencies(packages, ['old'], [{full_name: 'tool'}]), {tool: packages.tool});
  assert.ok(packages.old, 'The currently approved snapshot must remain unchanged');
  assert.throws(() => retireDependencies(packages, ['old'], [{full_name: 'old'}]), /resolved graph/);
  packages.tool.source.inputs.dependencies.push({name: 'old'});
  assert.throws(() => retireDependencies(packages, ['old'], []), /tool still records retired dependency old/);
  packages.tool.source.inputs.dependencies = [{name: 'compiler', runtime_dependencies: [{full_name: 'old'}]}];
  assert.throws(() => retireDependencies(packages, ['old'], []), /rebuild its cached bottle/);
  assert.throws(() => retireDependencies(packages, ['../old'], []), /Invalid/);
});
