const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');

test('the Homebrew source command independently enforces each architecture configuration', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-build-policy-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, 'scripts/cache'), {recursive: true});
  fs.mkdirSync(path.join(root, 'conf'));
  fs.copyFileSync('conf/package.json', path.join(root, 'conf/package.json'));
  fs.mkdirSync(path.join(root, 'stub/cmd'), {recursive: true});
  const script = path.join(root, 'scripts/cache/source-bottle-install.rb');
  fs.copyFileSync('scripts/cache/source-bottle-install.rb', script);
  fs.writeFileSync(path.join(root, 'stub/formula_installer.rb'),
    'module Hardware; module CPU; def self.arm?; ENV["FIXTURE_ARCH"] == "arm64"; end; end; end\n');
  fs.writeFileSync(path.join(root, 'stub/cmd/install.rb'), '');
  for (const arch of ['arm64', 'x86_64']) for (const enabled of [false, true]) {
    fs.writeFileSync(path.join(root, 'conf/platforms.json'), JSON.stringify({[arch]: {source_builds: enabled}}));
    const result = spawnSync(process.env.PHP_DARWIN_RUBY || 'ruby', ['-I', path.join(root, 'stub'), script], {
      encoding: 'utf8', env: {...process.env, FIXTURE_ARCH: arch},
    });
    // Enabled platforms reach argument validation; no actual build is invoked.
    assert.equal(result.status, 1);
    assert.match(result.stderr, enabled ? /Expected an explicitly planned source build/ : /source compilation is disabled by conf\/platforms.json/);
  }
  fs.copyFileSync('conf/platforms.json', path.join(root, 'conf/platforms.json'));
  for (const variant of ['release/nts', 'release/zts', 'debug/nts', 'debug/zts', 'invalid']) {
    for (const targets of [['shivammathur/extensions/imagick@8.5'], ['openssl@4'],
      ['shivammathur/php/php-zts@8.5'], ['other/extensions/imagick@8.5'],
      ['shivammathur/extensions/imagick@8.5', 'openssl@4']]) {
      const allowed = variant !== 'release/nts' && variant !== 'invalid' &&
        targets.length === 1 && targets[0] === 'shivammathur/extensions/imagick@8.5';
      const result = spawnSync(process.env.PHP_DARWIN_RUBY || 'ruby', ['-I', path.join(root, 'stub'), script, ...targets], {
        encoding: 'utf8', env: {...process.env, FIXTURE_ARCH: 'arm64', HOMEBREW_PHP_DARWIN_EXTENSION_VARIANT: variant},
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, allowed ? /Expected an explicitly planned source build/ : /source compilation is disabled/);
    }
  }
});

test('shell consumers read false and true source-build settings without losing false to jq exit status', () => {
  for (const [arch, expected] of [['arm64', 'false'], ['x86_64', 'true']]) {
    const result = spawnSync('bash', ['-c', '. scripts/lib/lib.sh; php_darwin_platform_value "$1" source_builds', 'fixture', arch], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected);
  }
});
