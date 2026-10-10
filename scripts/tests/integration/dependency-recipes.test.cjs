const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {apply, configured, updatePlan, validate} = require('../../cache/dependency-recipes.cjs');

test('selective updates retain the approved base and unrelated build tools on every checkout', t => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-recipes-'));
  t.after(() => fs.rmSync(repository, {recursive: true, force: true}));
  const git = args => execFileSync('git', ['-C', repository, ...args], {encoding: 'utf8'}).trim();
  git(['init', '-q']);
  const files = {'Formula/c/cmake.rb': 'old cmake\n', 'Formula/c/curl.rb': 'openssl 3 curl\n',
    'Formula/lib/libpq.rb': 'openssl 3 libpq\n'};
  const commit = () => {
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repository, name)), {recursive: true});
      fs.writeFileSync(path.join(repository, name), content);
    }
    git(['add', '.']);
    git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'recipes']);
    return git(['rev-parse', 'HEAD']);
  };
  const base = commit();
  files['Formula/c/cmake.rb'] = 'expensive new cmake\n';
  files['Formula/c/curl.rb'] = 'openssl 4 curl\n';
  files['Formula/lib/libpq.rb'] = 'openssl 4 libpq\n';
  const latest = commit();
  const plan = updatePlan({core_commit: base}, latest, 'curl libpq curl');
  assert.equal(plan.core_commit, base);
  assert.deepEqual(plan.updates, ['curl', 'libpq']);
  git(['checkout', '-q', '--detach', base]);
  apply(repository, base, plan.recipe_commits);
  assert.equal(git(['rev-parse', 'HEAD']), base);
  assert.equal(fs.readFileSync(path.join(repository, 'Formula/c/cmake.rb'), 'utf8'), 'old cmake\n');
  assert.equal(fs.readFileSync(path.join(repository, 'Formula/c/curl.rb'), 'utf8'), 'openssl 4 curl\n');
  assert.equal(fs.readFileSync(path.join(repository, 'Formula/lib/libpq.rb'), 'utf8'), 'openssl 4 libpq\n');
  assert.deepEqual(configured(base, {}, plan), plan.recipe_commits);
  assert.deepEqual(configured(latest, {}, plan), {});
  assert.deepEqual(updatePlan(plan, latest, '').recipe_commits, {});
  assert.equal(updatePlan(plan, latest, '').core_commit, latest);
  assert.throws(() => apply(repository, latest, plan.recipe_commits), /base differs/);
  assert.throws(() => validate({'../bad': latest}), /Invalid/);
  assert.throws(() => validate({curl: 'main'}), /Invalid/);
  const pinned = updatePlan({core_commit: base}, latest, 'curl', {cmake: base});
  assert.deepEqual(pinned.updates, ['curl']);
  assert.equal(pinned.recipe_commits.cmake, base);
  assert.throws(() => updatePlan({core_commit: base}, latest, 'cmake', {cmake: base}), /Bottle-only/);
  assert.throws(() => updatePlan({core_commit: base}, latest, '', {cmake: base}), /Bottle-only/);
});
