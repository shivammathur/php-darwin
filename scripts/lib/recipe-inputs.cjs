const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const legacySyntax = require('../../conf/recipe-syntax-baselines.json');
const memo = new Map();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function recipeInputs(file, mode = 'platforms') {
  if (!['platforms', 'source'].includes(mode)) throw new Error('Invalid recipe input projection');
  const raw = digest(fs.readFileSync(file)), key = `${file}:${mode}:${raw}`;
  if (!memo.has(key)) {
    const result = spawnSync('bash', [path.join(__dirname, '../build/formula-build-inputs.sh'), file, mode], {encoding: 'utf8'});
    if (result.error || result.status !== 0) throw result.error || new Error(result.stderr);
    memo.set(key, digest(result.stdout));
  }
  return memo.get(key);
}

function recipeSyntax(bytes) {
  const key = 'syntax:' + digest(bytes);
  if (!memo.has(key)) {
    const result = spawnSync(process.env.PHP_DARWIN_RUBY || 'ruby',
      ['--disable=gems', path.join(__dirname, '../build/recipe-syntax.rb'), 'platforms'], {input: bytes, encoding: 'utf8'});
    if (result.error || result.status !== 0) throw result.error || new Error(result.stderr);
    memo.set(key, result.stdout.trim());
  }
  return memo.get(key);
}

function recipeCurrent(record, repository) {
  if (!record || !repository || typeof record.path !== 'string' || !record.path || record.path.includes('..') || path.isAbsolute(record.path)) return false;
  const file = path.join(repository, record.path);
  if (!fs.existsSync(file)) return false;
  const bytes = fs.readFileSync(file);
  if (digest(bytes) === record.sha256) return true;
  if (record.inputs_schema === 1 && /^[a-f0-9]{64}$/.test(record.inputs_sha256 || '') &&
      recipeInputs(file, record.inputs_mode) === record.inputs_sha256) return true;
  const syntax = record.syntax_sha256 || legacySyntax[record.sha256];
  return /^[a-f0-9]{64}$/.test(syntax || '') && recipeSyntax(bytes) === syntax;
}
module.exports = {recipeInputs, recipeSyntax, recipeCurrent};
