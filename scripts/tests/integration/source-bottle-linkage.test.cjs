const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

test('linkage entry point delegates unchanged arguments and status with receipt-aware declarations', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-bottle-linkage-command-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, 'dev-cmd'));
  fs.writeFileSync(path.join(root, 'tab.rb'), `module Tab
  def self.for_keg(keg)
    Struct.new(:built_on).new({"os_version" => "macOS #{ENV.fetch('BUILT_ON')}"})
  end
end
`);
  fs.writeFileSync(path.join(root, 'dev-cmd/linkage.rb'), `require "json"
class Dependencies < Array
  def initialize(*dependencies); super(dependencies); end
end
class Formula < Struct.new(:full_name)
  def latest_version_installed?; true; end
  def latest_installed_prefix; full_name; end
  def pkg_version; "1.0"; end
  def deps; []; end
  def declared_deps
    full_name == "python" ? [Dependency.new("expat")] : []
  end
end
class Dependency < Struct.new(:name)
  def uses_from_macos?; true; end
  def use_macos_install?(bottle_os_version: nil)
    (bottle_os_version || "macOS 15").delete_prefix("macOS ").to_i >= 15
  end
end
module Context
  def self.current=(value); end
end
module Homebrew; module DevCmd
  class Linkage
    def initialize(argv); @argv = argv; end
    def args; Struct.new(:context).new(nil); end
    def run
      puts JSON.generate({args: @argv, deps: Formula.new("python").deps.map(&:name)})
      exit Integer(ENV.fetch("LINKAGE_STATUS"))
    end
  end
end; end
`);
  for (const builtOn of ['14.8', '15.0']) for (const status of [0, 1]) {
    const args = ['--test', '--strict', 'python'];
    const result = spawnSync(process.env.PHP_DARWIN_RUBY || 'ruby', ['-I', root,
      path.resolve('scripts/cache/brew-php-darwin-source.rb'), 'linkage', ...args],
    {encoding: 'utf8', env: {...process.env, BUILT_ON: builtOn, LINKAGE_STATUS: String(status)}});
    assert.equal(result.status, status, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {args, deps: builtOn === '14.8' ? ['expat'] : []});
  }
});

// Minimal Mach-O headers exercise Homebrew's real file/linkage scanner without
// compiling or installing anything. These are parser fixtures, not executables.
function dylib(file, libraries, arm) {
  const commands = libraries.map(library => {
    const name = Buffer.from(library + '\0');
    const command = Buffer.alloc(Math.ceil((24 + name.length) / 8) * 8);
    command.writeUInt32LE(0xc, 0); // LC_LOAD_DYLIB
    command.writeUInt32LE(command.length, 4);
    command.writeUInt32LE(24, 8);
    name.copy(command, 24);
    return command;
  });
  const header = Buffer.alloc(32);
  [0xfeedfacf, arm ? 0x0100000c : 0x01000007, arm ? 0 : 3, 6,
    commands.length, commands.reduce((sum, command) => sum + command.length, 0), 0, 0]
    .forEach((value, index) => header.writeUInt32LE(value, index * 4));
  fs.writeFileSync(file, Buffer.concat([header, ...commands]));
}

