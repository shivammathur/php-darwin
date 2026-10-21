const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {digest} = require('../../installer/install-extensions.cjs');
const {recipeInputs} = require('../../lib/recipe-inputs.cjs');
const platforms = require('../../../conf/platforms.json');

test('accepted publications skip rebuilds until the permitted tap or dependency inputs change', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accepted-php-baseline-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const repository = path.resolve(__dirname, '../../..');
  for (const directory of ['scripts', 'conf']) fs.cpSync(path.join(repository, directory), path.join(root, directory), {recursive: true});
  const php = path.join(root, 'php'), extensions = path.join(root, 'extensions'), core = path.join(root, 'core');
  const bin = path.join(root, 'bin'), manifestFile = path.join(root, 'manifest.json'), log = path.join(root, 'dispatch.log');
  for (const directory of [path.join(php, 'Formula'), path.join(extensions, 'Formula'), path.join(extensions, 'Abstract'), path.join(core, 'Formula/d'), bin]) fs.mkdirSync(directory, {recursive: true});
  fs.writeFileSync(path.join(bin, 'gh'), '#!/usr/bin/env bash\n[ "$1" != api ] || exit 0\nprintf "%s\\n" "$*" >> "$DISPATCH_LOG"\n', {mode: 0o755});
  fs.writeFileSync(path.join(bin, 'curl'), '#!/usr/bin/env bash\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then destination=$2; shift 2; else shift; fi; done\ncp "$PHP_DARWIN_MANIFEST_PATH" "$destination"\nprintf 200\n', {mode: 0o755});
  fs.writeFileSync(path.join(extensions, 'Abstract/abstract-php-extension.rb'), 'shared source\n');
  const dependency = path.join(core, 'Formula/d/dependency.rb');
  const env = {...process.env, PATH: `${bin}:${process.env.PATH}`, HOMEBREW_PHP_PATH: php,
    HOMEBREW_EXTENSIONS_PATH: extensions, HOMEBREW_CORE_PATH: core, PHP_DARWIN_MANIFEST_PATH: manifestFile,
    GITHUB_REPOSITORY: 'shivammathur/php-darwin', GITHUB_REF_NAME: 'main', DISPATCH_LOG: log,
    CHANNEL: 'stable', PUBLISH: 'true', FORCE: 'false', GITHUB_OUTPUT: path.join(root, 'output')};
  const run = (file, args = []) => execFileSync('bash', [path.join(root, 'scripts', file), ...args], {env, encoding: 'utf8'}).trim();
  const variants = [['release', 'nts', ''], ['release', 'zts', '-zts'], ['debug', 'nts', '-debug'], ['debug', 'zts', '-debug-zts']];
  for (const version of ['8.1', '8.2']) {
    env.PHP_VERSION = version;
    env.ONLY_VERSION = version;
    fs.writeFileSync(dependency, 'dependency\n');
    for (const name of ['xdebug', 'pcov']) fs.writeFileSync(path.join(extensions, `Formula/${name}@${version}.rb`), `${name} source\n`);
    execFileSync('git', ['-C', extensions, 'init', '-q']);
    execFileSync('git', ['-C', extensions, 'add', '.']);
    execFileSync('git', ['-C', extensions, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', version]);
    const extensionCommit = execFileSync('git', ['-C', extensions, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
    const records = variants.map(([_build, _ts, suffix]) => {
      const relative = `Formula/php@${version}${suffix}.rb`;
      fs.writeFileSync(path.join(php, relative), 'published source\n');
      return {repository: 'shivammathur/homebrew-php', path: relative, sha256: digest('published source\n')};
    });
    const manifest = {schema: 1, php_version: version, php_semver: `${version}.1`, php_src_commit: '',
      homebrew_php_commit: 'f'.repeat(40), homebrew_extensions_commit: extensionCommit,
      source_hash: run('lib/source-hash.sh', [version]), extensions_source_hash: run('build/extensions-source-hash.sh', [version]),
      assets: variants.flatMap(([build, thread_safety], i) => Object.entries(platforms).map(([architecture, platform]) => ({
        architecture, build, thread_safety, minimum_macos: platform.minimum_macos, bytes: 1,
        name: `php_${version}-${thread_safety}-${build}+darwin_${architecture}.tar.zst`, sha256: '0'.repeat(64),
        build_inputs: {schema: 1, source_records: [records[i], {repository: 'Homebrew/homebrew-core', path: 'Formula/d/dependency.rb', sha256: digest('dependency\n')}]},
      })))};
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const accepted = records.map(record => {
      const file = path.join(php, record.path);
      fs.appendFileSync(file, 'accepted mirror and post-install changes\n');
      return {path: record.path, published_sha256: record.sha256, sha256: digest(fs.readFileSync(file)),
        inputs_schema: 1, inputs_mode: 'platforms', inputs_sha256: recipeInputs(file)};
    });
    fs.writeFileSync(path.join(root, 'conf/php-cache-baselines.json'), JSON.stringify({schema: 1, releases: {[version]: {
      php_semver: manifest.php_semver, homebrew_php_commit: manifest.homebrew_php_commit, source_hash: manifest.source_hash,
      tap_only_updates: version === '8.1', records: accepted,
    }}}));
    function check(required) {
      fs.writeFileSync(log, '');
      run('release/update.sh');
      assert.equal(Boolean(fs.readFileSync(log, 'utf8').trim()), required, `${version}: scheduled dispatch`);
      fs.writeFileSync(env.GITHUB_OUTPUT, '');
      run('build/check-build-freshness.sh');
      assert.match(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), new RegExp(`build-required=${required}`), `${version}: queued build`);
    }
    check(false);
    fs.appendFileSync(dependency, 'dependency update\n');
    fs.appendFileSync(path.join(extensions, `Formula/xdebug@${version}.rb`), 'extension update\n');
    check(version === '8.2');
    fs.appendFileSync(path.join(php, records[0].path), 'future tap source update\n');
    check(true);
  }
});
