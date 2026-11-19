const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {prepare} = require('../../build/prepare-homebrew-prefix.cjs');

const directory = '/usr/local/libexec';
const absent = () => Object.assign(new Error('missing directory'), {code: 'ENOENT'});
const isDirectory = () => true;

function fixture(extra = {}) {
  const state = {exists: false, writable: false}, calls = [];
  const options = {platform: 'darwin', arch: 'x64', env: {GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted'}, uid: 501, gid: 20,
    files: {
      lstatSync(file) {
        if (file === '/usr/local') return {isDirectory};
        assert.equal(file, directory);
        if (!state.exists) throw absent();
        return {isDirectory};
      },
      accessSync(file, mode) {
        assert.equal(file, directory);
        assert.equal(mode, fs.constants.W_OK);
        if (!state.writable) throw Object.assign(new Error('permission denied'), {code: 'EACCES'});
      },
    },
    run(program, args) {
      calls.push([program, args]);
      if (program === 'brew') {assert.deepEqual(args, ['--prefix']); return '/usr/local\n';}
      assert.equal(program, '/usr/bin/sudo');
      if (args[1] === '/bin/mkdir') {
        assert.deepEqual(args, ['-n', '/bin/mkdir', '-m', '0755', directory]);
        assert.equal(state.exists, false);
        state.exists = true;
      } else {
        assert.deepEqual(args, ['-n', '/usr/sbin/chown', '-h', '501:20', directory]);
        assert.equal(state.exists, true);
        state.writable = true;
      }
      return '';
    }, log: () => {}, ...extra};
  return {options, state, calls};
}

test('cold Intel preflight creates only the missing post-install directory; warm reuse never changes ownership', () => {
  const f = fixture();
  // Homebrew's new unconditional mkpath fails with the runner's root-owned
  // /usr/local; the prepared directory makes that post-install setup a no-op.
  const postinstall = () => {if (!f.state.exists) throw new Error('Permission denied @ dir_s_mkdir - /usr/local/libexec');};
  assert.throws(postinstall, /Permission denied/);
  assert.equal(prepare(f.options), true);
  assert.doesNotThrow(postinstall);
  assert.equal(f.calls.length, 3);
  f.calls.length = 0;
  assert.equal(prepare(f.options), false);
  assert.deepEqual(f.calls, [['brew', ['--prefix']]]);
});

test('preflight never inspects or mutates non-CI Macs, self-hosted runners, ARM or non-macOS hosts', () => {
  for (const extra of [{env: {}}, {env: {GITHUB_ACTIONS: 'false'}},
    {env: {GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted'}}, {env: {GITHUB_ACTIONS: 'true'}},
    {arch: 'arm64'}, {platform: 'linux'}]) {
    const f = fixture({...extra, run: () => assert.fail('must not run a command'),
      files: {lstatSync: () => assert.fail('must not inspect the prefix')}});
    assert.equal(prepare(f.options), false);
  }
  const f = fixture({run: (program, args) => {assert.equal(program, 'brew'); assert.deepEqual(args, ['--prefix']); return '/custom/homebrew';}});
  assert.equal(prepare(f.options), false);
  assert.equal(f.state.exists, false);
});

test('preflight preserves existing directories and rejects files, symlinks or inaccessible paths without repair', () => {
  const f = fixture();
  f.state.exists = true;
  assert.throws(() => prepare(f.options), /permission denied/);
  assert.equal(f.calls.length, 1);
  for (const unsafe of ['/usr/local', directory]) {
    const f = fixture();
    const original = f.options.files.lstatSync;
    f.options.files.lstatSync = file => file === unsafe ? {isDirectory: () => false} : original(file);
    assert.throws(() => prepare(f.options), /real directory/);
    assert.equal(f.calls.length, 1);
  }
  const blocked = fixture();
  blocked.options.files.lstatSync = () => {throw Object.assign(new Error('cannot inspect'), {code: 'EACCES'});};
  assert.throws(() => prepare(blocked.options), /cannot inspect/);
  assert.equal(blocked.calls.length, 1);
});

test('invalid owners and failed or racing creation never change existing ownership', () => {
  for (const extra of [{uid: 0}, {uid: undefined}, {uid: -1}, {gid: -1}]) {
    const f = fixture(extra);
    // Explicit null models an unavailable POSIX uid without applying defaults.
    if (extra.uid === undefined) f.options.uid = null;
    assert.throws(() => prepare(f.options), /runner owner/);
    assert.equal(f.calls.length, 1);
  }
  for (const message of ['sudo denied', 'File exists']) {
    const f = fixture(), original = f.options.run;
    f.options.run = (program, args) => {
      if (program === 'brew') return original(program, args);
      assert.equal(args[1], '/bin/mkdir');
      throw new Error(message);
    };
    assert.throws(() => prepare(f.options), new RegExp(message));
    assert.equal(f.state.writable, false);
  }
});

test('failed ownership or final validation stops preflight rather than hiding the post-install error', () => {
  for (const stage of ['ownership', 'validation']) {
    const f = fixture(), original = f.options.run;
    f.options.run = (program, args) => {
      if (args[1] === '/usr/sbin/chown') {
        if (stage === 'ownership') throw new Error('ownership denied');
        return '';
      }
      return original(program, args);
    };
    assert.throws(() => prepare(f.options), stage === 'ownership' ? /ownership denied/ : /permission denied/);
  }
});

test('the action prepares the prefix after recovery and propagates provisioning failures', async () => {
  const source = fs.readFileSync(require('node:path').resolve(__dirname, '../../../.github/actions/runner-preflight/main.cjs'), 'utf8');
  for (const recoveryFails of [false, true]) for (const prepareFails of [false, true]) {
    const calls = [], errors = [], process = {};
    await require('node:vm').runInNewContext(source, {
      process, console: {warn() {}, error: message => errors.push(message)},
      require(file) {
        if (file.endsWith('/recover-runner.cjs')) return {recover: async () => {
          calls.push('recovery');
          if (recoveryFails) throw new Error('inspection unavailable');
        }};
        assert.ok(file.endsWith('/prepare-homebrew-prefix.cjs'));
        return {prepare() {calls.push('prefix'); if (prepareFails) throw new Error('prefix unavailable');}};
      },
    });
    assert.deepEqual(calls, ['recovery', 'prefix']);
    assert.equal(process.exitCode, prepareFails ? 1 : undefined);
    assert.deepEqual(errors, prepareFails ? ['Runner preflight: prefix unavailable'] : []);
  }
});
