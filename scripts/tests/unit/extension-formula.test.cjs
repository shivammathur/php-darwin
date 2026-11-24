const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const patcher = path.join(root, 'scripts/build/extension-formula.rb');
const ruby = process.env.PHP_DARWIN_RUBY || 'ruby';
const template = `require "pathname"
class Extension
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
  def extension; ARGV[1]; end
  def formula_opt_bin(formula)
    Pathname.new(ENV.fetch("PHP_TEST_PREFIX")) / formula.split("/").last / "bin"
  end
  def inreplace(file, before, after)
    text = File.read(file)
    abort "Missing callback typedef" unless text.include?(before)
    File.write(file, text.sub(before, after))
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

test('PHP 5.6 ZTS RdKafka callbacks keep their thread-context argument', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rdkafka-zts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'abstract.rb');
  const header = path.join(directory, 'php_rdkafka_priv.h');
  const original = 'typedef void (*zend_object_free_obj_t)(zend_object *object);';
  for (const version of ['5.6', '7.0']) {
    for (const suffix of ['', '-debug', '-zts', '-debug-zts']) {
      for (const extension of ['rdkafka', 'redis']) {
        fs.writeFileSync(file, template);
        fs.writeFileSync(header, original);
        execFileSync(ruby, [patcher, file, `php@${version}${suffix}`, version + suffix, version]);
        execFileSync(ruby, [file, version, extension], {cwd: directory});
        assert.equal(fs.readFileSync(header, 'utf8'),
          version === '5.6' && suffix.endsWith('-zts') && extension === 'rdkafka'
            ? original.replace('*object);', '*object TSRMLS_DC);') : original);
      }
    }
  }
});

test('SSH2 uses the restored PHP 8.7 socket timeout globals only after the header move', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh2-globals-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'abstract.rb');
  const source = path.join(directory, 'ssh2.c');
  const original = '#include "php_ssh2.h"\nlong timeout = FG(default_socket_timeout);\n';
  const member = '\tzend_long default_socket_timeout;\n';
  for (const version of ['8.6', '8.7']) {
    for (const suffix of ['', '-debug', '-zts', '-debug-zts']) {
      const formula = `php@${version}${suffix}`;
      const include = path.join(directory, formula, 'include/php');
      fs.mkdirSync(path.join(include, 'main'), { recursive: true });
      fs.mkdirSync(path.join(include, 'ext/standard'), { recursive: true });
      for (const extension of ['ssh2', 'redis']) {
        for (const globals of ['file', 'core', 'both', 'neither']) {
          fs.writeFileSync(path.join(include, 'main/php_globals.h'), ['core', 'both'].includes(globals) ? member : '');
          fs.writeFileSync(path.join(include, 'ext/standard/file.h'), ['file', 'both'].includes(globals) ? member : '');
          for (const text of [original, original.replace('FG(', 'PG('), '#include "main/php_globals.h"\n' + original]) {
            fs.writeFileSync(file, template);
            fs.writeFileSync(source, text);
            execFileSync(ruby, [patcher, file, formula, version + suffix, version]);
            const run = () => execFileSync(ruby, [file, version, extension], {
              cwd: directory, env: { ...process.env, PHP_TEST_PREFIX: directory }, stdio: 'pipe',
            });
            run();
            let expected = text;
            if (version === '8.7' && extension === 'ssh2' && globals === 'core' && text.includes('FG(')) {
              expected = expected.replace('FG(default_socket_timeout)', 'PG(default_socket_timeout)');
              if (!expected.includes('#include "main/php_globals.h"')) {
                expected = expected.replace('#include "php_ssh2.h"', '#include "php_ssh2.h"\n#include "main/php_globals.h"');
              }
            }
            assert.equal(fs.readFileSync(source, 'utf8'), expected, `${formula} ${extension} ${globals}`);
            run();
            assert.equal(fs.readFileSync(source, 'utf8'), expected, 'Repeated safe_phpize is harmless');
          }
        }
      }
    }
  }
});

test('SSH2 refuses unexpected source layouts without writing a partial patch', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh2-source-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'abstract.rb');
  const source = path.join(directory, 'ssh2.c');
  const include = path.join(directory, 'php@8.7-debug-zts/include/php');
  fs.mkdirSync(path.join(include, 'main'), { recursive: true });
  fs.mkdirSync(path.join(include, 'ext/standard'), { recursive: true });
  fs.writeFileSync(path.join(include, 'main/php_globals.h'), 'zend_long default_socket_timeout;');
  fs.writeFileSync(path.join(include, 'ext/standard/file.h'), '');
  fs.writeFileSync(file, template);
  execFileSync(ruby, [patcher, file, 'php@8.7-debug-zts', '8.7-debug-zts', '8.7']);
  for (const text of [
    'long timeout = FG(default_socket_timeout);',
    '#include "php_ssh2.h"\nFG(default_socket_timeout); FG(default_socket_timeout);',
    '#include "php_ssh2.h"\n#include "php_ssh2.h"\nFG(default_socket_timeout);',
  ]) {
    fs.writeFileSync(source, text);
    assert.throws(() => execFileSync(ruby, [file, '8.7', 'ssh2'], {
      cwd: directory, env: { ...process.env, PHP_TEST_PREFIX: directory }, stdio: 'pipe',
    }), /Unexpected SSH2 socket timeout source/);
    assert.equal(fs.readFileSync(source, 'utf8'), text);
  }
  const missingMethod = template.replace('def safe_phpize', 'def renamed_phpize');
  fs.writeFileSync(file, missingMethod);
  assert.throws(() => execFileSync(ruby, [patcher, file, 'php@8.7', '8.7', '8.7'], { stdio: 'pipe' }), /Missing safe_phpize/);
  assert.equal(fs.readFileSync(file, 'utf8'), missingMethod);
});
