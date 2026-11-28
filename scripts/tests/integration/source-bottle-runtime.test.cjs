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
  def dup_with_formula_name(formula); self.class.new(formula.name, kind); end
  def self.merge_repeats(deps); deps.uniq(&:name); end
  def self.expand(formula, &block)
    formula.deps.flat_map do |dep|
      decision = block.call(formula, dep)
      next [] if decision == Dependable::PRUNE
      (decision == Dependable::KEEP_BUT_PRUNE_RECURSIVE_DEPS ? [] : expand(dep.to_formula, &block)) + [dep]
    end.uniq(&:name)
  end
end
class FixtureFormula < Struct.new(:name, :declared_deps)
  # Match Homebrew: host-provided libraries disappear before expand is called.
  def deps; declared_deps.reject { |dep| dep.uses_from_macos? && dep.use_macos_install? }; end
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
  return (mode, approved = {}, env = {}, {preload, baseline} = {}) => {
    const result = spawnSync(process.env.PHP_DARWIN_RUBY || 'ruby', ['-I', root,
      ...(preload ? ['-r', preload] : []), path.resolve('scripts/cache/source-bottle-info.rb'),
      mode, '["consumer"]', 'false', JSON.stringify(approved), ...(baseline ? [JSON.stringify(baseline)] : [])],
    {encoding: 'utf8', env: {...process.env, FIXTURE_ROOT: root, ...env}});
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
}

