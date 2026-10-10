const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const defaultFile = path.resolve(__dirname, '../../conf/dependencies.json');
const commitPattern = /^[a-f0-9]{40}$/;
const formulaPattern = /^[a-z0-9][a-z0-9@+_.-]*$/;

function validate(recipes = {}) {
  if (!recipes || Array.isArray(recipes) || typeof recipes !== 'object' ||
      Object.entries(recipes).some(([name, commit]) => !formulaPattern.test(name) || !commitPattern.test(commit))) {
    throw new Error('Invalid dependency recipe commits');
  }
  return Object.fromEntries(Object.entries(recipes).sort(([a], [b]) => a.localeCompare(b)));
}

function configured(core, env = process.env, lock = JSON.parse(fs.readFileSync(defaultFile))) {
  return validate(env.PHP_DARWIN_RECIPE_COMMITS ? JSON.parse(env.PHP_DARWIN_RECIPE_COMMITS) :
    core === lock.core_commit ? lock.recipe_commits : {});
}

function updatePlan(lock, commit, formulae, bottleRecipes = {}) {
  if (!commitPattern.test(commit)) throw new Error('Invalid dependency update commit');
  const names = formulae.trim().split(/\s+/).filter(Boolean);
  bottleRecipes = validate(bottleRecipes);
  if ((!names.length && Object.keys(bottleRecipes).length) || names.some(name => Object.hasOwn(bottleRecipes, name))) {
    throw new Error('Bottle-only recipe pins require a separate selective update');
  }
  const recipes = names.length ? {...validate(lock.recipe_commits), ...bottleRecipes,
    ...Object.fromEntries(names.map(name => [name, commit]))} : {};
  return {core_commit: names.length ? lock.core_commit : commit, recipe_commits: validate(recipes),
    updates: [...new Set(names)], bottle_updates: Object.keys(bottleRecipes)};
}

function apply(repository, core, recipes) {
  recipes = validate(recipes);
  const git = args => execFileSync('git', ['-C', repository, ...args],
    {encoding: 'utf8', env: {...process.env, ...(args[0] === 'cat-file' ? {GIT_NO_LAZY_FETCH: '1'} : {})}}).trimEnd();
  if (git(['rev-parse', 'HEAD']) !== core) throw new Error('Dependency recipe base differs from the checkout');
  const files = [];
  for (const commit of new Set(Object.values(recipes))) {
    try { git(['cat-file', '-e', `${commit}^{commit}`]); }
    catch {
      const shallow = git(['rev-parse', '--is-shallow-repository']) === 'true';
      git(['fetch', '--no-tags', ...(shallow ? ['--depth=1'] : []), 'origin', commit]);
    }
    const paths = git(['ls-tree', '-r', '--name-only', commit, 'Formula']).split('\n');
    for (const [name, selected] of Object.entries(recipes)) {
      if (selected !== commit) continue;
      const matches = paths.filter(file => /^Formula\/[a-z0-9]+\/[^/]+\.rb$/.test(file) && path.basename(file) === `${name}.rb`);
      if (matches.length !== 1) throw new Error(`Missing or ambiguous dependency recipe: ${name}`);
      files.push([matches[0], git(['show', `${commit}:${matches[0]}`]) + '\n']);
    }
  }
  for (const [file, contents] of files) {
    const target = path.join(repository, file);
    if (process.env.GITHUB_ACTIONS !== 'true' && fs.existsSync(target) && fs.readFileSync(target, 'utf8') !== contents) {
      git(['diff', '--exit-code', 'HEAD', '--', file]);
    }
    fs.mkdirSync(path.dirname(path.join(repository, file)), {recursive: true});
    fs.writeFileSync(target, contents);
  }
}

module.exports = {validate, configured, updatePlan, apply};
if (require.main === module) {
  try {
    if (process.argv[2] === 'plan') {
      const plan = updatePlan(JSON.parse(fs.readFileSync(defaultFile)), process.env.UPDATE_CORE_COMMIT,
        process.env.UPDATE_FORMULAE || '', JSON.parse(process.env.BOTTLE_RECIPES || '{}'));
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `core=${plan.core_commit}\nrecipe-commits=${JSON.stringify(plan.recipe_commits)}\nupdates=${JSON.stringify(plan.updates)}\nbottle-updates=${JSON.stringify(plan.bottle_updates)}\n`);
    } else if (process.argv[2] === 'apply') {
      const repository = process.argv[3];
      const core = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
      apply(repository, core, configured(core));
    } else throw new Error('Expected plan or apply');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
