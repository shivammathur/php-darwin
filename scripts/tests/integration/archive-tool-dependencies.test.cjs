const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

function fixture(t, modern) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-tool-dependencies-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const name of ['formula_installer', 'pkg_version']) fs.writeFileSync(path.join(root, `${name}.rb`), '');
  fs.writeFileSync(path.join(root, 'formulary.rb'), `require "pathname"
Dependency = Struct.new(:name, :kind) do
  def build?; kind == :build; end
  def test?; kind == :test; end
  def optional?; kind == :optional; end
  def uses_from_macos?; [:macos, :linux].include?(kind); end
  def use_macos_install?; kind == :macos; end
end
module Formulary
  def self.factory(reference)
    ${modern ? 'raise "Name-only factory must not receive a bottle"' : 'raise "Expected a bottle Pathname" unless reference.is_a?(Pathname); bottle(reference)'}
  end
  ${modern ? 'def self.from_bottle(reference); bottle(reference); end' : ''}
  def self.bottle(reference)
    raise "Wrong bottle path" unless reference.to_s == ENV.fetch("FIXTURE_BOTTLE")
    raise "Invalid bottle" if ENV["FIXTURE_LOAD_ERROR"] == "true"
    deps = [Dependency.new("lz4", :runtime), Dependency.new("xz", :recommended),
            Dependency.new("cmake", :build), Dependency.new("test-only", :test),
            Dependency.new("optional", :optional), Dependency.new("zlib", :macos),
            Dependency.new("linux-runtime", :linux)]
    Struct.new(:name, :pkg_version, :deps).new("zstd", "1.5.7_1", deps)
  end
end
`);
  const bottle = path.join(root, 'zstd--1.5.7_1.arm64_sonoma.bottle.tar.gz');
  const run = (name = 'zstd', version = '1.5.7_1', env = {}) => spawnSync(process.env.PHP_DARWIN_RUBY || 'ruby',
    ['-I', root, path.resolve('scripts/cache/brew-php-darwin-source.rb'), 'tool-dependencies', bottle, name, version],
    {encoding: 'utf8', env: {...process.env, FIXTURE_BOTTLE: bottle, ...env}});
  return {run};
}

for (const modern of [true, false]) {
  const loader = modern ? 'explicit bottle loader' : 'legacy factory';
  test(`archive-tool dependencies use the ${loader} and retain only runtime requirements`, t => {
    const {run} = fixture(t, modern);
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['lz4', 'xz', 'linux-runtime']);
  });

  test(`the ${loader} rejects mismatched formula identities including revisions`, t => {
    const {run} = fixture(t, modern);
    for (const identity of [['jq', '1.5.7_1'], ['zstd', '1.5.7']]) {
      const result = run(...identity);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Archive-tool formula identity differs/);
      assert.equal(result.stdout, '');
    }
  });

  test(`the ${loader} propagates bottle errors without selecting another recipe`, t => {
    const {run} = fixture(t, modern);
    const result = run('zstd', '1.5.7_1', {FIXTURE_LOAD_ERROR: 'true'});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid bottle/);
    assert.equal(result.stdout, '');
  });
}

for (const receipt of [false, true]) {
  test(`native Homebrew reads the bottled recipe ${receipt ? 'with' : 'without'} an install receipt`,
    {skip: process.platform !== 'darwin'}, t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-tool-native-'));
      t.after(() => fs.rmSync(root, {recursive: true, force: true}));
      const keg = path.join(root, 'zstd/1.5.7_1');
      fs.mkdirSync(path.join(keg, '.brew'), {recursive: true});
      // Deliberately differ from current core: only the authenticated bottle's
      // recipe may decide the bootstrap closure. No package is installed here.
      fs.writeFileSync(path.join(keg, '.brew/zstd.rb'), `class Zstd < Formula
  desc "Archive-tool dependency fixture"
  homepage "https://example.com"
  url "https://example.com/zstd-1.5.7.tar.gz"
  sha256 "${'a'.repeat(64)}"
  revision 1
  depends_on "fixture-build-tool" => :build
  depends_on "fixture-test-tool" => :test
  depends_on "fixture-optional" => :optional
  depends_on "fixture-runtime"
  depends_on "fixture-recommended" => :recommended
  uses_from_macos "zlib"
end
`);
      if (receipt) fs.writeFileSync(path.join(keg, 'INSTALL_RECEIPT.json'),
        JSON.stringify({source: {tap: 'homebrew/core'}, runtime_dependencies: []}));
      const bottle = path.join(root, 'zstd--1.5.7_1.arm64_sonoma.bottle.tar.gz');
      const packed = spawnSync('tar', ['-czf', bottle, '-C', root, 'zstd/1.5.7_1'], {encoding: 'utf8'});
      assert.equal(packed.status, 0, packed.stderr);
      const result = spawnSync('brew', ['php-darwin-source', 'tool-dependencies', bottle, 'zstd', '1.5.7_1'], {
        encoding: 'utf8', env: {...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ANALYTICS: '1',
          HOMEBREW_NO_INSTALL_FROM_API: '1', HOMEBREW_DEVELOPER: '1',
          PATH: `${path.resolve('scripts/cache')}${path.delimiter}${process.env.PATH}`},
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), ['fixture-runtime', 'fixture-recommended']);
    });
}
