const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {ApprovedDependencies, validatePlatform} = require('../../cache/approved-dependencies.cjs');
const {roots, merge} = require('../../cache/update-dependencies.cjs');
const hash = data => createHash('sha256').update(data).digest('hex');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'approved-dependencies-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const bytes = Buffer.from('verified upstream bottle');
  const bottle = {formula: 'jq', version: '1.8.2', tag: 'all', sha256: hash(bytes),
    url: `https://ghcr.io/v2/homebrew/core/jq/blobs/sha256:${hash(bytes)}`};
  const platform = {macos: 14, prefix: '/opt/homebrew', packages: {jq: {version: '1.8.2', bottle}}};
  return {directory, bytes, bottle, platform};
}

test('approved upstream bottles use mirror bytes, retain dependency flags and reuse verified local files', async t => {
  const f = fixture(t), downloads = [], commands = [];
  const approved = new ApprovedDependencies({platforms: {arm64: f.platform}}, {
    download: async (url, file) => {downloads.push(url); fs.writeFileSync(file, f.bytes); return 200;},
  });
  const item = {full_name: 'jq', name: 'jq', version: '1.8.2'};
  approved.validatePlan([item], {arch: 'arm64', macos: '14', prefix: '/opt/homebrew'});
  const options = {flags: ['--as-dependency'], run: (...args) => commands.push(args)};
  for (let i = 0; i < 2; i++) {
    const bottles = await approved.prefetch([item], {cacheRoot: f.directory});
    assert.equal(approved.restore([item], {...options, bottles}), 0);
  }
  assert.equal(downloads.length, 1);
  assert.ok(downloads[0].startsWith('https://artifacts.php-darwin.setup-php.com/'));
  assert.equal(commands.length, 2);
  assert.ok(commands[0][1].includes('--as-dependency'));
  assert.ok(commands[0][1].includes('--force-bottle'));
});

test('missing or corrupt mirror data falls back to the exact approved upstream checksum', async t => {
  const f = fixture(t);
  for (const failure of ['missing', 'corrupt']) {
    const urls = [];
    const approved = new ApprovedDependencies({platforms: {arm64: f.platform}}, {
      download: async (url, file, options) => {
        urls.push(url);
        if (url === f.bottle.url) {assert.equal(options.upstream, true); fs.writeFileSync(file, f.bytes); return 200;}
        fs.writeFileSync(file, 'corrupt');
        return failure === 'missing' ? 404 : 200;
      },
    });
    const item = {full_name: 'jq', version: '1.8.2'};
    approved.validatePlan([item], {arch: 'arm64', macos: '14', prefix: '/opt/homebrew'});
    const bottles = await approved.prefetch([item], {cacheRoot: path.join(f.directory, failure)});
    approved.restore([item], {bottles, flags: [], run() {}});
    assert.equal(urls.length, 2);
    assert.equal(urls[1], f.bottle.url);
  }
});

test('missing approvals and newer patches fail before any dependency is installed', t => {
  const f = fixture(t), approved = new ApprovedDependencies({platforms: {arm64: f.platform}});
  const env = {arch: 'arm64', macos: '14', prefix: '/opt/homebrew'};
  assert.throws(() => approved.validatePlan([{full_name: 'gcc', version: '16.2.0'}], env), /not in the approved snapshot/);
  assert.throws(() => approved.validatePlan([{full_name: 'shivammathur/php/bison@2.7', version: '2.7.1'}], env), /not in the approved snapshot/);
  assert.throws(() => approved.validatePlan([{full_name: 'jq', version: '1.8.3', installed: true}], env), /not in the approved snapshot/);
  assert.throws(() => approved.validatePlan([], {...env, arch: 'x86_64'}), /not been prepared/);
  assert.throws(() => validatePlatform({...f.platform, packages: {jq: {version: '1.8.3', bottle: f.bottle}}}, 'arm64'), /identity differs/);
});

test('selective updates permit only requested source builds and new compatible bottles', t => {
  const f = fixture(t);
  const approved = new ApprovedDependencies({platforms: {arm64: f.platform}}, {updates: ['curl'], allowNewBottles: true});
  const env = {arch: 'arm64', macos: '14', prefix: '/opt/homebrew'};
  const plan = [{full_name: 'jq', version: '1.8.2'}, {full_name: 'curl', version: '8.22.0_1'},
    {full_name: 'docbook', version: '5.2.1', bottled: true}];
  approved.validatePlan(plan, env);
  assert.equal(approved.has(plan[0]), true);
  assert.equal(approved.has(plan[1]), false);
  assert.equal(approved.has(plan[2]), false);
  assert.throws(() => approved.validatePlan([...plan, {full_name: 'cmake', version: '4.4.4'}], env), /not in the approved snapshot/);
  assert.throws(() => approved.validatePlan([{full_name: 'jq', version: '1.8.3', bottled: true}], env), /not in the approved snapshot/);
  const bottleOnly = new ApprovedDependencies({platforms: {arm64: f.platform}}, {bottleUpdates: ['jq']});
  bottleOnly.validatePlan([{full_name: 'jq', version: '1.8.1', bottled: true}], env);
  assert.throws(() => bottleOnly.validatePlan([{full_name: 'jq', version: '1.8.1', bottled: false}], env), /not in the approved snapshot/);
});

