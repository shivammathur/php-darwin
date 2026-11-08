const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');

test('source compiler environments keep declared OpenSSL and ICU ahead of transitive majors', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-library-paths-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, 'extend/ENV'), {recursive: true});
  fs.writeFileSync(path.join(root, 'global.rb'), 'require "pathname"\n');
  for (const [file, module] of [['super', 'Superenv'], ['std', 'Stdenv']]) {
    fs.writeFileSync(path.join(root, `extend/ENV/${file}.rb`), `module ${module}; def setup_build_environment(**options); end; end\n`);
  }
  const script = path.join(root, 'check.rb');
  fs.writeFileSync(script, `require ${JSON.stringify(path.resolve('scripts/cache/source-bottle-openssl.rb'))}
class Fixture < Hash
  include(ENV.fetch("FIXTURE_MODE") == "super" ? Superenv : Stdenv)
  def prepend_path(name, value)
    self[name] = [value, self[name]].compact.join(File::PATH_SEPARATOR)
  end
  def prepend(name, value)
    self[name] = [value, self[name]].compact.join(" ")
  end
end
env = Fixture.new
env["HOMEBREW_ENV"] = ENV.fetch("FIXTURE_MODE")
env["PKG_CONFIG_PATH"] = "/opt/homebrew/opt/icu4c@79/lib/pkgconfig"
env["HOMEBREW_PHP_DARWIN_PKG_CONFIG_PATH"] = ENV.fetch("FIXTURE_PATHS")
env["HOMEBREW_PHP_DARWIN_CONFIGURE_CACHE"] = '{"ac_cv_fixture":"yes"}'
env.setup_build_environment
puts JSON.generate(env)
`);
  const ssl = '/opt/homebrew/opt/openssl@4', icu = '/opt/homebrew/opt/icu4c@78';
  for (const mode of ['super', 'std']) for (const prefixes of [[ssl], [ssl, icu], [icu]]) {
    const directories = prefixes.map(prefix => `${prefix}/lib/pkgconfig`);
    const result = spawnSync(process.env.PHP_DARWIN_RUBY || 'ruby', ['-I', root, script], {
      encoding: 'utf8', env: {...process.env, FIXTURE_MODE: mode, FIXTURE_PATHS: directories.join(':')},
    });
    assert.equal(result.status, 0, result.stderr);
    const env = JSON.parse(result.stdout);
    assert.equal(env.PKG_CONFIG_PATH, [...directories, '/opt/homebrew/opt/icu4c@79/lib/pkgconfig'].join(':'));
    assert.equal(env.CMAKE_PREFIX_PATH, prefixes.join(':'));
    assert.equal(env.ac_cv_fixture, 'yes');
    if (mode === 'super') {
      assert.equal(env.HOMEBREW_INCLUDE_PATHS, prefixes.map(prefix => `${prefix}/include`).join(':'));
      assert.equal(env.HOMEBREW_LIBRARY_PATHS, prefixes.map(prefix => `${prefix}/lib`).join(':'));
    } else {
      assert.equal(env.CPPFLAGS, prefixes.map(prefix => `-I${prefix}/include`).join(' '));
      assert.equal(env.LDFLAGS, prefixes.map(prefix => `-L${prefix}/lib`).join(' '));
    }
  }
});

test('the source build environment selects declared ICU despite an inherited newer major', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-pkgconfig-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const major of [78, 79]) {
    const directory = path.join(root, `icu${major}/lib/pkgconfig`);
    fs.mkdirSync(directory, {recursive: true});
    fs.writeFileSync(path.join(directory, 'fixture-icu.pc'), `Name: Fixture ICU
Description: Declared versus transitive ICU selection
Version: ${major}.1
Libs: -L${directory} -licui18n
Cflags: -I${directory}
`);
  }
  fs.mkdirSync(path.join(root, 'scripts/cache'), {recursive: true});
  fs.mkdirSync(path.join(root, 'conf'));
  fs.mkdirSync(path.join(root, 'stub/cmd'), {recursive: true});
  for (const file of ['platforms.json', 'package.json']) fs.copyFileSync(`conf/${file}`, path.join(root, 'conf', file));
  const wrapper = path.join(root, 'scripts/cache/source-bottle-install.rb');
  fs.copyFileSync('scripts/cache/source-bottle-install.rb', wrapper);
  fs.copyFileSync('scripts/cache/source-bottle-openssl.rb', path.join(root, 'scripts/cache/source-bottle-openssl.rb'));
  fs.mkdirSync(path.join(root, 'stub/extend/ENV'), {recursive: true});
  fs.writeFileSync(path.join(root, 'stub/global.rb'), 'require "pathname"\n');
  for (const [file, module] of [['super', 'Superenv'], ['std', 'Stdenv']]) {
    fs.writeFileSync(path.join(root, `stub/extend/ENV/${file}.rb`), `module ${module}; def setup_build_environment(**options); end; end\n`);
  }
  fs.writeFileSync(path.join(root, 'stub/formula_installer.rb'), `module Hardware; module CPU; def self.arm?; false; end; end; end
class FormulaInstaller; end
module Context; def self.current=(value); end; end
`);
  fs.writeFileSync(path.join(root, 'stub/cmd/install.rb'), `module Homebrew; module Cmd
class InstallCmd
  def initialize(argv); end
  def args; Struct.new(:context).new(nil); end
  def run
    require ${JSON.stringify(path.join(root, 'scripts/cache/source-bottle-openssl.rb'))}
    # Homebrew invokes the preloaded hook in its separate build process.
    env = ENV.to_h
    env.extend(Superenv)
    def env.prepend_path(name, value); self[name] = [value, self[name]].compact.join(File::PATH_SEPARATOR); end
    def env.prepend(name, value); self[name] = [value, self[name]].compact.join(" "); end
    env.setup_build_environment
    puts JSON.generate(env.slice("PKG_CONFIG", "PKG_CONFIG_PATH"))
  end
end
end; end
`);
  const configured = spawnSync(process.env.PHP_DARWIN_RUBY || 'ruby', ['-I', path.join(root, 'stub'), wrapper,
    '--formula', '--ignore-dependencies', '--build-bottle', 'shivammathur/php/php@7.4'], {
    encoding: 'utf8', env: {...process.env,
      HOMEBREW_PHP_DARWIN_PKG_CONFIG_PATH: `${root}/openssl/lib/pkgconfig:${root}/icu78/lib/pkgconfig`,
      PKG_CONFIG_PATH: `${root}/icu79/lib/pkgconfig`, HOMEBREW_ENV: 'super'},
  });
  assert.equal(configured.status, 0, configured.stderr);
  const environment = JSON.parse(configured.stdout);
  const [program, ...args] = environment.PKG_CONFIG.split(' ');
  const result = spawnSync(program, [...args, '--modversion', 'fixture-icu'], {
    encoding: 'utf8', env: {...process.env, ...environment},
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '78.1');
});
