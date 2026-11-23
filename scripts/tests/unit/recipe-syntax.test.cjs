const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {recipeSyntax, recipeCurrent} = require('../../lib/recipe-inputs.cjs');
const {capture, changed} = require('../../cache/dependency-inputs.cjs');
const hash = require('node:crypto').hash;

const getter = 'def priority(val)\n  val.nil? ? @priority : @priority = val\nend\n';
const guard = 'def priority(val)\n  return @priority if val.nil?\n\n  @priority = val\nend\n';
test('shared method style and call syntax retain a pack until its inputs change', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-style-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const file = path.join(root, 'shared.rb');
  const record = {path: 'shared.rb', sha256: hash('sha256', getter), syntax_sha256: recipeSyntax(getter)};
  fs.writeFileSync(file, guard);
  assert.equal(recipeCurrent(record, root), true);
  fs.writeFileSync(file, guard.replace('@priority = val', '@priority = 20'));
  assert.equal(recipeCurrent(record, root), false);
  fs.writeFileSync(file, guard);
  assert.equal(recipeCurrent({...record, sha256: 'f'.repeat(64), syntax_sha256: undefined}, root), false);
  const old = 'depends_on "libssh2" => :build\n';
  const modern = "# Style only\ndepends_on('libssh2' => :build)\n";
  assert.equal(recipeSyntax(old), recipeSyntax(modern));
  assert.notEqual(recipeSyntax(old), recipeSyntax(modern.replace(':build', ':test')));
});

test('bottle metadata and formatting retain the selected bottle and all meaningful recipe inputs', () => {
  const a = 'a'.repeat(64), b = 'b'.repeat(64);
  const old = `class Fixture < Formula\n  bottle do\n    sha256 arm64_sequoia: "${a}"\n    sha256 arm64_linux: "${b}"\n  end\nend\n`;
  const modern = old.replace('    sha256 arm64_sequoia: "' + a + '"', `    manifest_sha256 "${b}"\n    sha256(:arm64_sequoia => '${a}')`)
    .replace('arm64_linux: "' + b, 'arm64_linux: "' + a);
  assert.equal(recipeSyntax(old), recipeSyntax(modern));
  assert.notEqual(recipeSyntax(old), recipeSyntax(modern.replace(a, b)));
  assert.notEqual(recipeSyntax(old), recipeSyntax(old.replace('bottle do', 'revision 2\n  bottle do')));
  assert.notEqual(recipeSyntax(old), recipeSyntax(old.replace('bottle do', 'bottle do\n    custom_bottle_input "changed"')));
  for (const [before, after] of [
    ["args = %w[build test]", "args = %i[build test]"],
    [String.raw`patch = 'one\ntwo'`, String.raw`patch = "one\ntwo"`],
    ['x = __LINE__', '\nx = __LINE__'], ['# frozen_string_literal: true\ns = "x"', 's = "x"'],
    ['patch :DATA\n__END__\n-a', 'patch :DATA\n__END__\n-b'],
    ['def install\n  system "make", "install"\nend', 'def install\n  system "make", "test"\nend'],
    ['url "v1"\nsha256 "abc"', 'url "v2"\nsha256 "abc"'],
  ]) assert.notEqual(recipeSyntax(before), recipeSyntax(after), before);
});

test('dependency approval ignores shared helper style and equivalent dependency and bottle DSL', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-style-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  for (const sub of ['Abstract', 'Formula']) fs.mkdirSync(path.join(directory, sub));
  const helper = path.join(directory, 'Abstract/base.rb'), formula = path.join(directory, 'Formula/foo.rb');
  const recipe = `class Foo < Formula\n  depends_on "libssh2"\n  bottle do\n    sha256 sequoia: "${'a'.repeat(64)}"\n  end\nend\n`;
  fs.writeFileSync(helper, getter);
  fs.writeFileSync(formula, recipe);
  execFileSync('git', ['-C', directory, 'init', '-q']);
  execFileSync('git', ['-C', directory, 'add', '.']);
  const snapshot = () => capture({'homebrew-extensions': directory});
  const first = snapshot();
  fs.writeFileSync(helper, guard);
  fs.writeFileSync(formula, recipe.replace('depends_on "libssh2"', 'depends_on("libssh2")')
    .replace('sha256 sequoia: ', 'sha256 :sequoia => ')
    .replace('    sha256', `    manifest_sha256 "${'b'.repeat(64)}"\n    sha256`));
  assert.equal(changed(first, snapshot()).changed, false);
  fs.writeFileSync(formula, recipe.replace('libssh2', 'libssh'));
  assert.deepEqual(changed(first, snapshot()).formulae, ['libssh', 'libssh2']);
  fs.writeFileSync(helper, guard.replace('@priority = val', '@priority = 20'));
  assert.equal(changed(first, snapshot()).allRuntime, true);
});