test('a same-version selective rebuild retains its source build dependency traversal', t => {
  const f = fixture(t);
  const approved = new ApprovedDependencies({platforms: {arm64: f.platform}}, {updates: ['jq']});
  assert.deepEqual(approved.versions({arch: 'arm64', macos: '14', prefix: '/opt/homebrew'}), {});
  assert.equal(approved.has({full_name: 'jq', version: '1.8.2'}), false);
});

test('a newer preinstalled dependency is removed only after its approved replacement is verified', async t => {
  const f = fixture(t), commands = [];
  const approved = new ApprovedDependencies({platforms: {arm64: f.platform}}, {
    download: async (url, file) => {fs.writeFileSync(file, f.bytes); return 200;},
  });
  const item = {full_name: 'jq', version: '1.8.2', installed_versions: ['1.8.3']};
  approved.validatePlan([item], {arch: 'arm64', macos: '14', prefix: '/opt/homebrew'});
  const bottles = await approved.prefetch([item], {cacheRoot: f.directory});
  approved.restore([item], {bottles, flags: [], run: (program, args) => commands.push(args)});
  assert.deepEqual(commands[0], ['uninstall', '--formula', '--force', '--ignore-dependencies', 'jq']);
  assert.equal(commands[1][0], 'install');
  assert.ok(commands[1].includes('--force-bottle'));
});

test('upstream and source bottles download together with bounded concurrency and install in dependency order', async t => {
  const f = fixture(t), packages = {}, plan = [], commands = [];
  const {keyFor} = require('../../cache/source-bottle-cache.cjs');
  let active = 0, maximum = 0;
  const transfer = async callback => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    callback();
    active--;
  };
  for (let i = 0; i < 12; i++) {
    const formula = `dep-${i}`, version = '1.0';
    const inputs = {formula, version, environment: {arch: 'arm64', macos: '14', prefix: '/opt/homebrew'}};
    packages[formula] = i % 2 ? {version, source: {inputs, key: keyFor(inputs), sha256: hash(f.bytes)}} :
      {version, bottle: {...f.bottle, formula, version}};
    plan.push({full_name: formula, version});
  }
  const approved = new ApprovedDependencies({platforms: {arm64: {...f.platform, packages}}}, {
    download: async (_url, file) => {await transfer(() => fs.writeFileSync(file, f.bytes)); return 200;},
    recordInstalled(item, sha256) { assert.equal(sha256, packages[item.full_name].source.sha256); },
  });
  approved.validatePlan(plan, {arch: 'arm64', macos: '14', prefix: '/opt/homebrew'});
  const bottles = await approved.prefetch(plan, {cacheRoot: f.directory, cache: {
    async restoreCache([directory], key, _restoreKeys, inputs) {
      await transfer(() => {
        const file = `${inputs.formula}--1.0.arm64_sonoma.bottle.tar.gz`;
        fs.writeFileSync(path.join(directory, file), f.bytes);
        fs.writeFileSync(path.join(directory, 'metadata.json'), JSON.stringify({schema: 1, key, file, sha256: hash(f.bytes)}));
      });
      return key;
    },
  }});
  assert.equal(maximum, 8);
  assert.equal(approved.restore(plan, {bottles, flags: ['--ignore-dependencies', '--as-dependency'],
    run: (...args) => commands.push(args)}), 6);
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0][1].slice(5).map(file => path.basename(file).split('--')[0]), plan.map(item => item.full_name));
});

test('missing verified replacements prevent any prefix changes, including incomplete-keg repairs', t => {
  const f = fixture(t), approved = new ApprovedDependencies({platforms: {arm64: f.platform}});
  const item = {full_name: 'jq', version: '1.8.2', installed_versions: ['1.8.2'], missing_build_files: ['include/jq.h']};
  approved.validatePlan([item], {arch: 'arm64', macos: '14', prefix: '/opt/homebrew'});
  assert.throws(() => approved.restore([item], {bottles: new Map(), flags: [],
    run() {assert.fail('No package may be removed before all replacements are verified');}}), /Missing verified bottle/);
});