test('discovery retries manifest transfers and propagates exhausted downloads and invalid receipts', t => {
  const run = fixture(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bottle-manifest-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const preload = path.join(root, 'bottle.rb');
  const attempts = path.join(root, 'attempts');
  fs.writeFileSync(preload, `require "formulary"
class DownloadError < RuntimeError; end
class FormulaInstaller
  def initialize(formula); @formula = formula; end
  def pour_bottle?; @formula.name == "consumer"; end
  def selected_bottle; self; end
  def tag; "sequoia"; end
  def resource; self; end
  def checksum; self; end
  def hexdigest; "a" * 64; end
  def url; "https://example.invalid/bottle"; end
  def cached_download; "/tmp/bottle"; end
  def fetch_tab(quiet:)
    raise "expected quiet transfer" unless quiet
    File.open(ENV.fetch("ATTEMPTS"), "a") { |file| file.puts("fetch") }
    @calls = (@calls || 0) + 1
    raise DownloadError, "curl: (35) timed out" if @calls <= Integer(ENV.fetch("FAILURES"))
  end
  def tab_attributes
    {"runtime_dependencies" => ENV["INVALID"] == "true" ? nil : []}
  end
end
def sleep(_seconds); end
`);
  function discover(failures, invalid = false) {
    fs.writeFileSync(attempts, '');
    return run('graph', {}, {ATTEMPTS: attempts, FAILURES: String(failures), INVALID: String(invalid)},
      {preload, baseline: {}});
  }
  const count = () => fs.readFileSync(attempts, 'utf8').trim().split('\n').length;
  assert.deepEqual(discover(2).at(-1).bottle_requirement_updates, []);
  assert.equal(count(), 3);
  assert.throws(() => discover(3), /curl: \(35\) timed out/);
  assert.equal(count(), 3);
  assert.throws(() => discover(0, true), /Invalid bottle dependency metadata/);
  assert.equal(count(), 1);
});

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

test('native Homebrew resolves the complete declared graph after host-filtered queries',
  {skip: process.platform !== 'darwin'}, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-bottle-native-graph-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const script = path.join(root, 'graph.rb');
    const declarations = {
      'runtime-consumer': 'depends_on "runtime-python"',
      'runtime-python': 'uses_from_macos "expat", since: :sequoia\n  depends_on "openssl@4"\n  depends_on "runtime-build-tool" => :build\n  depends_on "runtime-optional" => :optional',
      expat: 'depends_on "runtime-leaf"',
      'openssl@4': 'depends_on "runtime-leaf"',
      'runtime-leaf': '',
      'runtime-build-tool': '',
      'runtime-cycle-a': 'depends_on "runtime-cycle-b"',
      'runtime-cycle-b': 'depends_on "runtime-cycle-a"\n  depends_on "runtime-leaf"',
      'runtime-merged': 'depends_on "runtime-alias"\n  depends_on "runtime-leaf" => :build',
    };
    for (const [name, deps] of Object.entries(declarations)) {
      const className = name.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join('').replace('@', 'AT');
      fs.writeFileSync(path.join(root, `${name}.rb`), `class ${className} < Formula
  url "https://example.com/${name}-1.0.tar.gz"
  sha256 "${'a'.repeat(64)}"
  ${deps}
end
`);
    }
    fs.writeFileSync(script, `require "formulary"
require "formula_installer"
Homebrew::SimulateSystem.with(os: :sequoia, arch: ARGV.shift.to_sym) do
  fixtures = Dir[${JSON.stringify(path.join(root, '*.rb'))}].reject { |file| file.end_with?("/graph.rb") }.to_h do |file|
    name = File.basename(file, ".rb")
    [name, Formulary.from_contents(name, Pathname.new(file), File.read(file))]
  end
  fixtures["runtime-alias"] = fixtures.fetch("runtime-leaf")
  Formulary.define_singleton_method(:factory) { |name, *args, **kwargs| fixtures.fetch(name) }
  require ${JSON.stringify(path.resolve('scripts/cache/source-bottle-runtime.rb'))}
  # Preserve Homebrew semantics for diamonds, aliases, cycles and merged tags.
  runtime = SourceBottleRuntime.new
  %w[runtime-cycle-a runtime-merged].each do |name|
    expected = Dependency.expand(fixtures.fetch(name)) { |_, _| nil }
    actual = runtime.expand(fixtures.fetch(name)) { |_, _| nil }
    raise "Traversal differs for #{name}" unless actual == expected
  end
  # Formula#deps and Dependency.expand prune expat for this newer host before
  # the old bottle's platform can be considered. Exercise both first, as the
  # installer and other graph queries do, without changing the formula object.
  python = fixtures.fetch("runtime-python")
  raise "Fixture did not reproduce host filtering" if python.deps.any? { |dep| dep.name == "expat" }
  raise "Fixture declaration disappeared" unless python.declared_deps.any? { |dep| dep.name == "expat" }
  Dependency.expand(fixtures.fetch("runtime-consumer"), cache_key: "host-filtered") do |_, dep|
    Dependable::PRUNE if dep.build? || dep.optional?
  end
  load ${JSON.stringify(path.resolve('scripts/cache/source-bottle-info.rb'))}
end
`);
    for (const arch of ['arm', 'intel']) for (const mode of ['graph', 'seed', 'plan']) for (const macos of ['14', '15']) {
      const approved = {'runtime-consumer': '1.0', 'runtime-python': {version: '1.0', macos}};
      const result = spawnSync('brew', ['ruby', '--', script, arch, mode, '["runtime-consumer"]', 'false', JSON.stringify(approved)], {
        encoding: 'utf8', env: {...process.env,
          HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ANALYTICS: '1', HOMEBREW_NO_INSTALL_FROM_API: '1'},
      });
      assert.equal(result.status, 0, result.stderr);
      const records = JSON.parse(result.stdout), python = records.find(item => item.name === 'runtime-python');
      assert.deepEqual(records.map(item => item.name), ['runtime-leaf', ...(macos === '14' ? ['expat'] : []), 'openssl@4', 'runtime-python', 'runtime-consumer']);
      assert.deepEqual(python.runtime_formulae, [...(macos === '14' ? ['expat'] : []), 'openssl@4', 'runtime-leaf']);
      if (mode === 'graph') assert.deepEqual(python.runtime_dependencies.map(dep => dep.name),
        [...(macos === '14' ? ['expat'] : []), 'openssl@4']);
    }
  });