test('native linkage keeps retained direct and transitive declarations without hiding broken libraries',
  {skip: process.platform !== 'darwin'}, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-bottle-linkage-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const prefix = fs.realpathSync(root), cellar = path.join(prefix, 'Cellar');
    const declarations = {
      'linkage-python': 'uses_from_macos "linkage-expat", since: :sequoia\n  depends_on "linkage-build" => :build\n  depends_on "linkage-test" => :test\n  depends_on "linkage-optional" => :optional',
      'linkage-consumer': 'depends_on "linkage-python"',
      'linkage-expat': 'uses_from_macos "linkage-leaf", since: :sequoia',
      'linkage-leaf': '', 'linkage-incidental': '', 'linkage-build': '', 'linkage-test': '', 'linkage-optional': '',
    };
    const keg = name => path.join(cellar, name, '1.0');
    const library = name => path.join(prefix, 'opt', name, 'lib/libfixture.dylib');
    fs.mkdirSync(path.join(prefix, 'opt'));
    for (const [name, deps] of Object.entries(declarations)) {
      fs.mkdirSync(path.join(keg(name), '.brew'), {recursive: true});
      fs.mkdirSync(path.join(keg(name), 'lib'));
      fs.symlinkSync(keg(name), path.join(prefix, 'opt', name));
      const className = name.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join('');
      fs.writeFileSync(path.join(keg(name), '.brew', `${name}.rb`), `class ${className} < Formula
  url "https://example.com/${name}-1.0.tar.gz"
  sha256 "${'a'.repeat(64)}"
  ${deps}
end
`);
    }
    const script = path.join(root, 'check.rb');
    fs.writeFileSync(script, `require "formulary"
require "formula_installer"
require "dev-cmd/linkage"
# Isolate native keg discovery and cache writes from the developer's Homebrew.
{HOMEBREW_PREFIX: ${JSON.stringify(prefix)}, HOMEBREW_CELLAR: ${JSON.stringify(cellar)},
 HOMEBREW_LINKED_KEGS: ${JSON.stringify(path.join(prefix, 'var/homebrew/linked'))}}.each do |name, value|
  Object.send(:remove_const, name)
  Object.const_set(name, Pathname.new(value))
end
native = ARGV.shift == "native"
Homebrew::SimulateSystem.with(os: ARGV.shift.to_sym, arch: ARGV.shift.to_sym) do
  fixtures = Dir[HOMEBREW_CELLAR/"*/1.0/.brew/*.rb"].to_h do |file|
    name = File.basename(file, ".rb")
    [name, Formulary.from_contents(name, Pathname.new(file), File.read(file))]
  end
  Formulary.define_singleton_method(:factory) { |name, *args, **kwargs| fixtures.fetch(name.to_s) }
  if native
    command = Homebrew::DevCmd::Linkage.new(ARGV)
    Context.current = command.args.context
    command.run
  else
    ARGV.unshift("linkage")
    load ${JSON.stringify(path.resolve('scripts/cache/brew-php-darwin-source.rb'))}
    python = fixtures.fetch("linkage-python")
    raise "Lost dependency selector" unless python.deps("linkage-expat").map(&:name) == python.deps(/^linkage-expat$/).map(&:name)
    runtime = fixtures.fetch("linkage-consumer").runtime_formula_dependencies(undeclared: false).map(&:name)
    puts "runtime: #{runtime.sort.join(',')}"
  end
end
exit(Homebrew.failed? ? 1 : 0)
`);
    const run = (native, host, arch, names = ['linkage-python', 'linkage-expat']) => spawnSync('brew',
      ['ruby', '--', script, native ? 'native' : 'wrapped', host, arch, '--test', '--strict', ...names],
      {encoding: 'utf8', env: {...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ANALYTICS: '1',
        HOMEBREW_NO_INSTALL_FROM_API: '1', HOMEBREW_CACHE: path.join(root, 'cache'), HOMEBREW_LOGS: path.join(root, 'logs')}});
    function fixtures(builtOn, arch, extra = [], missing = false) {
      fs.rmSync(path.join(root, 'cache'), {recursive: true, force: true});
      for (const name of Object.keys(declarations)) {
        fs.writeFileSync(path.join(keg(name), 'INSTALL_RECEIPT.json'), JSON.stringify({
          built_on: {os: 'Macintosh', os_version: `macOS ${builtOn}`},
          used_options: [], unused_options: ['--with-linkage-optional'],
          // Incidental entries must never become allowed declarations.
          runtime_dependencies: [{full_name: 'linkage-incidental', version: '1.0'}],
          source: {spec: 'stable', versions: {stable: '1.0', version_scheme: 0}},
        }));
        const links = name === 'linkage-python' ? [library('linkage-expat'), ...extra.map(library)] :
          name === 'linkage-expat' ? [library('linkage-leaf')] : [];
        dylib(path.join(keg(name), 'lib/libfixture.dylib'), links, arch === 'arm');
      }
      if (missing) fs.unlinkSync(path.join(keg('linkage-expat'), 'lib/libfixture.dylib'));
    }
    for (const arch of ['arm', 'intel']) {
      fixtures('14.8', arch);
      const native = run(true, 'sequoia', arch);
      assert.notEqual(native.status, 0, native.stdout + native.stderr);
      assert.match(native.stdout, /Undeclared dependencies with linkage/);
      for (const host of ['sonoma', 'sequoia']) {
        const result = run(false, host, arch);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /runtime: linkage-expat,linkage-leaf,linkage-python/);
      }
      fixtures('15.0', arch);
      const current = run(false, 'sequoia', arch);
      assert.notEqual(current.status, 0, current.stdout + current.stderr);
      assert.match(current.stdout, /Undeclared dependencies with linkage/);
      assert.match(current.stdout, /runtime: linkage-python/);
      for (const extra of ['linkage-incidental', 'linkage-build', 'linkage-test', 'linkage-optional']) {
        fixtures('14.8', arch, [extra]);
        const undeclared = run(false, 'sequoia', arch);
        assert.notEqual(undeclared.status, 0, undeclared.stdout + undeclared.stderr);
        assert.match(undeclared.stdout, new RegExp(`Undeclared dependencies with linkage:\\n  ${extra}`));
      }
      fixtures('14.8', arch, ['linkage-leaf']);
      const indirect = run(false, 'sequoia', arch);
      assert.notEqual(indirect.status, 0, indirect.stdout + indirect.stderr);
      assert.match(indirect.stdout, /Indirect dependencies with linkage:\n  linkage-leaf/);
      fixtures('14.8', arch, [], true);
      const missing = run(false, 'sequoia', arch);
      assert.notEqual(missing.status, 0, missing.stdout + missing.stderr);
      assert.match(missing.stdout, /Broken dependencies/);
    }
  });