test('installed source dependencies require the approved bottle checksum even at the same version', t => {
  const f = fixture(t), {keyFor} = require('../../cache/source-bottle-cache.cjs');
  const env = {arch: 'arm64', macos: '14', prefix: '/opt/homebrew'};
  const inputs = {formula: 'net-snmp', version: '5.9.5.2_2', environment: env};
  const sha256 = hash(f.bytes);
  const approved = new ApprovedDependencies({platforms: {arm64: {...f.platform, packages: {
    'net-snmp': {version: inputs.version, source: {inputs, key: keyFor(inputs), sha256}},
  }}}});
  for (const installed_source_sha256 of [undefined, '0'.repeat(64), sha256]) {
    const item = {full_name: inputs.formula, version: inputs.version, installed: true, installed_source_sha256};
    approved.validatePlan([item], env);
    assert.equal(item.installed, installed_source_sha256 === sha256);
  }
  const item = {full_name: inputs.formula, version: inputs.version, prefix: f.directory};
  approved.restore([item], {bottles: new Map([[item.full_name, '/verified/bottle.tar.gz']]), flags: [], run() {}});
  assert.equal(fs.readFileSync(path.join(f.directory, '.php-darwin-source-sha256'), 'utf8'), sha256 + '\n');
});

test('dependency roots cover every PHP variant, coverage extension and optional-pack member', () => {
  const items = roots();
  assert.equal(items.length, new Set(items).size);
  for (const formula of ['jq', 'zstd', 'shivammathur/php/php@5.6-debug-zts', 'shivammathur/php/php@8.7',
    'shivammathur/extensions/xdebug@5.6', 'shivammathur/extensions/pcov@8.5',
    'shivammathur/extensions/igbinary@5.6', 'shivammathur/extensions/msgpack@8.7', 'shivammathur/extensions/imagick@8.5',
    'shivammathur/extensions/swoole@5.6', 'shivammathur/extensions/swoole@8.5']) {
    assert.ok(items.includes(formula), formula);
  }
  assert.ok(!items.includes('shivammathur/extensions/pcov@5.6'));
  for (const version of ['8.6', '8.7']) assert.ok(!items.includes(`shivammathur/extensions/swoole@${version}`));
});

test('promotion input requires matching native proofs and a common snapshot for both architectures', t => {
  const f = fixture(t), output = path.join(f.directory, 'merged.json');
  for (const arch of ['arm64', 'x86_64']) {
    const candidate = {schema: 1, core_commit: 'a'.repeat(40), platforms: {
      [arch]: {...f.platform, macos: arch === 'arm64' ? 14 : 15, prefix: arch === 'arm64' ? '/opt/homebrew' : '/usr/local'},
    }};
    const data = JSON.stringify(candidate);
    fs.writeFileSync(path.join(f.directory, `dependencies-${arch}.json`), data);
    fs.writeFileSync(path.join(f.directory, `dependency-verification-${arch}.json`), JSON.stringify({
      schema: 1, arch, core_commit: candidate.core_commit, sha256: hash(data), dependencies: 1,
      cold_source_builds: 0, hot_source_builds: 0,
    }));
  }
  merge(f.directory, output);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(output)).platforms), ['arm64', 'x86_64']);
  const file = path.join(f.directory, 'dependencies-x86_64.json');
  const candidate = JSON.parse(fs.readFileSync(file));
  candidate.recipe_commits = {curl: 'b'.repeat(40)};
  fs.writeFileSync(file, JSON.stringify(candidate));
  const proofFile = path.join(f.directory, 'dependency-verification-x86_64.json');
  const proof = JSON.parse(fs.readFileSync(proofFile));
  proof.sha256 = hash(fs.readFileSync(file));
  fs.writeFileSync(proofFile, JSON.stringify(proof));
  assert.throws(() => merge(f.directory, output), /recipes differ across architectures/);
  fs.appendFileSync(file, '\n');
  assert.throws(() => merge(f.directory, output), /mismatched native/);
});

test('extension jobs cannot implicitly compile a missing PHP build tool', t => {
  const f = fixture(t), approved = new ApprovedDependencies({platforms: {arm64: f.platform}});
  const php = {full_name: 'shivammathur/php/php@8.4', version: '8.4.26', installed: false};
  const environment = {arch: 'arm64', macos: 14, prefix: '/opt/homebrew'};
  assert.throws(() => approved.validatePlan([php], environment, {targets: ['shivammathur/extensions/imagick@8.4']}), /Published PHP build tool/);
  approved.validatePlan([{...php, installed: true}], environment, {targets: ['shivammathur/extensions/imagick@8.4']});
  approved.validatePlan([php], environment, {targets: [php.full_name]});
});
