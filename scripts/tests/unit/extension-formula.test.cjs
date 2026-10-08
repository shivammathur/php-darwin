const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const patcher = path.join(root, 'scripts/build/extension-formula.rb');
const ruby = process.env.PHP_DARWIN_RUBY || 'ruby';
const template = `class Extension
  def self.depends_on(formula, *); (@dependencies ||= []).concat(formula.keys); end
  def self.init(version)
    @php_version = version
    @extension = ARGV[1]
    depends_on "shivammathur/php/php@#{@php_version}" => [:build, :test]
  end
  def php_formula
    "shivammathur/php/php@#{php_version}"
  end
  def config_scandir_path
    etc / "php" / php_version / "conf.d"
  end
  def safe_phpize
    puts ENV["ac_cv_prog_cc_c23"] || "default"
  end
  def self.dependency; @dependencies.first; end
  def self.pcre2?; @dependencies.include?("pcre2"); end
end
Extension.init(ARGV[0])
puts Extension.new.php_formula
puts Extension.dependency
Extension.new.safe_phpize
puts Extension.pcre2?
`;

test('extension builds resolve the actual PHP formula for current, versioned and nightly variants', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-formula-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'abstract.rb');
  const current = require('../../../conf/package.json').current_version;
  for (const version of require('../../../conf/extension-packs.json').versions) {
    for (const suffix of ['', '-debug', '-zts', '-debug-zts']) {
      const formula = (version === current ? 'php' : `php@${version}`) + suffix;
      fs.writeFileSync(file, template);
      execFileSync(ruby, [patcher, file, formula, version + suffix, version], { stdio: 'pipe' });
      const output = execFileSync(ruby, [file, version], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ac_cv_prog_cc_c23: '' } }).trim().split('\n');
      assert.deepEqual(output.slice(0, 2), Array(2).fill('shivammathur/php/' + formula));
      assert.equal(output[2] || '', /^(5|7)\./.test(version) ? 'no' : '');
      assert.equal(output[3], 'false', 'Unrelated extensions do not gain a PCRE2 build dependency');
      assert.ok(fs.readFileSync(file, 'utf8').includes(`etc / "php" / "${version + suffix}" / "conf.d"`));
    }
  }
  fs.writeFileSync(file, 'changed upstream template');
  assert.throws(() => execFileSync('ruby', [patcher, file, 'php', current, current], { stdio: 'pipe' }));
  assert.equal(fs.readFileSync(file, 'utf8'), 'changed upstream template');
});

test('Swoole declares PCRE2 headers for supported PHP versions including debug builds', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swoole-pcre2-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'abstract.rb');
  for (const version of ['5.6', '7.2', '7.3', '8.1', '8.5']) {
    const formula = (version === '8.5' ? 'php' : `php@${version}`) + '-debug-zts';
    fs.writeFileSync(file, template);
    execFileSync(ruby, [patcher, file, formula, version + '-debug-zts', version], { stdio: 'pipe' });
    const output = execFileSync(ruby, [file, version, 'swoole'], { encoding: 'utf8', stdio: 'pipe' }).trim().split('\n');
    assert.equal(output.at(-1), ['5.6', '7.2'].includes(version) ? 'false' : 'true');
    assert.deepEqual(output.slice(0, 2), Array(2).fill('shivammathur/php/' + formula));
  }
});
