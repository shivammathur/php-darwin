const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {bottleVersions} = require('../../cache/approved-dependencies.cjs');
const {resolvePlan} = require('../../cache/dependency-transition.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-bottle-runtime-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const name of ['formula_installer', 'pkg_version']) fs.writeFileSync(path.join(root, `${name}.rb`), '');
  fs.writeFileSync(path.join(root, 'formulary.rb'), `require "pathname"
module Dependable
  PRUNE = :prune
  KEEP_BUT_PRUNE_RECURSIVE_DEPS = :keep
end
class Dependency < Struct.new(:name, :kind)
  def optional?; kind == :optional; end
  def test?; kind == :test; end
  def build?; kind == :build; end
  def uses_from_macos?; kind == :macos; end
  def use_macos_install?(bottle_os_version: nil)
    (bottle_os_version || "macOS 15").delete_prefix("macOS ").to_i >= 15
  end
  def to_formula; Formulary.factory(name); end
  def self.expand(formula, &block)
    formula.deps.flat_map do |dep|
      decision = block.call(formula, dep)
      next [] if decision == Dependable::PRUNE
      (decision == Dependable::KEEP_BUT_PRUNE_RECURSIVE_DEPS ? [] : expand(dep.to_formula, &block)) + [dep]
    end.uniq(&:name)
  end
end
class FixtureFormula < Struct.new(:name, :deps)
  def full_name; name; end
  def pkg_version; "1.0"; end
  def prefix; Pathname.new(ENV.fetch("FIXTURE_ROOT"))/name; end
  alias latest_installed_prefix prefix
  def latest_version_installed?; ENV["FIXTURE_INSTALLED"] == "true"; end
  def installed_kegs; latest_version_installed? ? [prefix] : []; end
  def path; prefix/".brew/#{name}.rb"; end
  def opt_prefix; prefix; end
  def post_install_defined?; false; end
  def post_install_steps_defined?; false; end
  def any_installed_keg; prefix; end
end
class Pathname
  def version; "1.0"; end
end
module Formulary
  def self.enable_factory_cache!; end
  def self.factory(name)
    @formulae ||= {}
    @formulae[name] ||= FixtureFormula.new(name, case name
      when "python" then [Dependency.new("expat", :macos), Dependency.new("openssl@4", :runtime), Dependency.new("pkgconf", :build), Dependency.new("incidental", :optional)]
      when "consumer" then [Dependency.new("python", :runtime)]
      else []
    end)
  end
end
class FormulaInstaller
  def initialize(formula); end
  def pour_bottle?; false; end
end
module Tab
  def self.for_keg(keg)
    Struct.new(:built_on, :used_options, :compiler, :runtime_dependencies).new(
      {"os_version" => "macOS #{ENV.fetch('FIXTURE_BUILT_ON', '14.8')}"}, self, "clang", [])
  end
  def self.as_flags; []; end
end
`);
  for (const name of ['consumer', 'python', 'expat', 'openssl@4', 'pkgconf', 'incidental']) {
    fs.mkdirSync(path.join(root, name, '.brew'), {recursive: true});
    fs.writeFileSync(path.join(root, name, '.brew', `${name}.rb`), '');
  }
  return (mode, approved = {}, env = {}) => {
    const result = spawnSync(process.env.PHP_DARWIN_RUBY || 'ruby', ['-I', root,
      path.resolve('scripts/cache/source-bottle-info.rb'), mode, '["consumer"]', 'false', JSON.stringify(approved)],
    {encoding: 'utf8', env: {...process.env, FIXTURE_ROOT: root, ...env}});
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
}

test('cold graphs and preparation retain declared system-library dependencies from the approved build platform', t => {
  const run = fixture(t);
  for (const mode of ['graph', 'seed', 'plan']) {
    for (const macos of ['14', '15']) {
      const records = run(mode, {python: {version: '1.0', macos}, consumer: '1.0'});
      assert.deepEqual(records.map(item => item.name), [...(macos === '14' ? ['expat'] : []), 'openssl@4', 'python', 'consumer']);
      const python = records.find(item => item.name === 'python');
      assert.deepEqual(python.runtime_formulae, [...(macos === '14' ? ['expat'] : []), 'openssl@4']);
      if (mode === 'graph') {
        assert.deepEqual(python.runtime_dependencies.map(dep => dep.name), python.runtime_formulae);
        assert.deepEqual(python.required_formulae, python.runtime_formulae);
        const packages = Object.fromEntries(records.map(item => [item.name, {version: item.version}]));
        packages.python.source = {inputs: {dependencies: [{name: 'expat'}, {name: 'openssl@4'}, {name: 'pkgconf'}]}};
        assert.deepEqual(resolvePlan(records, packages).workers, [], 'an approved compatible Python does not need rebuilding');
      }
    }
  }
  const rebuilt = run('graph', {consumer: '1.0'});
  assert.ok(rebuilt.some(item => item.name === 'pkgconf'));
  assert.ok(!rebuilt.some(item => item.name === 'expat'));
  const differentVersion = run('graph', {python: {version: '0.9', macos: '14'}, consumer: '1.0'});
  assert.ok(!differentVersion.some(item => item.name === 'expat'));
});

test('downstream archives use installed bottle provenance, without allowing incidental dependencies', t => {
  const run = fixture(t);
  for (const builtOn of ['14.8', '15.0']) {
    const [archive] = run('archive', {}, {FIXTURE_INSTALLED: 'true', FIXTURE_BUILT_ON: builtOn});
    assert.deepEqual(archive.packages.map(item => item.name),
      ['consumer', ...(builtOn === '14.8' ? ['expat'] : []), 'openssl@4', 'python']);
    assert.ok(!archive.packages.some(item => ['pkgconf', 'incidental'].includes(item.name)));
  }
});

test('approved source platforms are carried without changing the legacy version-only interface', () => {
  const packages = {python: {version: '1.0', source: {inputs: {environment: {macos: '14'}}}}, expat: {version: '2.8.5'}};
  assert.deepEqual(bottleVersions(packages), {python: '1.0', expat: '2.8.5'});
  assert.deepEqual(bottleVersions(packages, true), {python: {version: '1.0', macos: '14'}, expat: '2.8.5'});
});

test('native Homebrew resolves the retained macOS boundary from approval and install receipts',
  {skip: process.platform !== 'darwin'}, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-bottle-native-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const script = path.join(root, 'check.rb');
    fs.writeFileSync(path.join(root, 'INSTALL_RECEIPT.json'), JSON.stringify({
      built_on: {os: 'Macintosh', os_version: 'macOS 14.8'}, runtime_dependencies: [],
    }));
    fs.writeFileSync(script, `require "dependency/uses_from_macos_dependency"
require "tab"
require ${JSON.stringify(path.resolve('scripts/cache/source-bottle-runtime.rb'))}
formula = Struct.new(:full_name, :pkg_version, :latest_installed_prefix) do
  def latest_version_installed?; true; end
end.new("python", "1.0", Pathname.new(${JSON.stringify(root)}))
expat = UsesFromMacOSDependency.new("expat", bounds: {since: :sequoia})
old = SourceBottleRuntime.new({"python" => {"version" => "1.0", "macos" => "14"}})
current = SourceBottleRuntime.new({"python" => {"version" => "1.0", "macos" => "15"}})
installed = SourceBottleRuntime.new({}, installed: true)
raise "Lost approved expat" if old.from_macos?(formula, expat)
raise "Unnecessary system expat" unless current.from_macos?(formula, expat)
raise "Lost installed expat" if installed.from_macos?(formula, expat)
`);
    const result = spawnSync('brew', ['ruby', '--', script], {encoding: 'utf8',
      env: {...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ANALYTICS: '1'}});
    assert.equal(result.status, 0, result.stderr);
  });
